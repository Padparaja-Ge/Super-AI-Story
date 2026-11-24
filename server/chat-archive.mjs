import {archiveMemoryEnabled,archiveMemoryVersion,recallArchive} from './archive-recall.mjs';
import {validMemory} from './memory.mjs';

const confirmedMessage = message => ['assistant', 'user'].includes(message.role) &&
  !['image', 'dice'].includes(message.kind) && !message.interrupted &&
  message.continuationStatus !== 'incomplete' && message.content?.trim();

export function archiveEncoder(state, embeddings) {
  const selected = state.settings?.embeddings?.connectionId;
  if (!selected || typeof embeddings?.vectors !== 'function') return undefined;
  const connection = state.connections?.find(item => item.id === selected);
  if (!connection?.baseUrl || !(state.settings?.embeddings?.model || connection.model)) return undefined;
  return (texts, signal) => embeddings.vectors(state, texts, signal);
}

export async function recallChatArchive(state, chat, content, signal, embeddings) {
  const settings = { ...state.settings, ...chat.memorySettings };
  const mode = settings.memoryMode || 'hybrid';
  if (!archiveMemoryEnabled(settings) || !['hybrid', 'full'].includes(mode) || Number(settings.memoryBudget) === 0) return null;
  const version=archiveMemoryVersion(settings);
  const messages = (chat.messages || []).filter(confirmedMessage);
  const generationHistoryLimit = Math.max(0, Math.min(4, Math.floor(Number(settings.historyLimit ?? 30)) || 0));
  // Keep this conservative: a long recent post may itself be compressed for a
  // tiny model window. It is still searchable even if not a coverage signal.
  const recent = generationHistoryLimit ? messages.slice(-generationHistoryLimit) : [];
  const forecast = Math.max(100, Math.min(700, Math.floor(((state.connections?.find(c=>c.id===(chat.connectionId||state.activeConnectionId))?.contextWindow || 8192) - 512) * .17)));
  const recentEvidence = recent.filter(m => (m.role === 'assistant' || m.kind === 'engine') && m.content.length <= forecast).map(m => m.content);
  const memory=validMemory(chat);
  const memoryEvidenceBudget=Math.min(900,Math.max(0,(Number(settings.memoryBudget)||1200)*2));
  let remaining=memoryEvidenceBudget;
  const expectedBlocks=[...memory.filter(block=>!block.automatic),...memory.filter(block=>block.automatic).slice(-2)].slice(0,6);
  for(const block of expectedBlocks){
    if(remaining<80)break;
    const part=block.content.slice(0,remaining);
    recentEvidence.push(part);
    remaining-=part.length;
  }
  if(!memory.some(block=>block.automatic)&&chat.summary?.trim())recentEvidence.push(chat.summary.slice(0,Math.min(forecast,remaining)));

  const archiveRole=message=>version===2?(message.archiveRole||message.role):message.role;
  const archiveText=message=>version===2?(message?.archiveContent??message?.content):message?.content;
  const lastUser = messages.filter(message=>archiveRole(message)==='user'&&message.kind!=='engine').slice(-2);
  const focus = String(content || '').trim() || archiveText(lastUser.at(-1)) || archiveText(messages.at(-1)) || '';
  if (recentEvidence.length && !content && lastUser.at(-1)?.id === messages.at(-1)?.id)
    recentEvidence.push(...recent.filter(m=>m.characterId&&m.kind!=='engine'&&m.role==='user').map(m=>m.content).filter(text=>text.length<=forecast));
  const indices=new Map((chat.messages||[]).map((message,index)=>[message.id,index]));
  const archive = messages.map(message => ({
    id: 'post:' + message.id,
    text: archiveText(message),
    metadata: {
      kind: 'source', messageId: message.id, index: indices.get(message.id), role: version===2?archiveRole(message):message.characterId?'assistant':message.role,
      name: message.name || '', messageKind: message.kind, characterId:message.characterId,
      source: message.kind === 'engine' ? 'Подтверждённое событие движка' : 'Архив истории',
    },
  }));
  const character = state.characters?.find(item=>item.id===chat.characterId);
  const lorebookIds = new Set(chat.lorebookIds || character?.lorebookIds || []);
  const lore = Number(settings.loreBudget)!==0?(state.lorebooks || []).filter(book=>lorebookIds.has(book.id)).flatMap(book =>
    (book.entries||[]).filter(entry=>entry.enabled!==false&&entry.vectorized&&entry.content?.trim()).map(entry=>({
      id: 'lore:' + book.id + ':' + entry.id, text: entry.content, metadata: {kind:'lore',entryId:entry.id,name:entry.name||'',source:book.name||''},
    }))
  ):[];
  const memories = memory.map(block=>({
    id: 'memory:' + block.id, text: block.content, metadata:{kind:'memory',memoryId:block.id,name:block.title||'',source:'Память истории',automatic:!!block.automatic},
  }));
  const relatedQuery = [chat.scene?.location, character?.name, archiveText(lastUser[content ? lastUser.length-1 : lastUser.length-2]), focus.slice(0,430)].filter(Boolean).join(' · ');
  const embeddingThreshold = Number(state.settings?.embeddings?.threshold);
  const {results, report} = await recallArchive({
    scope: chat.id?.startsWith('room-')?'room:'+chat.id.slice(5):'chat:'+chat.id,
    query: focus, relatedQuery, recentEvidence:version===2?recent.filter(m=>archiveRole(m)==='assistant'&&archiveText(m).length<=forecast).map(archiveText):recentEvidence, version,
    documents: [...archive,...lore,...memories],
    exclude: version===2?[]:recent.filter(message=>message.content.length<=forecast).map(message=>'post:'+message.id),
    scene: {currentLocation:chat.scene?.location||''}, embed: archiveEncoder(state, embeddings),
    threshold: Number.isFinite(embeddingThreshold) ? embeddingThreshold : .35, signal,
  });
  const sources = results.filter(item=>item.chunk.metadata.kind==='source').map(({chunk, finalScore})=>({
    ...chunk.metadata, text:chunk.content, score:finalScore,
  })).sort((a,b)=>a.index-b.index||a.start-b.start);
  const loreIds=results.filter(item=>item.chunk.metadata.kind==='lore').map(item=>item.chunk.metadata.entryId);
  const memoryIds=results.filter(item=>item.chunk.metadata.kind==='memory').map(item=>item.chunk.metadata.memoryId);
  return {
    retrieval:{archiveRecall:true,...(version===2?{archiveEvidence:report}:{}),...(loreIds.length?{vectorLoreIds:loreIds}:{}),...(memoryIds.length?{memoryIds}:{}),sourceExcerpts:sources},
    report:{archiveRecall:report,vectorStatus:report.vectorStatus,sources:sources.map(({text,...source})=>source),sourceExcerpts:sources,memoryIds},
    warnings:report.warnings,
    text:'',
  };
}

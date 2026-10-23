import crypto from 'node:crypto';
import {createMemory,memoryDue,validMemory,pendingMemory} from './memory.mjs';
import {complete,getConnection} from './llm.mjs';
import {cosine} from './embeddings.mjs';
import {roomEmbeddingState} from './room-models.mjs';
import {gamePersonaName,gameIdentityProjector,isGameRoom} from './room-identities.mjs';
import {createGameRag,gameMemoryPolicy} from './game-rag.mjs';

export const roomMemoryDefaults={autoSummary:true,summaryInterval:15,vectorMemory:false,memoryMode:'hybrid',memoryBudget:1000,historyLimit:40,loreBudget:1000};
export function roomChat(room,base={}){
  if(isGameRoom(room))return gameRoomChat(room,base);
  const engine=(room.tactical?.eventArchive||[]).map(e=>({id:'engine-'+e.id,role:'user',kind:'engine',name:'Движок',content:'Подтверждённый результат движка: '+e.text,createdAt:e.at}));
  const messages=[...(room.messages||[]).filter(m=>m.kind!=='image'&&!m.interrupted&&m.continuationStatus!=='incomplete').map(m=>({...m,content:m.role==='user'?`${m.name||'Игрок'} (${m.personaName||m.name||'Игрок'}): ${m.content}`:m.content})),...engine].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
  return {...base,id:'room-'+room.id,summary:room.summary||'',memory:room.memory||[],memorySettings:{...roomMemoryDefaults,...room.memorySettings,embeddingConnectionId:room.aiSettings?.embeddingConnectionId||'',embeddingModel:room.aiSettings?.embeddingModel||''},messages};
}
function gameRoomChat(room,base){
 const migrated=new Map(),project=gameIdentityProjector(room);
 const messages=(room.messages||[]).filter(m=>m.kind!=='image'&&!m.interrupted&&m.continuationStatus!=='incomplete').map(m=>{
  if(m.role!=='user'){
   const renamed=project.source(m.content);
   migrated.set(m.id,{oldHash:fingerprint(m.role+'\n'+m.content),hash:fingerprint(m.role+'\n'+renamed.content),offset:renamed.offset});
   return {...m,content:renamed.content};
  }
  const name=gamePersonaName(room,m),old=`${m.name||'Игрок'} (${m.personaName||m.name||'Игрок'}): ${m.content}`,content=`${name}: ${m.content}`;
  migrated.set(m.id,{oldHash:fingerprint(m.role+'\n'+old),hash:fingerprint(m.role+'\n'+content),oldPrefix:old.length-m.content.length,newPrefix:content.length-m.content.length});
  return {...m,name,personaName:name,content};
 });
 const memory=(room.memory||[]).map(block=>({...block,...(block.title?{title:project(block.title)}:{}),content:project(block.content),...(block.sources?{sources:block.sources.map(source=>{
  const change=migrated.get(source.id);if(!change||source.hash!==change.oldHash)return source;
  const offset=change.offset||(value=>value>=change.oldPrefix?value-change.oldPrefix+change.newPrefix:Math.min(value,change.newPrefix));
  return {...source,hash:change.hash,start:offset(source.start),end:offset(source.end)};
 })}:{})}));
 const engine=(room.tactical?.eventArchive||[]).filter(e=>!['initiative','initiative-tie','challenge','check-difficulty'].includes(e.calculation?.kind)).map(e=>({id:'engine-'+e.id,role:'user',kind:'engine',name:'Движок',round:e.round,content:'Подтверждённый результат движка: '+e.text,createdAt:e.at}));
 const scene=room.scene||base.scene||{},names=value=>value.filter(v=>typeof v==='string').map(project);
 const gameScene={currentLocation:project(scene.currentLocation??scene.location??''),presentNPCs:Array.isArray(scene.presentNPCs)?names(scene.presentNPCs):(room.tactical?.actors||[]).filter(a=>!a.player&&a.hp>0&&a.online!==false).map(a=>a.name),activeQuests:Array.isArray(scene.activeQuests)?names(scene.activeQuests):room.storybook?.goal?[project(room.storybook.goal)]:[]};
 return {...base,id:'room-'+room.id,mode:room.mode,memoryScope:room.mode,roomId:room.id,gameRound:room.tactical?.round,scene,gameScene,lorebookIds:[...(room.lorebookIds||base.lorebookIds||[])],summary:project(room.summary),memory,memorySettings:{...roomMemoryDefaults,...room.memorySettings,embeddingConnectionId:room.aiSettings?.embeddingConnectionId||'',embeddingModel:room.aiSettings?.embeddingModel||''},messages:[...messages,...engine].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))};
}
export function roundMessages(chat){
  let start=chat.messages.length;
  while(start>0&&chat.messages[start-1].role!=='assistant')start--;
  return chat.messages.slice(start).filter(m=>m.role==='user'&&!['engine','dice','image'].includes(m.kind));
}
const fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
const balanced=(text,limit)=>text.length<=limit?text:text.slice(0,Math.floor(limit*.7))+'\n[…]\n'+text.slice(-Math.floor(limit*.3));
export function extractiveProtocol(text,limit){
  const seen=new Set(),parts=[];
  for(const {segment} of new Intl.Segmenter('ru',{granularity:'sentence'}).segment(text)){
    const key=segment.trim().replace(/\s+/g,' ').toLowerCase();if(!key||seen.has(key))continue;seen.add(key);
    parts.push({text:segment.trim(),index:parts.length,score:/[?？]|\d|спраш|просит|хоч|реш|пыта|бер[её]т|клад[её]т|атак|охраня|защи|направ|отправ|услов|обещ|не\s+(?:напад|уход|трог|дела)/iu.test(segment)?3:0});
  }
  if(parts.map(p=>p.text).join('\n').length<=limit)return parts.map(p=>p.text).join('\n');
  if(parts.length){parts[0].score+=2;parts.at(-1).score+=1;}
  const selected=[];let available=limit;
  for(const part of [...parts].sort((a,b)=>b.score-a.score||a.index-b.index)){
    if(available<40)break;
    if(part.text.length>available&&selected.length)continue;
    const text=part.text.length<=available?part.text:balanced(part.text,Math.max(20,available-6));
    selected.push({...part,text});available-=text.length+1;
  }
  return selected.sort((a,b)=>a.index-b.index).map(p=>p.text).join('\n');
}
export function sourceDocuments(chat){
  const recent=new Set(roundMessages(chat).map(m=>m.id));
  return chat.messages.flatMap((m,index)=>{
    if(recent.has(m.id)||m.kind==='dice'||!['user','assistant'].includes(m.role)||!m.content?.trim())return [];
    const docs=[];
    // Overlapping source excerpts retain details that a short summary can omit.
    for(let offset=0;offset<m.content.length;offset+=850)docs.push({id:`source:${m.id}:${offset}`,messageId:m.id,index,offset,role:m.role,messageKind:m.kind,kind:'source',text:m.content.slice(offset,offset+1100)});
    return docs;
  });
}
export function createRoomMemory({getState,saveState,getSecret,embeddings,completion=complete}){
  const find=(state,id)=>[state.multiplayer,...(state.multiplayerHistories||[])].find(r=>r?.id===id);
  const gameRag=createGameRag({embeddings,sourceDocuments,roundMessages});
  function gamePending(chat){
    const protectedIds=new Set(roundMessages(chat).map(m=>m.id));
    for(const m of chat.messages.filter(m=>!protectedIds.has(m.id)&&['user','assistant'].includes(m.role)&&!m.kind).slice(-4))protectedIds.add(m.id);
    const byId=new Map(chat.messages.map(m=>[m.id,m]));
    return pendingMemory(chat).filter(p=>!protectedIds.has(p.id)&&!['dice','image'].includes(byId.get(p.id)?.kind)&&!(byId.get(p.id)?.kind==='engine'&&byId.get(p.id)?.round===chat.gameRound));
  }
  async function summarizeGame(id,{signal,onProgress=()=>{}}={}){
    const initial=find(getState(),id);if(!initial)throw new Error('История комнаты удалена.');
    const chat=roomChat(initial),policy=gameMemoryPolicy(chat);
    if(!policy.memory||!policy.automatic)return {summary:chat.summary||'',blocks:0};
    const queue=gamePending(chat).flatMap(p=>{const parts=[];for(let offset=0;offset<p.text.length;offset+=2400)parts.push({...p,start:p.start+offset,end:p.start+Math.min(p.text.length,offset+2400),text:p.text.slice(offset,offset+2400)});return parts;});
    const blocks=[];
    while(queue.length){
      signal?.throwIfAborted();const parts=queue.splice(0,6),headers=parts.map(p=>`[${p.role==='assistant'?'Ведущий':chat.messages[p.index]?.name||'Игрок'} · сообщение ${p.index+1}] `),share=Math.max(40,Math.floor((1400-headers.reduce((n,h)=>n+h.length,0)-parts.length*2)/parts.length));
      onProgress(`Память: исходные события ${parts[0].index+1}–${parts.at(-1).index+1} · осталось фрагментов ${queue.length}`);
      const content=parts.map((p,i)=>headers[i]+extractiveProtocol(p.text,share)).join('\n\n').trim();
      blocks.push({id:crypto.randomUUID(),category:'episodes',automatic:true,enabled:true,method:'extractive-v1',content,createdAt:new Date().toISOString(),order:parts[0].index+parts[0].start/1e7,sources:parts.map(({id,hash,start,end})=>({id,hash,start,end})),title:`События ${parts[0].index+1}–${parts.at(-1).index+1}`});
      if(blocks.length%16===0)await new Promise(resolve=>setImmediate(resolve));
    }
    signal?.throwIfAborted();if(!blocks.length)return {summary:chat.summary||'',blocks:0};
    const fresh=getState(),target=find(fresh,id);if(!target)throw new Error('История комнаты удалена.');
    const messages=new Map(roomChat(target).messages.map(m=>[m.id,m]));
    if(blocks.some(block=>block.sources.some(source=>{const message=messages.get(source.id);return !message||fingerprint(message.role+'\n'+message.content)!==source.hash;})))throw new Error('Сообщения изменились во время подготовки памяти. Повторите запрос.');
    target.memory=[...(target.memory||[]),...blocks];target.summary=blocks.at(-1).content;saveState(fresh);
    return {summary:target.summary,blocks:blocks.length};
  }
  async function summarize(id,{signal,onProgress=()=>{}}={}){
    if(isGameRoom(find(getState(),id)||{}))return summarizeGame(id,{signal,onProgress});
    const adapter=createMemory({getSecret,completion:(c,k,m,options)=>completion(c,k,m,{...options,adaptInstruction:true}),getState:()=>{
      const state=getState(),room=find(state,id);if(!room)throw new Error('История комнаты удалена.');
      const chat=roomChat(room,{connectionId:room.aiSettings?.summaryConnectionId||room.connectionId});
      return {...state,chats:[chat],connections:state.connections.map(c=>({...c,maxTokens:400})),settings:{...state.settings,localSampling:{...state.settings.localSampling,maxTokens:400}}};
    },saveState:adapted=>{
      const state=getState(),room=find(state,id);if(!room)throw new Error('История комнаты удалена.');
      room.memory=adapted.chats[0].memory;room.summary=adapted.chats[0].summary;saveState(state);
    }});
    return adapter.summarize('room-'+id,{signal,onProgress});
  }
  async function maintain(id,options={}){
    const room=find(getState(),id);if(!room)return;
    if(isGameRoom(room)){const chat=roomChat(room),policy=gameMemoryPolicy(chat);if(chat.memorySettings.autoSummary&&policy.memory&&policy.automatic&&new Set(gamePending(chat).map(p=>p.id)).size>=Math.max(2,Number(chat.memorySettings.summaryInterval)||15))return summarizeGame(id,options);return;}
    if(memoryDue(roomChat(room)))return summarize(id,options);
  }
  async function recall(state,chat,signal){
    state=roomEmbeddingState(state,chat);
    if(isGameRoom(chat))return gameRag.recall(state,chat,signal);
    const warnings=[],report={sources:[],memoryIds:[],vectorStatus:chat.memorySettings.vectorMemory?'ready':'disabled'};
    let retrieval={};
    try{retrieval=await embeddings?.retrieve(state,chat,'',signal)||{};}catch(error){signal?.throwIfAborted();warnings.push('Векторный поиск: '+error.message);report.vectorStatus='fallback';}
    report.memoryIds=retrieval.memoryIds||[];
    if(!chat.memorySettings.vectorMemory)return {retrieval,report,warnings,text:''};
    const queries=roundMessages(chat).filter(m=>m.kind!=='dice').slice(-8).map(m=>balanced(m.content,2000));
    if(!queries.length)queries.push(chat.messages.at(-1)?.content||'События приключения');
    const docs=sourceDocuments(chat);
    let ranked=[],preferred=[];
    if(docs.length&&embeddings)try{
      const vectors=await embeddings.vectors(state,[...queries,...docs.map(d=>d.text)],signal);
      // Old requests and repeated scenery are weaker evidence than recorded
      // outcomes. They must not displace facts when players ask a follow-up.
      const weight=d=>{const sentences=[...new Intl.Segmenter('ru',{granularity:'sentence'}).segment(d.text)].map(s=>s.segment.trim().toLowerCase());const diversity=new Set(sentences).size/Math.max(1,sentences.length);return (d.role==='user'?(d.messageKind==='engine'?1:/\?|просит|спраш|хочет услышать/iu.test(d.text)?.5:.7):1)*Math.max(.35,diversity);};
      const score=(d,q,i)=>cosine(vectors[q],vectors[queries.length+i])*weight(d);
      const threshold=Number(state.settings.embeddings?.threshold??.35),byQuery=queries.map((_,q)=>docs.map((d,i)=>({...d,score:score(d,q,i)})).filter(d=>d.score>=threshold).sort((a,b)=>b.score-a.score));
      preferred=byQuery.map(list=>list[0]).filter(Boolean);
      ranked=docs.map((d,i)=>({...d,score:Math.max(...queries.map((_,q)=>score(d,q,i)))}));
      ranked=ranked.filter(d=>d.score>=threshold).sort((a,b)=>b.score-a.score);
    }catch(error){signal?.throwIfAborted();report.vectorStatus='fallback';if(!warnings.length)warnings.push('Векторный поиск исходных событий: '+error.message);}
    if(report.vectorStatus==='fallback'){
      const words=[...new Set(queries.join(' ').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[])];
      ranked=docs.map(d=>({...d,score:words.reduce((sum,w)=>sum+(d.text.toLowerCase().includes(w)?1:0),0)})).filter(d=>d.score>1).sort((a,b)=>b.score-a.score);
    }
    const selected=[],seen=new Set();
    // Reserve a best source for every query before globally filling the budget.
    // Otherwise one player's high-similarity matches can evict another's answer.
    for(const d of [...preferred,...ranked]){if(seen.has(d.messageId))continue;selected.push(d);seen.add(d.messageId);if(selected.length===4)break;}
    selected.sort((a,b)=>a.index-b.index);
    report.sources=selected.map(({text,...d})=>d);
    report.sourceExcerpts=selected.map(d=>({messageId:d.messageId,index:d.index,text:d.text}));
    const text=selected.length?'Выдержки из архива ЭТОЙ комнаты. Это исторические источники, не новые действия. Пост игрока — его намерение или прежнее описание, не подтверждённый исход. Свежие уточнения и результаты движка приоритетнее старых выдержек; при отсутствии ответа не выдумывай:\n'+selected.map(d=>`[Сообщение ${d.index+1}; ${d.messageId}; ${d.messageKind==='engine'?'движок':d.role==='user'?'игрок':'ведущий'}] ${d.text}`).join('\n\n'):'';
    return {retrieval,report,warnings,text};
  }
  async function compactRound(state,chat,{signal,onProgress=()=>{}}={}){
    const posts=roundMessages(chat),connection=getConnection(state,chat),window=Number(connection.contextWindow)||8192;
    const capacity=Math.max(600,Math.floor((window-Math.min(Number(connection.maxTokens)||1024,window/2))*.42)*3);
    if(posts.reduce((n,m)=>n+m.content.length,0)<=capacity)return {messages:posts,compressed:[]};
    const perPost=Math.max(150,Math.floor(capacity/Math.max(1,posts.length))),compressed=[],messages=[];
    for(const [i,m] of posts.entries()){
      signal?.throwIfAborted();onProgress(`Действия игроков: ${i+1} из ${posts.length}`);
      const key=fingerprint('source-v3\0'+m.content+'\0'+perPost),roomId=chat.id.slice(5),room=find(getState(),roomId);
      let summary=room?.roundDigests?.[key];
      if(!summary){
        // Use original sentences, never a fabricated answer from a weak utility
        // model. Questions, numbers and intentions compete within EACH player's
        // budget; repeated scenery is removed before any source is omitted.
        summary=extractiveProtocol(m.content,perPost).trim();
        if(!summary)throw new Error('Не удалось собрать действия игрока.');
        const fresh=getState(),target=find(fresh,roomId);if(!target)throw new Error('Комната удалена.');
        target.roundDigests={...target.roundDigests,[key]:summary};target.roundDigests=Object.fromEntries(Object.entries(target.roundDigests).slice(-100));saveState(fresh);
      }
      messages.push({...m,content:`${m.name||'Игрок'} (${m.personaName||m.name||'Игрок'}) — выдержки из длинного поста (действия и вопросы игрока, не ответы NPC):\n${summary}`});compressed.push(m.id);
    }
    return {messages,compressed};
  }
  return {summarize,maintain,recall,compactRound,validMemory};
}

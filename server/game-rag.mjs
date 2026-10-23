import crypto from 'node:crypto';
import {validMemory} from './memory.mjs';
import {semanticChunkLorebook,chunkLorebookAsync} from './rag/chunking.mjs';
import {hybridSearch,rerankResults} from './rag/search.mjs';

const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const modes=new Set(['hybrid','full','summary','pinned','manual']);
const gameModes=new Set(['dnd','custom']);
const entityTypes=new Set(['npc','location','spell','item','lore','quest']);
const narrative=m=>['user','assistant'].includes(m.role)&&!m.kind&&!m.interrupted&&m.continuationStatus!=='incomplete'&&m.content?.trim();
const cleanTags=value=>Array.isArray(value)?value.filter(v=>typeof v==='string').map(v=>v.slice(0,100)):[];
const trimQuery=(text,limit)=>text.length<=limit?text:text.slice(0,Math.floor(limit*.65))+' '+text.slice(-Math.floor(limit*.35));
function currentPosts(chat){let start=chat.messages.length;while(start>0&&chat.messages[start-1].role!=='assistant')start--;return chat.messages.slice(start).filter(m=>m.role==='user'&&!['engine','dice','image'].includes(m.kind));}
function defaultDocuments(chat){return chat.messages.map((m,index)=>({messageId:m.id,index,role:m.role,messageKind:m.kind,text:m.content}));}
export function gameMemoryPolicy(chat){
 const requested=chat.memorySettings?.memoryMode||'hybrid',mode=modes.has(requested)?requested:'off';
 const hasMemoryBudget=Number(chat.memorySettings?.memoryBudget)!==0;
 return {mode,memory:mode!=='off'&&hasMemoryBudget,sources:['hybrid','full'].includes(mode)&&hasMemoryBudget,automatic:!['pinned','manual'].includes(mode),vectors:!!chat.memorySettings?.vectorMemory};
}
export function localEmbeddingConnection(state){
 const id=state.settings?.embeddings?.connectionId;
 const connection=id&&state.connections?.find(c=>c.id===id);if(!connection)return null;
 if(connection.id==='sas-local')return null;
 try{const url=new URL(connection.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;const host=url.hostname.toLowerCase();return host==='localhost'||host==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(host)?connection:null;}catch{return null;}
}
function sourceDescriptors(state,chat,policy,documents,posts){
 const scope='room:'+chat.roomId,descriptors=[],selected=new Set(chat.lorebookIds||[]);
 for(const book of state.lorebooks||[]){
  if(!selected.has(book.id)||book.enabled===false||Number(chat.memorySettings?.loreBudget)===0)continue;
  for(const entry of book.entries||[]){
   if(entry.enabled===false||!entry.content?.trim())continue;
   descriptors.push({id:`lore:${book.id}:${entry.id}`,text:entry.content,metadata:{source:`Лорбук «${book.name||book.id}» · ${entry.name||entry.id}`,scope,kind:'lore',name:entry.name||book.name,tags:[...cleanTags(book.tags),...cleanTags(entry.tags),...(entry.constant?['pinned']:[])],vectorized:entry.vectorized===true,priority:Number(entry.priority)||0,bookId:book.id,entryId:entry.id,...(entityTypes.has(entry.type)?{type:entry.type}:{})}});
  }
 }
 if(policy.memory){
  const memories=validMemory(chat).filter(m=>policy.automatic||!m.automatic);
  for(const block of memories){
   if(policy.mode==='summary'&&!block.automatic)continue;
   descriptors.push({id:'memory:'+block.id,text:block.content,metadata:{source:block.title||'Память комнаты',scope,kind:'memory',tags:[...cleanTags(block.tags),...(!block.automatic?['pinned']:[])],vectorized:policy.vectors,memoryId:block.id,automatic:!!block.automatic}});
  }
  // Legacy summaries have no source map. Do not revive one whose automatic
  // source-backed blocks are now invalid after an edit or deletion.
  if(chat.summary?.trim()&&policy.mode==='summary'&&!(chat.memory||[]).some(m=>m.automatic))descriptors.push({id:'memory:legacy-summary',text:chat.summary,metadata:{source:'Сводка этой комнаты',scope,kind:'memory',tags:[],vectorized:policy.vectors}});
 }
 if(policy.sources){
  const protectedIds=new Set(posts.map(m=>m.id));
  for(const m of chat.messages.filter(m=>!protectedIds.has(m.id)&&narrative(m)).slice(-4))protectedIds.add(m.id);
  const allowed=new Map();for(const doc of documents(chat))if(!protectedIds.has(doc.messageId))allowed.set(doc.messageId,doc);
  for(const [index,m]of chat.messages.entries()){
   if(!allowed.has(m.id)||m.interrupted||m.continuationStatus==='incomplete'||['dice','image'].includes(m.kind)||!['user','assistant'].includes(m.role)||!m.content?.trim()||m.kind==='engine'&&m.round===chat.gameRound)continue;
   descriptors.push({id:'source:'+m.id,text:m.content,metadata:{source:m.kind==='engine'?'Подтверждённое событие движка':m.role==='assistant'?'Архив: ответ ведущего':'Архив: намерение игрока',scope,kind:'source',messageId:m.id,messageKind:m.kind,role:m.role,index,tags:[],vectorized:policy.vectors}});
  }
 }
 return descriptors;
}
function sceneOf(chat){
 const scene=chat.gameScene||chat.scene||{};
 return {currentLocation:scene.currentLocation||scene.location||'',presentNPCs:Array.isArray(scene.presentNPCs)?scene.presentNPCs:[],activeQuests:Array.isArray(scene.activeQuests)?scene.activeQuests:[]};
}

// The manifest caches pure source chunks, not query results or room state.
// Vectors retain the existing persistent cache in embeddings.vectors().
export function createGameRag({embeddings,chunkLorebook=semanticChunkLorebook,asyncChunkLorebook=chunkLorebookAsync,search=hybridSearch,sourceDocuments=defaultDocuments,roundMessages=currentPosts,maxRooms=8,maxSources=4096,maxChunks=16000}={}){
 const rooms=new Map(),statistics={hits:0,misses:0,evictions:0};
 const dropRoom=id=>{if(rooms.delete(id))statistics.evictions++;};
 function manifest(scope){let room=rooms.get(scope);if(!room){room={documents:new Map(),chunks:0};rooms.set(scope,room);}else{rooms.delete(scope);rooms.set(scope,room);}while(rooms.size>maxRooms)dropRoom(rooms.keys().next().value);return room;}
 function trim(){
  const count=()=>[...rooms.values()].reduce((n,r)=>n+r.chunks,0);
  for(const room of rooms.values())while(room.documents.size>maxSources){const id=room.documents.keys().next().value;room.chunks-=room.documents.get(id).chunks.length;room.documents.delete(id);statistics.evictions++;}
  while(count()>maxChunks){const scope=rooms.keys().next().value,room=rooms.get(scope);if(!room)break;const id=room.documents.keys().next().value;if(id===undefined){dropRoom(scope);continue;}room.chunks-=room.documents.get(id).chunks.length;room.documents.delete(id);statistics.evictions++;}
 }
 async function recall(state,chat,signal){
  signal?.throwIfAborted();if(!gameModes.has(chat.mode)||!chat.roomId||chat.id!=='room-'+chat.roomId)throw new Error('RAG приключения требует область текущей комнаты.');
  const policy=gameMemoryPolicy(chat),scope='room:'+chat.roomId,room=manifest(scope),posts=roundMessages(chat),warnings=[];
  const connection=localEmbeddingConnection(state),vectorAllowed=policy.vectors&&!!connection&&typeof embeddings?.vectors==='function';
  let vectorStatus=!policy.vectors?'disabled':vectorAllowed?'ready':'fallback';
  if(policy.vectors&&!vectorAllowed)warnings.push('Векторный поиск приключения доступен только через выбранное локальное embedding-подключение. Используется поиск по словам.');
  const descriptors=sourceDescriptors(state,chat,policy,sourceDocuments,posts),live=new Set(descriptors.map(d=>d.id)),chunks=[];
  const nativeExpected=vectorAllowed&&connection.id==='sas-embedding'&&descriptors.some(d=>d.metadata.vectorized!==false);let tokenizer,nativeFailed=false;
  const nativeFailure=error=>{signal?.throwIfAborted();if(error?.name==='AbortError'||error?.name==='CanceledError')throw error;nativeFailed=true;vectorStatus='fallback';warnings.push('Нативная токенизация embedding-фрагментов недоступна: '+String(error?.message||error)+'. В этом поиске используется только поиск по словам.');};
  if(nativeExpected)try{
   tokenizer=await embeddings.nativeTokenizer?.(state,signal);
   if(!tokenizer?.identity||typeof tokenizer.countTokens!=='function'||!Number.isInteger(tokenizer.tokenLimit)||tokenizer.tokenLimit<16||!Number.isInteger(tokenizer.reserve)||tokenizer.reserve<0||tokenizer.tokenLimit-tokenizer.reserve<8)throw new Error('Встроенный embedding-движок не предоставил нативный счётчик токенов.');
  }catch(error){tokenizer=undefined;nativeFailure(error);}
  else if(vectorAllowed&&connection.id!=='sas-embedding')warnings.push('Для выбранного локального embedding API границы фрагментов оценены приближённо. Проверку нативного лимита выполняет только встроенный embedding-движок.');
  const limit=tokenizer?Math.min(512,tokenizer.tokenLimit-tokenizer.reserve):Math.max(32,Math.min(480,(Number(connection?.embeddingTokenLimit)||512)-8));
  const encoderIdentity=tokenizer?.identity||JSON.stringify([connection?.id,connection?.baseUrl,state.settings?.embeddings?.model||connection?.model,state.settings?.embeddingModelPath,connection?.embeddingTokenLimit]);
  const settingsKey=JSON.stringify({version:2,limit,encoderIdentity,mode:policy.mode,vectors:policy.vectors});
  for(const [id,record]of room.documents)if(!live.has(id)){room.chunks-=record.chunks.length;room.documents.delete(id);}
  for(const doc of descriptors){
   signal?.throwIfAborted();const sourceHash=hash(doc.text),{index,...identity}=doc.metadata,requiresNative=nativeExpected&&doc.metadata.vectorized!==false,keyBase=settingsKey+'\0'+sourceHash+'\0'+JSON.stringify(identity),key=hash(keyBase+'\0'+(requiresNative?'native':'approximate')),cached=room.documents.get(doc.id);let built;
   if(cached?.key===key){statistics.hits++;built=cached.chunks;room.documents.delete(doc.id);room.documents.set(doc.id,cached);}
   else{
    statistics.misses++;const metadata={...doc.metadata,documentId:doc.id,sourceHash},{name,...semanticMetadata}=metadata;
    const options={maxTokens:limit,modelTokenLimit:limit,overlap:Math.min(50,limit-1),source:metadata.source,documentId:doc.id,scope,metadata:semanticMetadata};let nativeVerified=false;
    if(requiresNative&&tokenizer&&!nativeFailed)try{built=await asyncChunkLorebook(doc.text,{...options,countTokens:text=>tokenizer.countTokens(text,signal),signal});nativeVerified=true;}catch(error){nativeFailure(error);}
    if(!built)built=chunkLorebook(doc.text,options);
    if(!Array.isArray(built))throw new Error('Нарезка RAG не вернула список фрагментов.');
    built=built.map((chunk,i)=>({...chunk,id:hash(scope+'\0'+doc.id+'\0'+sourceHash+'\0'+i+'\0'+chunk.content).slice(0,40),metadata:{...chunk.metadata,...metadata,type:chunk.metadata?.type||'lore',name:chunk.metadata?.name||metadata.name,tags:[...new Set([...metadata.tags,...cleanTags(chunk.metadata?.tags)])],start:chunk.metadata?.start??0,end:chunk.metadata?.end??doc.text.length,tokenization:nativeVerified?'native':'approximate',...(nativeVerified?{nativeTokenLimit:limit}:{})}}));
    // Approximate fallback chunks must never satisfy the native verified key;
    // the next request can retry the recovered tokenizer exactly once per doc.
    const savedKey=requiresNative&&!nativeVerified?hash(keyBase+'\0native-unverified'):key;
    if(cached)room.chunks-=cached.chunks.length;room.documents.set(doc.id,{key:savedKey,chunks:built});room.chunks+=built.length;
   }
   chunks.push(...built.map(chunk=>({...chunk,metadata:{...chunk.metadata,...(index!==undefined?{index}:{})}})));
  }
  trim();
  if(nativeFailed)for(let i=0;i<chunks.length;i++)chunks[i]={...chunks[i],metadata:{...chunks[i].metadata,vectorized:false}};
  const perPost=Math.max(60,Math.floor(4200/Math.max(1,posts.length))),query=posts.length?posts.map(m=>trimQuery(m.content,perPost)).join('\n'):trimQuery(chat.messages.filter(narrative).at(-1)?.content||sceneOf(chat).currentLocation||'События приключения',1800);
  let calls=0;
  const embed=vectorAllowed&&!nativeFailed?async(texts,searchSignal)=>{if(++calls>1)throw new Error('Векторизация поиска должна выполняться одним запросом.');return embeddings.vectors(state,texts,searchSignal);}:undefined;
  const results=chunks.length?await search(query,sceneOf(chat),{chunks,embed,scope,topK:20,vectorTopK:10,keywordTopK:10,vectorThreshold:Number(state.settings?.embeddings?.threshold??.35),signal,onVectorError:error=>{signal?.throwIfAborted();vectorStatus='fallback';warnings.push('Векторный поиск: '+String(error?.message||error));}}):[];
  signal?.throwIfAborted();const ranked=[...results],seen=new Set(ranked.map(r=>r.chunk.id));
  // Always-on lore/manual notes remain eligible when the current query has no
  // overlap. They still compete within the final three-chunk token budget.
  for(const chunk of chunks)if(chunk.metadata.tags.includes('pinned')&&!seen.has(chunk.id))ranked.push({chunk,vectorScore:0,keywordScore:0,finalScore:0});
  ranked.splice(0,ranked.length,...rerankResults(ranked,[],sceneOf(chat)));
  ranked.sort((a,b)=>b.finalScore-a.finalScore||(Number(b.chunk.metadata.priority)||0)-(Number(a.chunk.metadata.priority)||0)||a.chunk.id.localeCompare(b.chunk.id));ranked.splice(64);
  const report={vectorStatus,memoryIds:[],sources:ranked.map(({chunk,vectorScore,keywordScore,finalScore})=>({id:chunk.id,...chunk.metadata,vectorScore,keywordScore,score:finalScore})),rag:{scope,documents:descriptors.length,chunks:chunks.length,candidates:ranked.length,embeddingCalls:calls,tokenizer:nativeExpected?(nativeFailed?'unavailable':'native'):'approximate',...(tokenizer?{nativeTokenLimit:limit}:{}),cache:stats()}};
  return {retrieval:{gameRag:true,gameRagResults:ranked,memoryIds:[],vectorLoreIds:[]},report,warnings,text:''};
 }
 function stats(){return {...statistics,rooms:rooms.size,documents:[...rooms.values()].reduce((n,r)=>n+r.documents.size,0),chunks:[...rooms.values()].reduce((n,r)=>n+r.chunks,0)};}
 return {recall,stats,clear:scope=>scope?rooms.delete(scope):rooms.clear()};
}

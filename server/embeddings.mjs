import {createVectorCache} from './vector-cache.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validMemory} from './memory.mjs';
export function retrievalQueries(text){
 const sentences=[...new Intl.Segmenter('ru',{granularity:'sentence'}).segment(String(text||''))].map(p=>p.segment.trim());
 const unique=[...new Set(sentences)].filter(Boolean),questions=unique.filter(s=>/[?？]|напомни|вспомни|remember|recall/iu.test(s));
 const focused=questions.flatMap(s=>s.split(/,\s*(?=(?:что|когда|как|куда|сколько|где|почему|зачем)(?:\s|[?？]))/iu));
 return (focused.length?focused:unique.length?[unique.join(' ').slice(-2400)]:[]).slice(-6).map(s=>s.slice(-1800));
}
export const embeddingDefaults={connectionId:'',model:'',threshold:0.35,topK:8};
export function cosine(a,b){if(a.length!==b.length||!a.length)return -1;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]**2;bb+=b[i]**2;}return aa&&bb?dot/Math.sqrt(aa*bb):-1;}
export async function embeddingChunks(text,limit,countTokens,signal){
 const tokens=await countTokens(text);signal?.throwIfAborted();if(tokens<=limit)return [{text,tokens}];
 if(text.length<2)throw new Error('Текст не помещается в контекст embedding-модели.');
 const middle=Math.floor(text.length/2),prefix=text.slice(0,middle),boundary=[...prefix.matchAll(/[.!?。！？\n]\s*|\s+/g)].at(-1);
 let cut=boundary&&boundary.index>middle/2?boundary.index+boundary[0].length:middle;
 if(/[\uD800-\uDBFF]/.test(text[cut-1]))cut--;
 if(cut<=0||cut>=text.length)cut=middle;
 return [...await embeddingChunks(text.slice(0,cut),limit,countTokens,signal),...await embeddingChunks(text.slice(cut),limit,countTokens,signal)];
}
export function poolEmbeddings(parts){
 if(parts.length===1)return parts[0].vector;
 const length=parts[0].vector.length;if(parts.some(p=>p.vector.length!==length))throw new Error('Несовместимые размерности частей embedding.');
 const result=Array(length).fill(0);for(const {vector,tokens} of parts){const norm=Math.hypot(...vector)||1;for(let i=0;i<length;i++)result[i]+=vector[i]/norm*Math.max(1,tokens);}
 const norm=Math.hypot(...result)||1;return result.map(n=>n/norm);
}
export function createEmbeddings({dataDir,getSecret,fetcher=fetch,maxTokenCountEntries=4096}){
 const persistentCache=createVectorCache({dataDir});
 const tokenCounts=new Map(),tokenCacheLimit=Math.max(1,Math.min(16384,Number(maxTokenCountEntries)||4096));
 const unavailable=message=>Object.assign(new Error(message),{code:'NATIVE_TOKENIZER_UNAVAILABLE'});
 async function nativeTokenizer(state,signal){
  signal?.throwIfAborted();const settings={...embeddingDefaults,...state.settings?.embeddings},connection=state.connections?.find(c=>c.id===(settings.connectionId||state.activeConnectionId));
  if(connection?.id!=='sas-embedding')return null;
  let base;try{base=new URL(connection.baseUrl);}catch{throw unavailable('Неверный адрес локального embedding-токенизатора.');}
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||!(base.hostname==='localhost'||base.hostname==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(base.hostname)))throw unavailable('Нативный embedding-токенизатор должен работать на этом компьютере.');
  const model=settings.model||connection.model;if(!model)throw unavailable('Локальная embedding-модель не выбрана.');
  const tokenLimit=Math.max(64,Math.floor(Math.min(8192,Number(connection.embeddingTokenLimit)||512))),reserve=8;
  let source=base.href;
  if(state.settings?.embeddingModelPath){const file=path.resolve(state.settings.embeddingModelPath),info=await fs.promises.stat(file);source=file+'\0'+info.size+'\0'+info.mtimeMs;}
  signal?.throwIfAborted();const identity=crypto.createHash('sha256').update('native-tokenizer-v1\0'+source+'\0'+model+'\0'+tokenLimit+'\0add_special:true').digest('hex');
  const url=connection.baseUrl.replace(/\/v1\/?$/,'').replace(/\/$/,'')+'/tokenize',secret=getSecret(connection.id),headers={'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})};
  const countTokens=async(text,countSignal=signal)=>{
   countSignal?.throwIfAborted();if(typeof text!=='string'||text.length>200000)throw new Error('Текст embedding-токенизатора: до 200 000 символов.');
   const key=crypto.createHash('sha256').update(identity+'\0'+text).digest('hex');
   if(tokenCounts.has(key)){const value=tokenCounts.get(key);tokenCounts.delete(key);tokenCounts.set(key,value);return value;}
   const requestSignal=countSignal?AbortSignal.any([countSignal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
   const response=await fetcher(url,{method:'POST',headers,body:JSON.stringify({content:text,add_special:true}),signal:requestSignal});countSignal?.throwIfAborted();
   if(!response.ok)throw unavailable('Токенизация embedding-модели: HTTP '+response.status+'. Используется поиск по словам.');
   const data=await response.json();countSignal?.throwIfAborted();
   if(!Array.isArray(data.tokens)||data.tokens.length>1_000_000||data.tokens.some(token=>!Number.isInteger(token)||token<0))throw unavailable('Embedding-токенизатор не вернул корректные токены.');
   const value=data.tokens.length;tokenCounts.set(key,value);while(tokenCounts.size>tokenCacheLimit)tokenCounts.delete(tokenCounts.keys().next().value);return value;
  };
  return {identity,model,tokenLimit,reserve,countTokens};
 }
 async function countTokens(state,text,signal){const tokenizer=await nativeTokenizer(state,signal);if(!tokenizer)throw unavailable('Нативный счётчик токенов доступен только для встроенного embedding-движка.');return tokenizer.countTokens(text,signal);}
 async function vectors(state,texts,signal){
  const settings={...embeddingDefaults,...state.settings.embeddings},connection=state.connections.find(c=>c.id===(settings.connectionId||state.activeConnectionId));
  if(!connection?.baseUrl)throw new Error('Выберите подключение для embeddings в настройках памяти.');
  const model=settings.model||connection.model;if(!model)throw new Error('Укажите embedding-модель в настройках памяти.');
  const url=new URL(connection.baseUrl.replace(/\/$/,'')+'/embeddings');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Неверный адрес embeddings API.');
  if(!Array.isArray(texts)||!texts.length||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>200000))throw new Error('Для векторизации нужен непустой текст длиной до 200 000 символов.');
  const local=connection.id==='sas-embedding',limit=local?Math.max(64,Math.min(8192,Number(connection.embeddingTokenLimit)||512))-8:0;
  const secret=getSecret(connection.id),headers={'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})};
  const requestSignal=()=>signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
  const countTokens=async text=>{
   const response=await fetcher(connection.baseUrl.replace(/\/v1\/?$/,'')+'/tokenize',{method:'POST',headers,body:JSON.stringify({content:text,add_special:true}),signal:requestSignal()});
   if(!response.ok)throw new Error('Токенизация embedding-модели: HTTP '+response.status+'. Перезапустите локальные модели.');
   const data=await response.json();if(!Array.isArray(data.tokens))throw new Error('Embedding-сервер не вернул токены.');return data.tokens.length;
  };
  let identity=url.href;
  if(local&&state.settings.embeddingModelPath){
    const info=await fs.promises.stat(state.settings.embeddingModelPath);
    identity=path.resolve(state.settings.embeddingModelPath)+'\0'+info.size+'\0'+info.mtimeMs;
  }
  const keys=texts.map(t=>crypto.createHash('sha256').update('v3\0'+identity+'\0'+model+'\0'+limit+'\0'+t).digest('hex'));
  const cache=await persistentCache.readMany(keys,signal),missing=[...new Set(keys.filter(k=>!cache.has(k)))];
  const pieces=[],textsByKey=new Map(keys.map((key,i)=>[key,texts[i]])),piecesByKey=new Map();
  for(const key of missing){signal?.throwIfAborted();const text=textsByKey.get(key),chunks=local?await embeddingChunks(text,limit,countTokens,signal):[{text,tokens:1}];const group=chunks.map(chunk=>({...chunk,key}));piecesByKey.set(key,group);pieces.push(...group);}
  for(let i=0;i<pieces.length;){
   signal?.throwIfAborted();const batch=[];let tokens=0;
   while(i<pieces.length&&batch.length<16&&(!local||!batch.length||tokens+pieces[i].tokens<=limit)){const p=pieces[i++];batch.push(p);tokens+=p.tokens;}
   const response=await fetcher(url,{method:'POST',headers,body:JSON.stringify({model,input:batch.map(p=>p.text),encoding_format:'float'}),signal:requestSignal()});
   if(!response.ok){const hint=response.status===500?'Сервер не обработал запрос. Проверьте журнал embedding-модели и доступную память.':response.status===400||response.status===404?'Проверьте выбранную embedding-модель и поддержку метода /embeddings.':response.status===429?'Сервер ограничил число запросов; повторите позже.':'Проверьте доступность embedding-сервера.';throw new Error(`Embeddings API: HTTP ${response.status}. ${hint}`);}
   const data=(await response.json()).data;if(!Array.isArray(data)||data.length!==batch.length)throw new Error('Embeddings API вернул неверное число векторов.');
   const seen=new Set();for(const item of data){if(!Number.isInteger(item.index)||item.index<0||item.index>=batch.length||seen.has(item.index)||!Array.isArray(item.embedding)||!item.embedding.length||item.embedding.length>16384||item.embedding.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw new Error('Некорректный embedding.');seen.add(item.index);batch[item.index].vector=item.embedding;}
  }
  for(const key of missing)cache.set(key,poolEmbeddings(piecesByKey.get(key)));
  const result=keys.map(k=>cache.get(k));
  if(result.some(v=>!Array.isArray(v)||v.length!==result[0]?.length||v.some(n=>!Number.isFinite(n)))){
    await persistentCache.invalidate(keys);
    throw new Error('Embedding-модель вернула несовместимые векторы. Кэш этого запроса сброшен; повторите запрос.');
  }
  if(missing.length)await persistentCache.writeMany(missing.map(key=>[key,cache.get(key)]),signal);
  return result;
 }
 async function retrieve(state,chat,content='',signal,{includeSources=false}={}){
  if(!chat)throw new Error('История не найдена.');
  const character=state.characters.find(c=>c.id===chat.characterId),ids=chat.lorebookIds||character?.lorebookIds||[],config={...embeddingDefaults,...state.settings.embeddings};
  const mode=chat.memorySettings?.memoryMode??state.settings?.memoryMode??'hybrid',memoryEnabled=!['off','none','disabled'].includes(mode);
  const memories=chat.memorySettings?.vectorMemory&&memoryEnabled?validMemory(chat):[],lore=state.lorebooks.filter(b=>ids.includes(b.id)).flatMap(b=>b.entries.filter(e=>e.vectorized&&e.enabled!==false));
  const sources=includeSources&&chat.memorySettings?.vectorMemory&&memoryEnabled&&['hybrid','full'].includes(mode)?(chat.messages||[]).slice(0,-3).flatMap((m,index)=>{
   if(m.interrupted||m.kind==='image'||!['user','assistant'].includes(m.role)||!m.content?.trim())return [];
   const result=[];for(let offset=0;offset<m.content.length;offset+=850)result.push({id:`source:${m.id}:${offset}`,kind:'source',messageId:m.id,index,role:m.role,text:m.content.slice(offset,offset+1100)});return result;
  }):[];
  const docs=[...memories.map(m=>({id:m.id,kind:'memory',text:m.content})),...lore.filter(e=>e.content?.trim()).map(e=>({id:e.id,kind:'lore',text:e.name+'\n'+e.content})),...sources];
  if(!docs.length)return {};
  const focus=content.trim()||chat.messages.at(-1)?.content||'',queries=retrievalQueries(focus);if(!queries.length)return {};
  const chunks=docs.flatMap(d=>Array.from({length:Math.max(1,Math.ceil(d.text.length/1200))},(_,i)=>({...d,text:d.text.slice(i*1200,(i+1)*1200)})));
  const encoded=await vectors(state,[...queries,...chunks.map(d=>d.text)],signal),scored=new Map();
  const score=(d,i,q)=>cosine(encoded[q],encoded[queries.length+i])*(d.kind==='source'&&d.role==='user'&&/[?？]/u.test(d.text)?.5:1);
  chunks.forEach((d,i)=>{const value=Math.max(...queries.map((_,q)=>score(d,i,q))),key=d.kind+':'+d.id;if(!scored.has(key)||scored.get(key).score<value)scored.set(key,{...d,score:value});});
  const threshold=Number(config.threshold),ranked=[...scored.values()].filter(d=>d.score>=threshold).sort((a,b)=>b.score-a.score),topK=Math.max(1,Math.min(30,Number(config.topK)||8));
  const preferred=queries.map((_,q)=>chunks.map((d,i)=>({...d,score:score(d,i,q)})).filter(d=>d.kind==='source'&&d.score>=threshold).sort((a,b)=>b.score-a.score)[0]).filter(Boolean),selected=[],seen=new Set();
  for(const d of [...preferred,...ranked.filter(d=>d.kind==='source')]){if(seen.has(d.messageId))continue;selected.push(d);seen.add(d.messageId);if(selected.length===4)break;}
  return {memoryIds:ranked.filter(d=>d.kind==='memory').slice(0,topK).map(d=>d.id),vectorLoreIds:ranked.filter(d=>d.kind==='lore').slice(0,topK).map(d=>d.id),...(includeSources?{sourceExcerpts:selected.sort((a,b)=>a.index-b.index).map(({messageId,index,text,score})=>({messageId,index,text,score})),vectorStatus:'ready'}:{})};
 }
 return {vectors,retrieve,nativeTokenizer,countTokens,tokenCacheStats:()=>({entries:tokenCounts.size,limit:tokenCacheLimit}),cacheStats:persistentCache.stats};
}

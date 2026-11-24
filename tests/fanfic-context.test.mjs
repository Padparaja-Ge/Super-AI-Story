import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFanficLore,resolveFanficContext,packReference,fanficCast,clip,fanficDraftSources} from '../server/fanfic-context.mjs';
import {buildFanficMessages,prepareFanficMessages,approvedMemories,contentHash,createFanfic,normalizeFanficProject,validateMemory,splitFanficMemory,splitFanficMemoryForModel,fanficMemoryInstructions,fanficMemorySchema} from '../server/fanfic.mjs';
import {messageTokens} from '../server/prompt.mjs';
import {createTasks} from '../server/tasks.mjs';
import {fanficDefaults} from '../shared/fanfic.mjs';
import {cleanFanficProse,fanficStops} from '../server/fanfic-prose.mjs';

const project=()=>({id:'own-work',world:'Свой мир',canon:'',divergence:'',settings:{...fanficDefaults,vectorMemory:true},characters:[],personas:[],lorebooks:[{id:'own-book',name:'Свой лор',entries:[
 {id:'always',content:'Правило мира',constant:true},
 {id:'word',content:'Сведения о башне',keys:['Башня'],priority:1},
 {id:'case',content:'Точная запись',keys:['Башня'],caseSensitive:true},
 {id:'selective',content:'Тайное хранилище',keys:['башня'],secondaryKeys:['ключ'],selective:true},
 {id:'vector',name:'Хранитель',content:'Страж древнего здания хранит сапфировую печать.',keys:[],vectorized:true},
 {id:'unrelated',content:'НЕСВЯЗАННЫЙ_ЛОР',keys:['чайник'],priority:100},
 {id:'off',content:'ОТКЛЮЧЁННАЯ_ЗАПИСЬ',constant:true,enabled:false}
]}]});
const encoderState=(extra={})=>({...extra,settings:{embeddings:{connectionId:'encoder'}},connections:[{id:'encoder',model:'mock-embedding',baseUrl:'http://127.0.0.1:1/v1'}]});
const memory=(id,n,summary)=>({id,episodeId:'e'+n,title:'Серия '+n,summary,location:'',relationships:[],openThreads:[]});
test('Fanfic lore respects keywords, case, secondary keys, constants and namespaced vector matches',()=>{
 const p=project();assert.deepEqual(selectFanficLore(p,'башня').map(e=>e.id),['own-book:always','own-book:word']);
 assert.equal(selectFanficLore(p,'Башня и ключ',['foreign:vector']).length,4);
 assert.ok(selectFanficLore(p,'страж',['own-book:vector']).some(e=>e.reason==='vector'));
 assert.ok(!selectFanficLore(p,'страж',['foreign:vector']).some(e=>e.id==='own-book:vector'));
});
test('Vector retrieval uses full summaries and only saved project lore, filters low scores and preserves recent chronology',async()=>{
 const p=project(),docs=[memory('old',1,'Старый секрет '+ 'начало '.repeat(400)+' САПФИР_В_КОНЦЕ'),memory('noise',2,'Нет совпадения'),memory('recent1',3,'Недавнее событие'),memory('recent2',4,'Последнее событие')];
 docs[0].sourceEvidence=['Исходная улика: БОРЕЙ-817.'];
 let inputs;const result=await resolveFanficContext({state:encoderState({fanficProjects:[{id:'other',memory:'ЧУЖОЙ_СЕКРЕТ'}],chats:[{content:'ЧУЖОЙ_ЧАТ'}]}),project:p,episode:{id:'next',brief:'Найти печать'},memories:docs,embeddings:{vectors:async(_s,texts)=>{inputs=texts;return [[1,0],[1,0],[0,1],[0,1],[0,1],[1,0]];}},signal:new AbortController().signal});
 assert.match(inputs[1],/САПФИР_В_КОНЦЕ/);assert.match(inputs[1],/БОРЕЙ-817/);assert.ok(!inputs.join().includes('ЧУЖОЙ'));assert.ok(!inputs.join().includes('НЕСВЯЗАННЫЙ_ЛОР'));
 assert.deepEqual(result.memories.map(d=>d.id),['old','recent1','recent2']);assert.equal(result.report.vectorStatus,'ready');assert.equal(result.report.selectedLore.find(d=>d.id==='own-book:vector').reason,'vector');
});
test('Vector lore works independently of the memory switch; embedding failure falls back without importing other data',async()=>{
 const p=project();p.settings.vectorMemory=false;
 const result=await resolveFanficContext({state:encoderState(),project:p,episode:{id:'next',brief:'башня'},memories:[memory('old',1,'Свой факт')],embeddings:{vectors:async()=>{throw new Error('unavailable');}},signal:new AbortController().signal});
 assert.equal(result.report.vectorStatus,'fallback');assert.deepEqual(result.memories.map(d=>d.id),['old']);assert.equal(result.lore.length,2);assert.equal(result.report.warnings.length,1);
});
test('Fanfic abort never becomes a silent vector fallback',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(resolveFanficContext({state:{},project:project(),episode:{id:'next',brief:'страж'},memories:[],embeddings:{vectors:async()=>{throw new Error('aborted');}},signal:controller.signal}),/aborted/);
});
test('Cast macros refer to saved fanfic personas, never the global username',()=>{
 const p=project();p.characters=[{id:'c',name:'Ирис',description:'{{char}} знает {{user}}.',blocks:[]}];p.personas=[{id:'u',name:'Алексей',description:'Писатель',blocks:[]}];
 assert.equal(fanficCast(p)[0].description,'Ирис знает Алексей.');assert.equal(fanficCast(p)[1].role,'persona');
});
test('Compacted records remain valid JSON and keep relevant old memory alongside recent events',()=>{
 const records=Array.from({length:30},(_,n)=>({...memory('m'+n,n,'Длинная сводка '.repeat(600)),retrievalScore:n===0?.99:.1}));
 const packed=packReference(records,1000,{tail:true}),value=JSON.parse(packed.text);
 assert.ok(packed.text.length<=1000);assert.ok(value.some(d=>d.id==='m0'));assert.ok(value.some(d=>d.id==='m29'));assert.ok(value.every(d=>d.title&&d.summary));
});
test('Long fanfic context has intact reference sections, actual inclusion IDs and preserves the scene tail',()=>{
 const p=project();p.characters=[{id:'c',name:'Ирис',description:'Героиня '.repeat(6000),blocks:[]}];
 const result=buildFanficMessages({project:p,episode:{id:'next',season:2,number:1,brief:'Вернуться в башню',editorMessages:[]},connection:{contextWindow:2048},memories:[memory('old',1,'Старое событие '.repeat(2000))],currentText:'Проза '.repeat(10000)+'ПОСЛЕДНЯЯ_ФРАЗА'});
 const parts=result.messages[1].content.split(/\n\n(?=[A-Z])/);
 for(const part of parts.filter(p=>!p.startsWith('CURRENT PROSE')))assert.doesNotThrow(()=>JSON.parse(part.slice(part.indexOf(':\n')+2)));
 assert.ok(result.tokens+result.maxTokens+100<=2048);assert.match(result.messages[1].content,/ПОСЛЕДНЯЯ_ФРАЗА/);assert.deepEqual(result.included.cast,['c']);
});


test('Canonical metadata requires source sentence references and rejects invented evidence IDs',()=>{
 const prose='Ирис встретила Эльдора. Он дал ей печать. Она обещала открыть ворота.';
 const raw={summary:'Ирис получила печать.',location:'Выдуманный храм',relationships:['Ирис доверяет Эльдору.'],openThreads:['Восстановить храм.'],summaryEvidence:[2],locationEvidence:0,relationshipEvidence:[1],openThreadEvidence:[0]};
 const memory=validateMemory(raw,prose);assert.equal(memory.location,'');assert.deepEqual(memory.openThreads,[]);assert.equal(memory.evidence.summary[0],'Он дал ей печать.');
 assert.throws(()=>validateMemory({...raw,summaryEvidence:[99]},prose),/номер/);
 assert.throws(()=>validateMemory({...raw,summaryEvidence:['fake quote']},prose),/номер/);
});

test('Memory schemas bound evidence output and runtime rejects exhaustive sentence-ID lists',()=>{
 const properties=fanficMemorySchema.properties;assert.equal(properties.summaryEvidence.minItems,1);assert.equal(properties.summaryEvidence.maxItems,8);
 for(const name of ['relationships','openThreads','relationshipEvidence','openThreadEvidence'])assert.equal(properties[name].maxItems,20);
 const prose=Array.from({length:9},(_,i)=>`Ирис записала событие ${i+1}.`).join(' ');
 const raw={summary:'Ирис записала события.',location:'',relationships:[],openThreads:[],summaryEvidence:Array.from({length:9},(_,i)=>i+1),locationEvidence:0,relationshipEvidence:[],openThreadEvidence:[]};
 assert.throws(()=>validateMemory(raw,prose),/от 1 до 8/);assert.equal(validateMemory({...raw,summaryEvidence:[1,9]},prose).evidence.summary.length,2);
});

test('Fanfic strips standalone model commentary and end markers while preserving literary dialogue and dividers',()=>{
 assert.equal(cleanFanficProse('Ирис открыла ворота.\n\nСцена завершена.\n\n---\n\nThis text is a continuation of the narrative.'),'Ирис открыла ворота.');
 assert.equal(cleanFanficProse('Ирис открыла ворота.[SAS_SCENE_END]Extra commentary'),'Ирис открыла ворота.');
 const story='— Сцена завершена, — пошутил режиссёр.\n\n---\n\nИрис вышла на улицу.';
 assert.equal(cleanFanficProse(story),story);assert.equal(fanficStops.length,4);
});

test('A zero-sized tail budget emits no hidden full prose',()=>{
 assert.equal(clip('Секретная длинная серия.',0,true),'');assert.equal(clip('Секрет',-1,true),'');assert.equal(clip('Секрет',0),'');
});

test('A long current episode retrieves its own earlier source and never promotes it to canonical memory',async()=>{
 const p=project();p.lorebooks=[];p.settings.vectorMemory=false;
 const episode={id:'current',brief:'Ирис вспоминает шифр'};
 const prose='Ирис получила пароль САПФИР-731.\n\n'+('Друзья пересекали зал. '.repeat(500))+'ПОСЛЕДНЯЯ_СТРОКА.';
 const result=await resolveFanficContext({state:{chats:[{summary:'RP_SECRET'}],fanficProjects:[{id:'foreign',episodes:[{content:'FOREIGN_SECRET'}]}]},project:p,episode,memories:[],currentText:prose,instructions:'Вспомни пароль САПФИР-731',signal:new AbortController().signal});
 assert.deepEqual(result.memories,[]);assert.ok(result.draft.some(d=>d.content.includes('САПФИР-731')));assert.ok(result.draft.every(d=>d.episodeId===episode.id&&prose.slice(d.start,d.end)===d.content));
 assert.ok(result.draft.length<=6);assert.ok(!JSON.stringify(result).includes('FOREIGN_SECRET'));assert.ok(!JSON.stringify(result).includes('RP_SECRET'));
 const prompt=buildFanficMessages({project:p,episode,connection:{contextWindow:8192},...result,currentText:prose,instructions:'Вспомни пароль САПФИР-731',purpose:'continue'});
 assert.match(prompt.messages[1].content,/САПФИР-731/);assert.match(prompt.messages[1].content,/ПОСЛЕДНЯЯ_СТРОКА/);assert.deepEqual(prompt.included.memory,[]);assert.ok(prompt.included.draft.length);
 const source=fanficDraftSources(p,episode,prose);assert.equal(source.map(d=>d.content).join(''),prose);assert.ok(source.every(d=>!/[\uD800-\uDBFF]$/.test(d.content)));
});

test('Current-draft vector retrieval is bounded and falls back to its own source after encoder failure',async()=>{
 const p=project();p.lorebooks=[];
 const episode={id:'current',brief:'Вернись к улике'},prose='Улика: БОРЕЙ-991.\n\n'+('Герои беседовали о путешествии.\n\n'.repeat(3000));
 let count=0;const result=await resolveFanficContext({state:encoderState(),project:p,episode,memories:[],currentText:prose,instructions:'Где нашли улику БОРЕЙ-991?',embeddings:{vectors:async(_s,values)=>{count=values.length;throw new Error('Encoder offline');}},signal:new AbortController().signal});
 assert.ok(count<=25);assert.equal(result.report.vectorStatus,'fallback');assert.ok(result.draft.some(d=>d.content.includes('БОРЕЙ-991')));assert.ok(result.report.warnings.length);assert.deepEqual(result.memories,[]);
});

test('A 1024-token local context preserves the latest instruction and prose tail instead of dropping the request',()=>{
 const p=project();p.lorebooks=[];const request='Ирис произносит код САПФИР-731.';
 const result=buildFanficMessages({project:p,episode:{season:1,number:1,brief:'Открой ворота.'},connection:{contextWindow:1024},instructions:request,currentText:'Предыстория. '.repeat(5000)+'ПОСЛЕДНИЙ_ХВОСТ.',purpose:'continue'});
 assert.ok(result.tokens+result.maxTokens+100<=1024);assert.match(result.messages[1].content,/САПФИР-731/);assert.match(result.messages[1].content,/ПОСЛЕДНИЙ_ХВОСТ/);
});

test('Memory chunks account for sentence-ID JSON overhead at short local contexts without losing any source',()=>{
 const prose='Ирис вошла. Гость ждал. Они взяли ключ.\n\n'.repeat(90),episode={season:1,number:1,title:'Башня'};
 for(const limit of [1024,1536,2048,8192]){
  const budget=Math.max(256,Math.min(850,Math.floor(limit/5))),parts=splitFanficMemory(prose,episode,limit,budget);assert.equal(parts.join(''),prose);assert.ok(parts.length);
  for(let i=0;i<parts.length;i++){
   const blocks=(parts[i].match(/[\s\S]+?(?:[.!?](?:\s+|$)|\n\n|$)/g)||[parts[i]]).filter(Boolean).map((text,index)=>({id:index+1,text}));
   const messages=[{role:'system',content:fanficMemoryInstructions},{role:'user',content:JSON.stringify({episode:'Сезон 1 · эпизод 1 · Башня',part:i+1,totalParts:parts.length,prose:blocks})}];
   assert.ok(messageTokens(messages)+budget+160<=limit,`part ${i} at context ${limit}`);
  }
 }
});

test('Native multilingual token counts repack reference JSON without losing an old clue or the latest prose tail',async()=>{
 const p=project();p.lorebooks=[];p.settings.maxTokens=600;p.characters=[{id:'hero',name:'Ирис',description:'Героиня '.repeat(1200),blocks:[]}];
 const episode={id:'current',season:2,number:1,brief:'Вернуться в башню.'},memories=Array.from({length:12},(_,i)=>({...memory('m'+i,i,'Сведения о городе. '.repeat(120)),retrievalScore:i===0?.99:.1}));memories[0].summary='Пароль старых ворот САПФИР-731. '+memories[0].summary;
 let counts=0;const connection={id:'sas-local',contextWindow:8192};
 const countTokens=async(_connection,_secret,messages,options)=>{counts++;assert.equal(options.adaptInstruction,true);return Math.ceil(messages.map(m=>m.content).join('').length/1.7)+80;};
 const result=await prepareFanficMessages({project:p,episode,connection,memories,instructions:'Ирис произнесла САПФИР-731.',currentText:'Проза '.repeat(7000)+'ПОСЛЕДНИЙ_ХВОСТ.',purpose:'continue'},{countTokens});
 assert.ok(counts>1);assert.equal(result.tokenizer,'model');assert.ok(result.actualTokens+result.maxTokens+260<=8192);assert.match(result.messages[1].content,/САПФИР-731/);assert.match(result.messages[1].content,/ПОСЛЕДНИЙ_ХВОСТ/);assert.ok(result.included.memory.includes('m0'));
 for(const part of result.messages[1].content.split(/\n\n(?=[A-Z])/).filter(part=>!part.startsWith('CURRENT PROSE')))assert.doesNotThrow(()=>JSON.parse(part.slice(part.indexOf(':\n')+2)));
});

test('Native memory fitting preserves every source character with a tokenizer that uses more tokens than chars/3',async()=>{
 const prose='Ирис нашла печать. Она записала пароль.\n\n'.repeat(70),episode={season:1,number:1},connection={id:'sas-local',contextWindow:2048};let calls=0;
 const countTokens=async(_c,_s,messages,options)=>{calls++;assert.equal(options.adaptInstruction,true);return Math.ceil(messages.map(m=>m.content).join('').length/1.5)+20;};
 const parts=await splitFanficMemoryForModel(prose,episode,connection,400,{countTokens});assert.equal(parts.join(''),prose);assert.ok(parts.length>splitFanficMemory(prose,episode,2048,400).length);assert.ok(calls>=parts.length);
});

test('External connections skip native tokenizer routes and native fitting retries are bounded',async()=>{
 const p=project();p.lorebooks=[];const options={project:p,episode:{season:1,number:1,brief:'Событие.'},connection:{id:'external',contextWindow:2048}};
 const external=await prepareFanficMessages(options,{countTokens:async()=>{throw Error('Must not call native tokenizer for API');}});assert.equal(external.actualTokens,null);
 let calls=0;await assert.rejects(prepareFanficMessages({...options,connection:{id:'sas-local',contextWindow:2048}},{countTokens:async()=>{calls++;return 100000;}}),/не помещаются/);assert.equal(calls,7);
});

test('Curated fanfic lore only uses an explicit encoder once project memory is enabled and remains searchable by exact keys',async()=>{
 const p=project(),episode={id:'next',brief:'Вечером героиня ищет путь.'};
 p.lorebooks[0].entries=[{id:'curated',name:'Служебная сеть',content:'Короткое служебное окно доступно только через диспетчера.',keys:['диспетчерская сеть'],vectorWhenMemory:true}];
 p.settings.vectorMemory=false;
 let calls=0;
 const embeddings={vectors:async(_state,texts)=>{calls++;return texts.map(()=>[1,0]);}};
 const opts={project:p,episode,embeddings,state:encoderState(),instructions:'Как незаметно связаться с постом? '};
 assert.equal((await resolveFanficContext(opts)).report.vectorStatus,'disabled');
 assert.equal(calls,0);
 p.settings.vectorMemory=true;
 const state={settings:{embeddings:{connectionId:''}},activeConnectionId:'writer',connections:[{id:'writer',model:'mock-writer',baseUrl:'http://127.0.0.1:1/v1'}]};
 const lexical=await resolveFanficContext({...opts,state,instructions:'Нужна диспетчерская сеть.'});
 assert.equal(lexical.report.vectorStatus,'fallback');
 assert.equal(lexical.lore[0].reason,'keyword');
 assert.equal(calls,0,'A writing provider must never become the embedding model implicitly');
 const semantic=await resolveFanficContext(opts);
 assert.equal(semantic.report.vectorStatus,'ready');
 assert.equal(semantic.lore[0].reason,'vector');
 assert.equal(calls,1);
});

test('Compact fanfic lore retains a specific current alias next to a constant despite crowded opening keywords',async()=>{
 const p=project();
 p.settings.maxTokens=340;
 const text='Связная запись с условиями этой сцены. '.repeat(10);
 p.lorebooks[0].entries=[
   {id:'constant',name:'Условия',content:text,constant:true,priority:70},
   {id:'constant-2',name:'Оговорки',content:text,constant:true,priority:65},
   ...Array.from({length:20},(_,i)=>({id:'generic-'+i,name:'Запись '+i,content:text,keys:['Асуна'],priority:60})),
   {id:'focused',name:'Особая записка',content:'Точная улика: ЧАСЫ-813. '+text,keys:['личное устройство Augma'],priority:10}
 ];
 const episode={id:'current',season:1,number:2,brief:'Асуна вспоминает вчерашний путь. '.repeat(21)};
 const instructions='Асуна открывает личное устройство AUGMA и проверяет код.';
 const context=await resolveFanficContext({state:{},project:p,episode,instructions});
 assert.equal(context.lore[2].id,'own-book:focused');
 for(const contextWindow of [2048,4096]){
   const result=await prepareFanficMessages({project:p,episode,connection:{id:'sas-local',contextWindow},instructions,...context},{countTokens:async(_c,_s,messages)=>Math.ceil(messages.map(m=>m.content).join('').length/2.1)+16});
   assert.ok(result.included.lore.includes('own-book:constant'));
   assert.ok(result.included.lore.includes('own-book:focused'));
   assert.ok(result.actualTokens+result.maxTokens+260<=contextWindow);
   assert.match(result.messages[1].content,/ЧАСЫ-813/u);
 }
 const rewrite=buildFanficMessages({project:p,episode,connection:{contextWindow:4096},instructions,purpose:'rewrite',selectedText:'Асуна смотрит на часы.',...context});
 assert.ok(rewrite.included.lore.includes('own-book:focused'));
 assert.match(rewrite.messages[1].content,/ЧАСЫ-813/u);
});

test('Archive fanfic query keeps the latest clue ahead of a long starter brief and isolates earlier approved prose',async()=>{
 const p=project();
 p.settings={...p.settings,archiveMemory:true,memoryThreshold:.4};
 p.lorebooks[0].entries=[{id:'exact',name:'Печать',content:'Порядок передачи подтверждает именно владелец. EXACT_LORE_KEY',keys:['серебряная печать'],vectorWhenMemory:true}];
 const clue='Серебряная печать была спрятана под третьей каменной ступенью.';
 const earlier={id:'earlier',status:'approved',season:1,number:1,content:clue};
 earlier.memory={sourceHash:contentHash(earlier.content),summary:'Героиня осмотрела зал.'};
 const future={id:'future',status:'approved',season:1,number:4,content:'Серебряная печать была перенесена. FUTURE_FANFIC_TOKEN'};
 future.memory={sourceHash:contentHash(future.content),summary:'Следующий день.'};
 const draft={id:'draft',status:'draft',season:1,number:2,content:'Серебряная печать в башне. DRAFT_FANFIC_TOKEN'};
 const brief=Array.from({length:37},(_,i)=>'стартовая-подробность-'+i).join(' ');
 const episode={id:'current',season:1,number:3,brief,content:''};
 p.episodes=[earlier,draft,episode,future];
 const instructions='Где спрятана серебряная печать? Напомни место.';
 const calls=[];
 const opts={state:encoderState({fanficProjects:[{id:'foreign',episodes:[{content:'Серебряная печать FOREIGN_FANFIC_TOKEN'}]}]}),project:p,episode,memories:approvedMemories(p,episode),instructions,
   embeddings:{vectors:async(_s,texts)=>{calls.push(texts);return texts.map(value=>/печать/iu.test(value)?[1,0]:[0,1]);}}};
 const result=await resolveFanficContext(opts);
 assert.equal(result.report.archiveRecall.scope,'fanfic:'+p.id);
 assert.equal(result.report.vectorStatus,'ready');
 assert.match(calls[0][0],/серебряная печать/iu);
 assert.ok(calls.every(batch=>batch.length<=25));
 assert.ok(result.archive.some(entry=>entry.episodeId==='earlier'&&entry.excerpt.includes('третьей каменной ступенью')));
 assert.deepEqual(result.lore.map(item=>item.id),['own-book:exact']);
 assert.doesNotMatch(calls.flat().join(' '),/DRAFT_FANFIC_TOKEN|FUTURE_FANFIC_TOKEN|FOREIGN_FANFIC_TOKEN|EXACT_LORE_KEY/u);
 const prompt=await prepareFanficMessages({project:p,episode,connection:{id:'sas-local',contextWindow:4096},instructions,...result},{countTokens:async(_c,_s,messages)=>Math.ceil(messages.map(m=>m.content).join('').length/2.1)+16});
 assert.match(prompt.messages[1].content,/третьей каменной ступенью/);
 assert.doesNotMatch(prompt.messages[1].content,/DRAFT_FANFIC_TOKEN|FUTURE_FANFIC_TOKEN|FOREIGN_FANFIC_TOKEN/u);
 const fallback=await resolveFanficContext({...opts,embeddings:{vectors:async()=>{throw Error('offline');}}});
 assert.equal(fallback.report.vectorStatus,'fallback');
 assert.ok(fallback.archive.some(entry=>entry.episodeId==='earlier'));
 assert.ok(fallback.lore.some(entry=>entry.id==='own-book:exact'));
});

test('Local structured fanfic edits retain only selected source, use scoped references once, and fall back when exact context is full',async()=>{
 const run=async rejectReferences=>{
   const selected='Дежурный спрятал серебряную печать. '.repeat(13).trimEnd();
   const authored='Префикс вне выделения. '+selected+' Суффикс вне выделения.';
   const state=encoderState();
   state.activeConnectionId='sas-local';state.connections.unshift({id:'sas-local',contextWindow:2048,model:'mock-writer',baseUrl:'http://127.0.0.1:1/v1'});
   const p=normalizeFanficProject({title:'Правка лора',settings:{vectorMemory:true,continuityCheck:false,maxTokens:300},lorebooks:[{id:'ward',name:'Стража',entries:[{id:'seal',name:'Печать',content:'Печать переходила только по записи в журнале. LORE_SEAL',keys:['серебряная печать'],vectorWhenMemory:true}]}],episodes:[
     {number:1,title:'Правило',content:'Смотритель открыл хранилище ключом. EARLIER_CONTEXT'},
     {number:2,title:'Правка',content:authored},
     {number:3,title:'Дальше',content:'Печать пропала. FUTURE_CONTEXT'}
   ]},state,{importing:true});
   p.settings.connectionId='sas-local';
   const [earlier,current,future]=p.episodes;
   for(const entry of [earlier,future]){entry.status='approved';entry.memory={sourceHash:contentHash(entry.content),summary:entry.content};}
   state.fanficProjects=[p,{id:'other',episodes:[{content:'Серебряная печать FOREIGN_CONTEXT'}]}];
   let snapshot=state,taskPromise,encoding=0;
   const tasks=createTasks(),originalRun=tasks.run;
   tasks.run=(...args)=>{const task=originalRun(...args);taskPromise=task.promise;return task;};
   const sent=[],tokenized=[];
   const fanfic=createFanfic({getState:()=>structuredClone(snapshot),saveState:next=>{snapshot=structuredClone(next);},getSecret:()=>'',tasks,
     embeddings:{vectors:async(_s,texts)=>{encoding++;return texts.map(()=>[1,0]);}},
     countTokens:async(_c,_s,messages)=>{
       const data=JSON.parse(messages[1].content);tokenized.push(data);
       return data.source.length>230||rejectReferences&&data.reference?3900:450;
     },structured:async args=>{sent.push(args.context);return args.parse({replacement:args.context.source.replaceAll('спрятал','укрыл')});}});
   const selectionStart=authored.indexOf(selected),selectionEnd=selectionStart+selected.length;
   fanfic.generate(p.id,current.id,{action:'rewrite',instructions:'Смягчи описание. Лор: серебряная печать.',selectionStart,selectionEnd,expectedRevision:current.revision});
   await taskPromise;
   assert.ok(sent.length>1,'The exact tokenizer has to split the selected source');
   assert.equal(encoding,1,'Precomputed references must not re-encode each split');
   assert.ok(tokenized.some(data=>data.reference));
   assert.ok(sent.every(data=>data.source.length<=230));
   assert.equal(sent.map(data=>data.source).join(''),selected);
   assert.equal(fanfic.read(p.id,current.id).episode.content,authored.slice(0,selectionStart)+selected.replaceAll('спрятал','укрыл')+authored.slice(selectionEnd));
   const transmitted=JSON.stringify(sent);
   assert.doesNotMatch(transmitted,/Префикс вне выделения|Суффикс вне выделения|FUTURE_CONTEXT|FOREIGN_CONTEXT/u);
   if(rejectReferences){
     assert.ok(sent.every(data=>!data.reference));
   }else{
     assert.match(transmitted,/LORE_SEAL/u);
     assert.match(transmitted,/EARLIER_CONTEXT/u);
   }
 };
 await run(false);
 await run(true);
});

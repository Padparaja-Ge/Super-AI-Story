import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFanficLore,resolveFanficContext,packReference,fanficCast,clip,fanficDraftSources} from '../server/fanfic-context.mjs';
import {buildFanficMessages,prepareFanficMessages,validateMemory,splitFanficMemory,splitFanficMemoryForModel,fanficMemoryInstructions,fanficMemorySchema} from '../server/fanfic.mjs';
import {messageTokens} from '../server/prompt.mjs';
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
 let inputs;const result=await resolveFanficContext({state:{fanficProjects:[{id:'other',memory:'ЧУЖОЙ_СЕКРЕТ'}],chats:[{content:'ЧУЖОЙ_ЧАТ'}]},project:p,episode:{id:'next',brief:'Найти печать'},memories:docs,embeddings:{vectors:async(_s,texts)=>{inputs=texts;return [[1,0],[1,0],[0,1],[0,1],[0,1],[1,0]];}},signal:new AbortController().signal});
 assert.match(inputs[1],/САПФИР_В_КОНЦЕ/);assert.match(inputs[1],/БОРЕЙ-817/);assert.ok(!inputs.join().includes('ЧУЖОЙ'));assert.ok(!inputs.join().includes('НЕСВЯЗАННЫЙ_ЛОР'));
 assert.deepEqual(result.memories.map(d=>d.id),['old','recent1','recent2']);assert.equal(result.report.vectorStatus,'ready');assert.equal(result.report.selectedLore.find(d=>d.id==='own-book:vector').reason,'vector');
});
test('Vector lore works independently of the memory switch; embedding failure falls back without importing other data',async()=>{
 const p=project();p.settings.vectorMemory=false;
 const result=await resolveFanficContext({state:{},project:p,episode:{id:'next',brief:'башня'},memories:[memory('old',1,'Свой факт')],embeddings:{vectors:async()=>{throw new Error('unavailable');}},signal:new AbortController().signal});
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
 let count=0;const result=await resolveFanficContext({state:{},project:p,episode,memories:[],currentText:prose,instructions:'Где нашли улику БОРЕЙ-991?',embeddings:{vectors:async(_s,values)=>{count=values.length;throw new Error('Encoder offline');}},signal:new AbortController().signal});
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

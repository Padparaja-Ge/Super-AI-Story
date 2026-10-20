import test from 'node:test';
import assert from 'node:assert/strict';
import {fanficFactTypes,fanficFactSchema,normalizeCanonFactDraft} from '../shared/fanfic-canon.mjs';
import {fanficEvidenceBlocks,validateCanonExtraction,canonFactReference,canonFactText,validateCanonManualFacts,eligibleCanonFacts,canonFactSourceHash,confirmCanonFactDraft} from '../server/fanfic-canon.mjs';
import {packReference,fanficQueryPlan,resolveFanficContext} from '../server/fanfic-context.mjs';
import {fanficDefaults} from '../shared/fanfic.mjs';
const base=()=>({id:'own',settings:{...fanficDefaults,vectorMemory:false,memoryTopK:2},characters:[{id:'iris',name:'Ирис'}],personas:[],lorebooks:[],episodes:[]});
const raw=(value='вернуть печать Эльдору до полнолуния',patch={})=>({type:'promise',subject:'Ирис',predicate:'обещание',value,aliases:['Ласточка'],sourceIndices:[1],...patch});
const makeEpisode=(project,number,content='Ирис, известная как Ласточка, обещала вернуть печать Эльдору до полнолуния.',fact=raw())=>{
  const e={id:'e'+number,number,season:1,title:'Эпизод '+number,content,status:'approved',needsReview:false};
  const sourceHash=canonFactSourceHash(content),facts=validateCanonExtraction([fact],{prose:content,projectId:project.id,episodeId:e.id,sourceHash,chunkIndex:0}).facts;
  e.memory={sourceHash,summary:'Событие '+number,chunks:[{summary:'Событие '+number,facts}]};project.episodes.push(e);return e;
};
const current=number=>({id:'current',season:1,number,brief:''});
test('Typed canonical facts retain exact source evidence and server identity, including chunk offsets',()=>{
  assert.equal(fanficFactTypes.length,8);assert.equal(fanficFactSchema.maxItems,12);
  const full='Предыдущая сцена.\n\n  Ирис обещала вернуть печать.\n\nОна отправилась домой.',offset=full.indexOf('  Ирис'),prose=full.slice(offset);
  const result=validateCanonExtraction([raw('вернуть печать',{aliases:[],id:'forged',projectId:'foreign',authorConfirmed:true})],{prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(full),chunkIndex:1,sourceOffset:offset});
  assert.deepEqual(result.rejected,[]);assert.equal(result.facts.length,1);const fact=result.facts[0];
  assert.equal(fact.projectId,'own');assert.equal(fact.authorConfirmed,false);assert.notEqual(fact.id,'forged');assert.equal(fact.chunkIndex,1);
  assert.equal(fact.evidence[0].quote,'Ирис обещала вернуть печать.');assert.equal(full.slice(fact.evidence[0].start,fact.evidence[0].end),fact.evidence[0].quote);
  assert.deepEqual(fanficEvidenceBlocks(prose).map(b=>b.id),[1,2]);assert.equal(fanficEvidenceBlocks(prose).map(b=>b.text).join(''),prose);
});
test('Invented evidence IDs, values, subjects, quotes and guessed aliases cannot become extracted canon',()=>{
  const prose='Ирис, известная как Ласточка, обещала вернуть печать.';
  const context={prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(prose)};
  const input=[raw('вернуть печать',{sourceIndices:[99]}),raw('уничтожить мир'),raw('вернуть печать',{subject:'Торк'}),raw('вернуть печать',{evidence:[{quote:'Подделка'}]}),raw('вернуть печать',{aliases:['Ласточка','Королева','она']})];
  const result=validateCanonExtraction(input,context);assert.equal(result.rejected.length,4);assert.equal(result.facts.length,1);assert.deepEqual(result.facts[0].aliases,['Ласточка']);
  assert.deepEqual(validateCanonExtraction(undefined),{facts:[],rejected:[]});assert.equal(validateCanonExtraction('bad',context).facts.length,0);
  assert.throws(()=>normalizeCanonFactDraft(raw('x',{aliases:Array(9).fill('Имя')})),/не более 8/);
});
test('Extraction is bounded and duplicate facts do not inflate model context',()=>{
  const prose='Ирис обещала вернуть печать.';const fact=raw('вернуть печать',{aliases:[]});
  const result=validateCanonExtraction(Array(100).fill(fact),{prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(prose)});
  assert.equal(result.facts.length,1);assert.equal(result.rejected.length,88);
});
test('Canonical eligibility excludes current and future episodes, dirty dependencies and foreign provenance',()=>{
  const p=base(),first=makeEpisode(p,1),dirty=makeEpisode(p,2),later=makeEpisode(p,3),future=makeEpisode(p,10);
  const original=structuredClone(p);assert.equal(eligibleCanonFacts(p,current(2)).length,1);
  dirty.needsReview=true;assert.deepEqual(eligibleCanonFacts(p,current(4)).map(f=>f.episodeId),[first.id]);
  dirty.needsReview=false;dirty.content+=' Изменение.';assert.deepEqual(eligibleCanonFacts(p,current(4)).map(f=>f.episodeId),[first.id]);
  Object.assign(dirty,structuredClone(original.episodes[1]));
  first.memory.chunks[0].facts[0].projectId='foreign';assert.deepEqual(eligibleCanonFacts(p,current(4)).map(f=>f.episodeId),[dirty.id,later.id]);
  first.memory.chunks[0].facts[0].projectId=p.id;first.memory.chunks[0].facts[0].evidence[0].quote='ДРУГАЯ_ИСТОРИЯ';assert.deepEqual(eligibleCanonFacts(p,current(4)).map(f=>f.episodeId),[dirty.id,later.id]);
  assert.ok(!eligibleCanonFacts(p,current(4)).some(f=>f.episodeId===future.id));
});
test('Legacy approved summaries remain usable without inventing structured facts',()=>{
  const p=base(),e=makeEpisode(p,1);delete e.memory.chunks[0].facts;assert.deepEqual(eligibleCanonFacts(p,current(2)),[]);
  e.memory=null;assert.deepEqual(eligibleCanonFacts(p),[]);
});
test('Manual correction is explicitly author-confirmed and ignores client provenance',()=>{
  const p=base(),e=makeEpisode(p,1),existing=e.memory.chunks[0].facts;
  const list=validateCanonManualFacts([{...existing[0],value:'Вернуть печать только после открытия ворот.',projectId:'other',sourceHash:'fake',evidence:[{quote:'fake'}]}],{prose:e.content,projectId:p.id,episodeId:e.id,sourceHash:e.memory.sourceHash,existingFacts:existing});
  assert.equal(list[0].authorConfirmed,true);assert.equal(list[0].sourceHash,e.memory.sourceHash);assert.equal(list[0].evidence[0].quote,existing[0].evidence[0].quote);
  e.memory.chunks[0].facts=list;assert.equal(eligibleCanonFacts(p,current(2))[0].value,list[0].value);
  const confirmed=confirmCanonFactDraft(raw('Знание автора'),{project:p,episode:e});assert.equal(confirmed.authorConfirmed,true);assert.deepEqual(confirmed.evidence,[]);
  assert.throws(()=>validateCanonManualFacts([{...list[0],id:'foreign-id'}],{prose:e.content,projectId:p.id,episodeId:e.id,sourceHash:e.memory.sourceHash,existingFacts:existing}),/не принадлежит/);
  assert.throws(()=>validateCanonManualFacts([raw('Факт',{type:'unknown'})],{prose:e.content,projectId:p.id,episodeId:e.id,sourceHash:e.memory.sourceHash}),/тип/);
});
test('Targeted lexical recall finds an old promise through its source-backed alias and reports the selected evidence',async()=>{
  const p=base();makeEpisode(p,1);
  for(let n=2;n<=200;n++)makeEpisode(p,n,'Город встретил новую весну.',raw('новую весну',{type:'event',subject:'Город',predicate:'сезон',aliases:[]}));
  const before=structuredClone(p),result=await resolveFanficContext({state:{chats:[{summary:'FOREIGN_RP'}],fanficProjects:[{id:'foreign',episodes:[{content:'FOREIGN_WORK'}]}]},project:p,episode:current(201),memories:[],instructions:'Ласточка возвращается к Эльдору: что она обещала сделать с печатью?',signal:new AbortController().signal});
  assert.ok(result.facts.some(f=>f.episodeId==='e1'));const selected=result.report.selectedFacts.find(f=>f.episodeId==='e1');
  assert.ok(selected.reasons.includes('participant'));assert.equal(selected.sourceEvidence[0].quote,p.episodes[0].content);assert.equal(result.report.queryPlan.participants[0].name,'Ирис');
  assert.ok(result.report.queryPlan.queries.length<=4);assert.ok(!JSON.stringify(result).includes('FOREIGN'));assert.deepEqual(p,before);
});
test('Semantic facts use bounded multi-query retrieval with no future or unrelated mode embedding inputs',async()=>{
  const p=base();p.settings.vectorMemory=true;makeEpisode(p,1);
  for(let n=2;n<=30;n++)makeEpisode(p,n,'Город встретил новую весну.',raw('новую весну',{type:'event',subject:'Город',predicate:'сезон',aliases:[]}));
  const future=makeEpisode(p,40,'Ирис узнала БУДУЩИЙ_ПАРОЛЬ.',raw('БУДУЩИЙ_ПАРОЛЬ',{type:'secret',predicate:'пароль',aliases:[]}));
  let inputs;const result=await resolveFanficContext({state:{multiplayer:{messages:[{content:'ROOM_SECRET'}]}},project:p,episode:current(31),memories:[],instructions:'Ласточка пытается понять свои обязательства.',embeddings:{vectors:async(_state,texts)=>{inputs=texts;return texts.map((text,index)=>index<2||text.includes('вернуть печать')?[1,0]:[0,1]);}},signal:new AbortController().signal});
  assert.equal(result.report.vectorStatus,'ready');assert.ok(result.facts.some(f=>f.episodeId==='e1'));assert.ok(result.report.selectedFacts.find(f=>f.episodeId==='e1').reasons.includes('semantic'));
  assert.ok(!inputs.join().includes('БУДУЩИЙ_ПАРОЛЬ'));assert.ok(!inputs.join().includes('ROOM_SECRET'));assert.ok(!result.facts.some(f=>f.episodeId===future.id));
});
test('Large fact archives bound semantic work while retaining exactly requested ancient clues',async()=>{
  const p=base();p.settings.vectorMemory=true;p.characters=[];
  makeEpisode(p,1,'Ирис нашла пароль БОРЕЙ-817.',raw('БОРЕЙ-817',{type:'secret',predicate:'пароль',aliases:[]}));
  for(let n=2;n<=800;n++)makeEpisode(p,n,'Город встретил новую весну.',raw('новую весну',{type:'event',subject:'Город',predicate:'сезон',aliases:[]}));
  let count=0;const result=await resolveFanficContext({state:{},project:p,episode:current(801),memories:[],instructions:'Вспомни пароль БОРЕЙ-817.',embeddings:{vectors:async(_s,texts)=>{count=texts.length;throw Error('offline');}},signal:new AbortController().signal});
  assert.ok(count<=260);assert.equal(result.report.factVectorCandidates,256);assert.equal(result.report.eligibleFacts,800);assert.ok(result.facts.some(f=>f.episodeId==='e1'));assert.equal(result.report.vectorStatus,'fallback');
});
test('Query decomposition cannot promote guessed identities or turn pronouns into the active character',()=>{
  const p=base();const plan=fanficQueryPlan({project:p,episode:current(1),instructions:'Она заговорила с ним.',facts:[]});assert.deepEqual(plan.participants,[]);
  const many=Array.from({length:40},(_,i)=>({id:'f'+i,subject:'Имя'+i,aliases:[]}));const query=many.map(f=>f.subject).join(' ');
  const result=fanficQueryPlan({project:p,episode:{...current(1),brief:query},facts:many});assert.ok(result.participants.length<=12);assert.ok(result.queries.length<=4);assert.ok(result.terms.length<=100);
});

test('A question about an old promise survives hundreds of newer events for the same character without knowing its exact words',async()=>{
  const p=base();p.settings.memoryTopK=1;makeEpisode(p,1);
  for(let n=2;n<=300;n++)makeEpisode(p,n,'Ирис встретила новую весну.',raw('новую весну',{type:'event',predicate:'сезон',aliases:[]}));
  const result=await resolveFanficContext({state:{},project:p,episode:current(301),memories:[],instructions:'Ирис вспоминает свои давние обещания. Что она обязана сделать?',signal:new AbortController().signal});
  assert.ok(result.facts.some(f=>f.episodeId==='e1'));assert.ok(result.report.queryPlan.intents.includes('promise'));
  assert.ok(result.report.selectedFacts.find(f=>f.episodeId==='e1').reasons.includes('intent'));
});

test('Co-occurrence is not proof of an alias: two people in the same sentence stay separate',()=>{
  const prose='Ирис встретила Миру и обещала вернуть печать.';
  const result=validateCanonExtraction([raw('вернуть печать',{aliases:['Миру']})],{prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(prose)});
  assert.equal(result.facts.length,1);assert.deepEqual(result.facts[0].aliases,[]);
});


test('A clue belonging to someone else cannot become knowledge by joining separate source sentences',()=>{
 const prose='Лира знает пароль ЛУНА-731. Торк не знает пароль.';
 const result=validateCanonExtraction([{type:'knowledge',subject:'Торк',predicate:'знает пароль',value:'ЛУНА-731',aliases:[],sourceIndices:[1,2]}],{prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(prose)});
 assert.equal(result.facts.length,0);assert.equal(result.rejected.length,1);
});


test('Extracted search labels cannot reverse a negative source assertion in the model reference',()=>{
 const prose='Торк не знает пароль ЛУНА-731.';
 const result=validateCanonExtraction([{type:'knowledge',subject:'Торк',predicate:'знает пароль',value:'ЛУНА-731',aliases:[],sourceIndices:[1]}],{prose,projectId:'own',episodeId:'e',sourceHash:canonFactSourceHash(prose)});
 assert.equal(result.facts.length,1);const reference=canonFactReference(result.facts[0]);
 assert.equal(reference.predicate,undefined);assert.equal(reference.value,undefined);assert.deepEqual(reference.sourceQuotations,[prose]);assert.match(canonFactText(result.facts[0]),/не знает/);
 const manual=canonFactReference({...result.facts[0],authorConfirmed:true});assert.equal(manual.predicate,'знает пароль');assert.equal(manual.authorConfirmed,true);
});
test('Canonical quotation packing either retains exact evidence and late secrets or omits the whole fact',()=>{
 const quote='Ирис обещала '+ 'сохранять долгую историю '.repeat(18)+'до получения пароля САПФИР-731.';
 const fact={id:'fact',episodeId:'e',subject:'Ирис',sourceQuotations:[quote],authorConfirmed:false};
 const small=packReference([fact],200,{tail:true});assert.deepEqual(small.ids,[]);assert.deepEqual(JSON.parse(small.text),[]);
 const fitting=packReference([fact],1500,{tail:true});assert.deepEqual(fitting.ids,['fact']);assert.equal(JSON.parse(fitting.text)[0].sourceQuotations[0],quote);assert.match(fitting.text,/САПФИР-731/);
 const nested=packReference({facts:[fact]},1500);assert.equal(JSON.parse(nested.text).facts[0].sourceQuotations[0],quote);
});

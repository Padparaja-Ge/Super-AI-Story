import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewFanficProse,validateFanficReview,normalizeFanficReviewResult,fanficReviewReferences,fanficNumericCandidates} from '../server/fanfic-review.mjs';
import {validateCanonExtraction,eligibleCanonFacts,canonFactSourceHash} from '../server/fanfic-canon.mjs';
const issue=(id='fact')=>({type:'number',severity:'warning',message:'Пароль отличается.',evidenceIndices:[1],factIds:[id],suggestion:'Проверьте намеренное изменение.'});
const connection={id:'api',contextWindow:4096,model:'fixture'};
function fixture(){
 const old={id:'old',season:1,number:1,status:'approved',content:'Лира помнит пароль ЛУНА-731. Дверь закрыта.'},sourceHash=canonFactSourceHash(old.content);
 const facts=validateCanonExtraction([{type:'secret',subject:'Лира',predicate:'помнит пароль',value:'ЛУНА-731',sourceIndices:[1]}],{prose:old.content,projectId:'work',episodeId:'old',sourceHash}).facts;
 old.memory={sourceHash,summary:old.content,facts};
 const episode={id:'current',season:1,number:2,status:'draft',content:'Лира назвала пароль ЛУНА-000.'};
 const project={id:'work',settings:{generationProfiles:{stages:{review:{maxTokens:256}}}},characters:[],personas:[],lorebooks:[],episodes:[old,episode]};
 const context={facts:eligibleCanonFacts(project,episode).map(f=>({...f,retrievalScore:10})),memories:[{id:'old:0',retrievalScore:.8}],lore:[]};return {old,episode,project,context};
}
const options=(f,more={})=>({state:{connections:[connection]},project:f.project,episode:f.episode,connection,context:f.context,getSecret:()=>'',countTokens:async()=>null,...more});
test('review stamps exact quotes and absolute offsets; malformed evidence and foreign reference IDs fail',()=>{
 const prose='  Лира назвала пароль ЛУНА-000.\nТорк промолчал.',opts={prose,sourceOffset:70,references:[{id:'fact'}]},result=validateFanficReview({issues:[issue()]},opts);
 assert.equal(result[0].sourceEvidence[0].start,72);assert.equal(result[0].sourceEvidence[0].quote,'Лира назвала пароль ЛУНА-000.');assert.equal(result[0].modelAssessment,true);
 for(const bad of [{...issue(),evidenceIndices:[2.5]},{...issue(),evidenceIndices:[99]},{...issue(),factIds:['foreign']},{...issue(),factIds:[]},{...issue(),message:''}])assert.throws(()=>validateFanficReview({issues:[bad]},opts));
});
test('review revalidates normalized adapter evidence instead of trusting arrays',()=>{
 const opts={prose:'Лира назвала пароль ЛУНА-000.',sourceOffset:15,references:[{id:'fact'}]},valid=validateFanficReview({issues:[issue()]},opts);
 assert.deepEqual(normalizeFanficReviewResult(valid,opts),valid);
 for(const bad of [{...valid[0],sourceEvidence:[{...valid[0].sourceEvidence[0],start:16}]},{...valid[0],sourceEvidence:[{...valid[0].sourceEvidence[0],quote:'fake'}]},{...valid[0],evidence:['fake']},{...valid[0],factIds:['stale']},{...valid[0],sourceEvidence:[]}])assert.throws(()=>normalizeFanficReviewResult([bad],opts));
 assert.throws(()=>normalizeFanficReviewResult(valid,{...opts,prose:'Другой текст.'}));
});
test('possible contradiction is validated but never automatically edits prose or canon',async()=>{
 const f=fixture(),before=structuredClone(f),id=f.context.facts[0].id;
 const report=await reviewFanficProse(options(f,{structured:async o=>o.parse(JSON.stringify({issues:[issue(id)]}))}));
 assert.equal(report.issues.length,1);assert.equal(report.issues[0].sourceEvidence[0].quote,f.episode.content);assert.equal(report.checkedCharacters,f.episode.content.length);assert.deepEqual(f,before);
});
test('review references include accepted legacy summaries, rejecting injected and stale memory',()=>{
 const f=fixture();delete f.old.memory.facts;f.context.facts=[];f.context.memories=[{id:'old:0',summary:'TAMPERED',retrievalScore:4},{id:'foreign:0',summary:'PRIVATE_WORK',retrievalScore:99}];
 const scoped=fanficReviewReferences(f);assert.equal(scoped.references[0].id,'memory:old:0');assert.match(scoped.references[0].summary,/ЛУНА-731/);assert.doesNotMatch(JSON.stringify(scoped.references),/TAMPERED|PRIVATE_WORK/);
 f.old.content+=' Изменение.';assert.equal(fanficReviewReferences(f).references.length,0);
});
test('review source order preserves retrieval score and canonical values',()=>{
 const f=fixture(),second=validateCanonExtraction([{type:'location',subject:'Дверь',predicate:'состояние',value:'закрыта',sourceIndices:[2]}],{prose:f.old.content,projectId:'work',episodeId:'old',sourceHash:canonFactSourceHash(f.old.content)}).facts[0];f.old.memory.facts.push(second);
 f.context.facts=eligibleCanonFacts(f.project,f.episode).map((fact,i)=>({...fact,retrievalScore:i?50:1}));f.context.memories=[];
 assert.equal(fanficReviewReferences(f).references[0].id,second.id);f.context.facts[0].value='FORGED';assert.doesNotMatch(JSON.stringify(fanficReviewReferences(f).references),/FORGED/);
});
test('nested actual-tokenizer multipart review covers all text without null parts',async()=>{
 const f=fixture();f.episode.content=Array.from({length:30},(_,i)=>`Лира проверяет дверь ${i} и фонарь 🕯️. Торк ждёт.\n\n`).join('');const received=[];
 const report=await reviewFanficProse(options(f,{countTokens:async(c,s,m)=>JSON.parse(m[1].content).prose.reduce((n,b)=>n+b.text.length,0)>100?4096:1000,structured:async o=>{received.push(o.context);return o.parse('{"issues":[]}');}}));
 assert.ok(report.parts>10);assert.equal(report.checkedCharacters,f.episode.content.length);assert.equal(received.map(p=>p.prose.map(b=>b.text).join('')).join(''),f.episode.content);assert.equal(received.length,report.parts);assert.ok(received.every(p=>p.references.length));
});
test('selection review keeps positions in full episode and honest coverage scope',async()=>{
 const f=fixture(),lead='Ранняя сцена.\n\n',len=f.episode.content.length;f.episode.content=lead+f.episode.content+'\nПозже.';const range={start:lead.length,end:lead.length+len};
 const report=await reviewFanficProse(options(f,{range,structured:async o=>o.parse(JSON.stringify({issues:[issue(f.context.facts[0].id)]}))}));assert.equal(report.complete,false);assert.equal(report.scope,'selection');assert.equal(report.checkedCharacters,len);assert.equal(report.issues[0].sourceEvidence[0].start,lead.length);
});
test('model and injected evidence failures propagate without input changes',async()=>{
 const f=fixture(),before=structuredClone(f);
 await assert.rejects(reviewFanficProse(options(f,{structured:async()=>{throw new Error('Endpoint unavailable');}})),/Endpoint unavailable/);
 await assert.rejects(reviewFanficProse(options(f,{structured:async()=>[{type:'number',severity:'error',message:'bad',evidence:['fake'],sourceEvidence:[{quote:'fake',start:0,end:4}],factIds:[f.context.facts[0].id],suggestion:''}]})),/устарела/);assert.deepEqual(f,before);
});

test('reviewer retains negation and complete late clues instead of unverified extracted relation labels',()=>{
 const f=fixture();f.old.content='Торк не знает пароль '+ 'в тайной тетради '.repeat(50)+'ЛУНА-731.';
 const sourceHash=canonFactSourceHash(f.old.content),facts=validateCanonExtraction([{type:'knowledge',subject:'Торк',predicate:'знает пароль',value:'ЛУНА-731',sourceIndices:[1]}],{prose:f.old.content,projectId:'work',episodeId:'old',sourceHash}).facts;
 f.old.memory={sourceHash,summary:'Торк не знает пароль.',facts};f.context.facts=eligibleCanonFacts(f.project,f.episode).map(fact=>({...fact,retrievalScore:50}));f.context.memories=[];
 const ref=fanficReviewReferences(f).references[0];assert.equal(ref.predicate,undefined);assert.equal(ref.value,undefined);assert.deepEqual(ref.sourceQuotations,[f.old.content]);assert.match(ref.sourceQuotations[0],/не знает/);assert.match(ref.sourceQuotations[0],/ЛУНА-731/);
});
test('A missed old-debt mismatch receives a source-backed focused review without rewriting canon',async()=>{
 const f=fixture();f.old.content='Лира взяла в долг у Торка ровно 37 серебряных монет.';const sourceHash=canonFactSourceHash(f.old.content);f.old.memory={sourceHash,summary:f.old.content,facts:validateCanonExtraction([{type:'item',subject:'Лира',predicate:'взяла в долг',value:'37 серебряных монет',sourceIndices:[1]}],{prose:f.old.content,projectId:'work',episodeId:'old',sourceHash}).facts};f.episode.content='Лира сказала: «Я должна тебе ровно 99 серебряных монет с нашей прежней встречи».';f.context.facts=eligibleCanonFacts(f.project,f.episode).map(f=>({...f,retrievalScore:10}));const before=structuredClone(f),calls=[];
 const review=await reviewFanficProse(options(f,{structured:async o=>{calls.push(o);if(o.name==='fanfic_review')return o.parse('{"issues":[]}');assert.equal(o.context.numericCandidates[0].sourceAmount,37);assert.equal(o.context.numericCandidates[0].currentAmount,99);assert.equal(o.context.references.length,1);return o.parse(JSON.stringify({issues:[issue(o.context.references[0].id)]}));}}));
 assert.equal(calls.length,2);assert.equal(review.issues.length,1);assert.equal(review.issues[0].sourceEvidence[0].quote,f.episode.content);assert.deepEqual(f,before);
});
test('Numeric candidates are hints only: other currencies, absent names and explained changes are not automatic conflicts',async()=>{
 const refs=[{id:'own',kind:'fact',subject:'Лира',sourceQuotations:['Лира взяла 37 серебряных монет.']}];assert.equal(fanficNumericCandidates('Лира взяла 99 золотых монет.',refs).length,0);assert.equal(fanficNumericCandidates('Торк взял 99 серебряных монет.',refs).length,0);assert.equal(fanficNumericCandidates('Лира взяла 37 серебряных монет.',refs).length,0);assert.equal(fanficNumericCandidates('Лира потратила ещё деньги и теперь должна 99 серебряных монет.',refs).length,1);
 const f=fixture();f.old.content='Лира взяла 37 серебряных монет.';const sourceHash=canonFactSourceHash(f.old.content);f.old.memory={sourceHash,summary:f.old.content,facts:validateCanonExtraction([{type:'item',subject:'Лира',predicate:'взяла',value:'37 серебряных монет',sourceIndices:[1]}],{prose:f.old.content,projectId:'work',episodeId:'old',sourceHash}).facts};f.context.facts=eligibleCanonFacts(f.project,f.episode);f.episode.content='Лира добавила новый долг и теперь должна 99 серебряных монет.';let calls=0;const review=await reviewFanficProse(options(f,{structured:async o=>{calls++;return o.parse('{"issues":[]}');}}));assert.equal(calls,2);assert.deepEqual(review.issues,[]);
});

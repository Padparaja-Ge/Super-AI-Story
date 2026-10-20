import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrateFanficModel} from '../server/fanfic-calibration.mjs';

const connection={id:'api',model:'neutral-fixture',contextWindow:8192,baseUrl:'http://127.0.0.1:1/v1'};
const project=()=>({id:'work',title:'PRIVATE_TITLE',settings:{maxTokens:1200,temperature:.8,generationProfiles:{modelKind:'moe',stages:{}}},characters:[{id:'p',name:'PRIVATE_CARD'}],episodes:[{id:'private',content:'PRIVATE_PROSE',memory:{summary:'PRIVATE_MEMORY'}}]});
const state=()=>({connections:[connection],settings:{localRuntime:{expertUsedCount:3}},chats:[{messages:[{content:'PRIVATE_RP'}]}],rooms:[{messages:[{content:'PRIVATE_DND'}]}],fanficProjects:[]});
const good={
  planning:{scenes:[{title:'Ворота',summary:'Лира ждёт у закрытых ворот архива с медным ключом.'},{title:'Вопрос',summary:'Торк спрашивает о пароле ЛУНА-731, но Лира не отвечает.'}]},
  memory:{summary:'Лира ждёт у ворот с медным ключом. Пароль ЛУНА-731, Торк его не знает.',password:'ЛУНА-731',keyHolder:'Лира',keyMaterial:'медь',doorState:'закрыта',torkKnowsPassword:false},
  review:{issues:['password','keyMaterial','keyHolder','doorState','knowledge'].map(code=>({code,description:'Кандидат изменил исходный факт.'}))},
  rewrite:{replacement:'Лира тихо сказала: «Наш пароль — ЛУНА-731».'},
};
const prose='Лира ждала у ворот архива, сжимая медный ключ. Дверь оставалась закрытой. Она помнила пароль ЛУНА-731, но не произносила его вслух. Торк спросил, долго ли им ещё стоять, и она пожала плечами.';
const mockStream=(text=prose,reason='stop')=>async function*(conn,secret,messages,options){options.onFinish(reason);yield text;};
const mockStructured=async options=>options.parse(JSON.stringify(good[options.name.replace('fanfic_calibration_','')]));
const options=(overrides={})=>({state:state(),project:project(),connection,getSecret:()=>'',structured:mockStructured,stream:mockStream(),countTokens:async()=>null,...overrides});

test('Fanfic model calibration tests all five stages using neutral facts without touching project/runtime/other modes',async()=>{
  const args=options(),before=structuredClone({state:args.state,project:args.project}),seen=[],progress=[];
  args.structured=async opts=>{seen.push(opts);return mockStructured(opts);};
  args.stream=async function*(conn,secret,messages,opts){seen.push({messages,context:{}});opts.onFinish('stop');yield prose;};
  args.onProgress=report=>progress.push(report);
  const report=await calibrateFanficModel(args);assert.deepEqual(report.stages.map(s=>s.stage),['writing','planning','memory','review','rewrite']);assert.ok(report.stages.every(stage=>stage.status==='passed'));
  assert.equal(progress.length,5);assert.equal(report.recommendation.automatic,false);assert.deepEqual(report.recommendation.generationProfiles,args.project.settings.generationProfiles);
  assert.equal(report.model,connection.model);assert.equal(report.connectionId,'api');assert.equal(report.profileFingerprint.length,64);
  for(const request of seen){assert.doesNotMatch(JSON.stringify(request.messages||request.context),/PRIVATE_/);assert.match(JSON.stringify(request.messages||request.context),/ЛУНА-731/);}
  assert.deepEqual({state:args.state,project:args.project},before);
  assert.ok(report.stages.every(stage=>stage.elapsedMs>=0&&Number.isFinite(stage.charactersPerSecond)&&stage.outputCharacters>=stage.outputPreview.length));
});

test('Fanfic calibration records failed exact recall and suggests bounded explicit stage changes only',async()=>{
  const args=options({structured:async opts=>{const stage=opts.name.replace('fanfic_calibration_',''),answer=structuredClone(good[stage]);if(stage==='memory'){answer.password='ЛУНА-000';answer.torkKnowsPassword=true;}return opts.parse(JSON.stringify(answer));}});
  const before=structuredClone(args.project.settings),report=await calibrateFanficModel(args),memory=report.stages.find(s=>s.stage==='memory');
  assert.equal(memory.status,'failed');assert.equal(memory.checks.password,false);assert.equal(memory.checks.knowledge,false);assert.equal(report.recommendation.generationProfiles.stages.memory.temperature,.05);assert.equal(report.recommendation.automatic,false);assert.deepEqual(args.project.settings,before);
  assert.equal(report.stages.find(s=>s.stage==='writing').status,'passed');
});

test('Fanfic calibration missing and falsy structured contracts count as failure, not accidental success',async()=>{
  for(const invalid of [null,false,undefined,{},[],{scenes:[]}]){
    const report=await calibrateFanficModel(options({structured:async()=>invalid}));
    assert.equal(report.stages[0].status,'passed');for(const stage of report.stages.slice(1)){assert.equal(stage.status,'failed');assert.equal(stage.checks.format,false);assert.ok(stage.error);}
  }
});

test('Fanfic calibration preserves technical API failures rather than hiding them in semantic recommendations',async()=>{
  const args=options({structured:async()=>{throw Object.assign(new Error('API вернул HTTP 500: test unavailable'),{status:500});}}),report=await calibrateFanficModel(args);
  for(const stage of report.stages.slice(1)){assert.equal(stage.status,'error');assert.match(stage.error,/HTTP 500/);}
  assert.deepEqual(report.recommendation.generationProfiles,args.project.settings.generationProfiles);assert.match(report.recommendation.reason,/технической ошибкой/);
});

test('Fanfic calibration checks truncated prose and selected-only rewrite before recommending',async()=>{
  const report=await calibrateFanficModel(options({stream:mockStream(prose.slice(0,-1),'length'),structured:async opts=>opts.name.endsWith('rewrite')?{replacement:'Перед воротами лежал снег. Лира сказала ЛУНА-731. Торк ждал у стены.'}:mockStructured(opts)}));
  const writing=report.stages[0],rewrite=report.stages.at(-1);assert.equal(writing.status,'failed');assert.equal(writing.checks.complete,false);assert.equal(rewrite.status,'failed');assert.equal(rewrite.checks.onlySelection,false);assert.equal(rewrite.checks.outsideUnchanged,true);
});

test('Fanfic calibration obeys cancellation even if a supplied adapter ignores abort',async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Автор остановил проверку.')),25);
  try{
    const report=await calibrateFanficModel(options({signal:controller.signal,countTokens:()=>new Promise(()=>{})}));
    assert.equal(report.interrupted,true);assert.equal(report.stages.length,1);assert.equal(report.stages[0].status,'error');assert.match(report.stages[0].error,/Автор остановил/);assert.match(report.recommendation.reason,/прервана/);
  }finally{clearTimeout(timer);}
});

test('Fanfic calibration enforces overall deadline and retains partial report for a hanging provider',async()=>{
  const start=performance.now();const report=await calibrateFanficModel(options({structured:()=>new Promise(()=>{}),stageTimeoutMs:1000,totalTimeoutMs:25}));
  assert.ok(performance.now()-start<1000);assert.equal(report.interrupted,true);assert.equal(report.stages[0].status,'passed');assert.equal(report.stages[1].status,'error');assert.match(report.stages[1].error,/общее время/);
});

test('Fanfic calibration checks actual tokenizer budget before model generation',async()=>{
  let calls=0;const report=await calibrateFanficModel(options({countTokens:async()=>8192,structured:async()=>{calls++;return null;},stream:async function*(){calls++;yield prose;}}));
  assert.equal(calls,0);assert.ok(report.stages.every(stage=>stage.status==='error'));assert.ok(report.stages.every(stage=>stage.error.includes('не помещается')));
});

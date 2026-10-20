import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createFanficImages,normalizeFanficFramePassport,fanficFramePassportState,fanficImageSourceHash,buildFanficImageContext} from '../server/fanfic-images.mjs';
import {createTasks} from '../server/tasks.mjs';

const connection={id:'api',model:'test',baseUrl:'http://127.0.0.1:1/v1',contextWindow:8192};
const fixtureData=()=>({connections:[connection],settings:{comfy:{positivePrefix:'high quality'}},characters:[{id:'foreign-card',name:'Чужой герой',appearance:'FOREIGN_LIBRARY_TRAIT'}],chats:[{id:'ordinary',messages:[{content:'PRIVATE_RP'}]}],rooms:[{id:'room',messages:[{content:'PRIVATE_DND'}]}],fanficProjects:[{id:'work',settings:{connectionId:'api'},characters:[{id:'lira',name:'Лира',appearance:'Чёрные волосы, зелёные глаза.'}],personas:[],lorebooks:[],episodes:[{id:'chapter',revision:4,content:'Лира подняла фонарь у двери архива.',status:'approved',memory:{summary:'Канон неизменен.'}}]},{id:'other',characters:[],episodes:[{id:'other-chapter',revision:1,content:'PRIVATE_OTHER_WORK'}]}],images:[]});
const passport=()=>({subjects:[{characterId:'lira',name:'Лира',appearance:'Чёрные волосы, зелёные глаза.',outfit:'Тёмный плащ.'}],moment:'Встреча у архива.',action:'Держит фонарь.',location:'Дверь архива.',camera:'Средний план.',lighting:'Свет фонаря.'});

async function fixture(t,{structured}={}){
  let state=fixtureData();const calls=[],queued=[];
  const router=createFanficImages({getState:()=>structuredClone(state),saveState:value=>{state=structuredClone(value);},getSecret:()=>'',tasks:createTasks(),countTokens:async()=>null,
    structured:async options=>{calls.push(options);return structured?structured(options):options.parse(JSON.stringify({tags:['Lira','black hair','holding lantern','archive door'],framePassport:{subjects:[{name:'Лира',appearance:'Black hair, green eyes.',outfit:'Dark cloak.'}],moment:'At the archive door',action:'Holding a lantern',location:'Archive doorway',camera:'Medium shot',lighting:'Lantern light'}}));},
    comfyRouter:{queueImage:async input=>{queued.push(input);return {id:'image',...input};}}});
  const app=express();app.use(express.json());app.use('/api/fanfic',router);app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const api=async(action,body,method='POST')=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/fanfic/projects/work/episodes/chapter/${action}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};};
  return {getState:()=>state,api,calls,queued,mutate:fn=>fn(state)};
}

test('Fanfic frame passport save is scoped metadata only and never changes card snapshots or canon',async t=>{
  const f=await fixture(t),before=structuredClone(f.getState());
  const initial=await f.api('frame-passport',undefined,'GET');assert.equal(initial.body.passport,null);assert.equal(initial.body.stale,false);
  const saved=await f.api('frame-passport',{passport:passport(),expectedRevision:4,sourceHash:initial.body.sourceHash},'PUT');assert.equal(saved.status,200);assert.equal(saved.body.passport.projectId,'work');assert.equal(saved.body.passport.episodeId,'chapter');assert.equal(saved.body.passport.sourceRevision,4);assert.equal(saved.body.passport.subjects[0].characterId,'lira');
  const state=f.getState();assert.deepEqual(state.characters,before.characters);assert.deepEqual(state.chats,before.chats);assert.deepEqual(state.rooms,before.rooms);assert.deepEqual(state.fanficProjects[1],before.fanficProjects[1]);assert.deepEqual(state.fanficProjects[0].characters,before.fanficProjects[0].characters);
  const e=state.fanficProjects[0].episodes[0],old=before.fanficProjects[0].episodes[0];for(const field of ['revision','content','status','memory'])assert.deepEqual(e[field],old[field]);
  const cleared=await f.api('frame-passport',{passport:null,expectedRevision:4},'PUT');assert.equal(cleared.status,200);assert.equal(cleared.body.passport,null);assert.equal(e.revision,4);
});

test('Fanfic frame passport rejects foreign bindings, snapshots and obsolete source before save or queue',async t=>{
  const f=await fixture(t);
  for(const invalid of [{...passport(),projectId:'other'},{...passport(),episodeId:'other-chapter'},{...passport(),sourceRevision:3},{...passport(),sourceHash:'old'}])assert.equal((await f.api('frame-passport',{passport:invalid,expectedRevision:4},'PUT')).status,409);
  assert.equal((await f.api('frame-passport',{passport:{...passport(),subjects:[{characterId:'foreign-card',name:'Чужой герой'}]},expectedRevision:4},'PUT')).status,400);
  assert.equal((await f.api('frame-passport',{passport:passport()},'PUT')).status,400);
  assert.equal((await f.api('frame-passport',{passport:{...passport(),sceneExcerpt:'PRIVATE_OTHER_WORK'},expectedRevision:4},'PUT')).status,409);
  assert.equal((await f.api('images',{prompt:'Lira at the archive',framePassport:{...passport(),projectId:'other'}})).status,409);assert.equal(f.queued.length,0);
});

test('Fanfic stale passport stays visible but cannot silently guide a changed scene',async t=>{
  const f=await fixture(t);await f.api('frame-passport',{passport:passport(),expectedRevision:4},'PUT');
  f.mutate(state=>{const e=state.fanficProjects[0].episodes[0];e.revision=5;e.content+=' Она вошла внутрь.';});
  const saved=await f.api('frame-passport',undefined,'GET');assert.equal(saved.body.stale,true);assert.equal(saved.body.passport.sourceRevision,4);
  assert.equal((await f.api('image-prompt',{usePassport:true,expectedRevision:5})).status,409);assert.equal(f.calls.length,0);
  const fresh=await f.api('image-prompt',{usePassport:false,expectedRevision:5});assert.equal(fresh.status,200);assert.equal(fresh.body.framePassport.sourceRevision,5);assert.equal(fresh.body.framePassport.sourceHash,saved.body.sourceHash);
});

test('Fanfic image compiler and queue carry one validated frame without importing external context',async t=>{
  const f=await fixture(t),before=structuredClone(f.getState());await f.api('frame-passport',{passport:passport(),expectedRevision:4},'PUT');
  const generated=await f.api('image-prompt',{usePassport:true,expectedRevision:4});assert.equal(generated.status,200);assert.equal(generated.body.framePassport.subjects[0].characterId,'lira');assert.match(generated.body.prompt,/high quality, Лира/);
  const context=f.calls[0].context;assert.equal(context.framePassport.subjects[0].outfit,'Тёмный плащ.');assert.equal(context.framePassport.camera,'Средний план.');assert.doesNotMatch(JSON.stringify(context),/PRIVATE_RP|PRIVATE_DND|PRIVATE_OTHER_WORK|FOREIGN_LIBRARY_TRAIT/);
  assert.equal(f.getState().fanficProjects[0].episodes[0].framePassport.subjects[0].outfit,'Тёмный плащ.');
  const queued=await f.api('images',{prompt:generated.body.prompt,sourceHash:generated.body.sourceHash,expectedRevision:4,framePassport:generated.body.framePassport});assert.equal(queued.status,202);assert.equal(f.queued[0].framePassport.projectId,'work');assert.equal(f.queued[0].framePassport.action,'Держит фонарь.');assert.equal(f.queued[0].chatId,undefined);assert.equal(f.queued[0].roomId,undefined);
  assert.deepEqual(f.getState().fanficProjects[0].characters,before.fanficProjects[0].characters);assert.deepEqual(f.getState().fanficProjects[0].episodes[0].memory,before.fanficProjects[0].episodes[0].memory);
});

test('Fanfic passport rebinding for archive import validates the imported cast and selected source',()=>{
  const state=fixtureData(),old=state.fanficProjects[0],episode=old.episodes[0],saved=normalizeFanficFramePassport({...passport(),sceneExcerpt:episode.content},{project:old,episode});
  const imported={...structuredClone(old),id:'imported'},chapter={...structuredClone(episode),id:'imported-chapter',revision:1};
  assert.throws(()=>normalizeFanficFramePassport(saved,{project:imported,episode:chapter}),error=>error.status===409);
  const rebound=normalizeFanficFramePassport(saved,{project:imported,episode:chapter,rebind:true});assert.equal(rebound.projectId,'imported');assert.equal(rebound.episodeId,'imported-chapter');assert.equal(rebound.sourceRevision,1);assert.equal(rebound.sourceHash,fanficImageSourceHash(chapter.content));assert.equal(fanficFramePassportState(imported,{...chapter,framePassport:rebound}).stale,false);
  assert.throws(()=>normalizeFanficFramePassport(saved,{project:imported,episode:{...chapter,content:'Другой текст.'},rebind:true}),error=>error.status===409);
  assert.throws(()=>normalizeFanficFramePassport(saved,{project:{...imported,characters:[]},episode:chapter,rebind:true}),error=>error.status===400);
});

test('Fanfic passport field bounds prevent oversized or invalid manual frame data',()=>{
  const state=fixtureData(),project=state.fanficProjects[0],episode=project.episodes[0];
  for(const raw of [[],null,{subjects:Array.from({length:9},()=>({name:'NPC'}))},{subjects:[{name:''}]},{moment:'x'.repeat(1801)},{location:42}])assert.throws(()=>normalizeFanficFramePassport(raw,{project,episode}),error=>error.status===400);
  const valid=normalizeFanficFramePassport({subjects:[{name:'Новый NPC',appearance:'Знакомая фигура.'}],camera:'Общий план.'},{project,episode});assert.equal(valid.subjects[0].characterId,'');assert.equal(valid.camera,'Общий план.');
});

test('Fanfic image prompt cannot escape a revision change while the model is compiling the frame',async t=>{
  let f;f=await fixture(t,{structured:options=>{f.mutate(state=>state.fanficProjects[0].episodes[0].revision++);return options.parse('{"tags":["Lira","lantern","archive"]}');}});
  const res=await f.api('image-prompt',{expectedRevision:4});assert.equal(res.status,409);assert.equal(f.queued.length,0);assert.equal(f.getState().fanficProjects[0].episodes[0].framePassport,undefined);
});

test('Fanfic image passport packing keeps complete JSON in small contexts with explicit clipping warning',()=>{
  const state=fixtureData(),project=state.fanficProjects[0],episode=project.episodes[0];
  const saved=normalizeFanficFramePassport({...passport(),moment:'Текущий момент. '.repeat(100),subjects:[{characterId:'lira',name:'Лира',appearance:'Чёрные волосы. '.repeat(150),outfit:'Тёмный плащ. '.repeat(130)}]},{project,episode});
  for(const contextWindow of [1024,2048,4096]){
    const prepared=buildFanficImageContext({project,episode,connection:{...connection,contextWindow},framePassport:saved});assert.ok(prepared.tokens+prepared.maxTokens+180<=contextWindow);assert.doesNotThrow(()=>JSON.parse(JSON.stringify(prepared.context)));assert.equal(prepared.context.framePassport.subjects[0].name,'Лира');assert.ok(prepared.warnings.some(w=>w.includes('Паспорт кадра сокращён')));
  }
});

test('Author frame anchors survive contradictory MoE tags and passport proposals without changing saved metadata',async t=>{
 const f=await fixture(t,{structured:options=>options.parse(JSON.stringify({tags:['Lira','red coat','cafe interior','drinking tea'],framePassport:{subjects:[{characterId:'lira',name:'Лира',appearance:'red hair',outfit:'red coat'}],moment:'drinking tea',action:'sipping tea',location:'cafe interior',camera:'close-up',lighting:'soft light'}}))});
 const anchored={subjects:[{characterId:'lira',name:'Лира',appearance:'black hair, green eyes',outfit:'blue coat'}],moment:'standing beside the north gates',action:'holding a lantern',location:'north gates',camera:'medium shot',lighting:'lantern light'};
 await f.api('frame-passport',{passport:anchored,expectedRevision:4},'PUT');const before=structuredClone(f.getState());
 const generated=await f.api('image-prompt',{usePassport:true,expectedRevision:4});assert.equal(generated.status,200);
 for(const field of ['moment','action','location','camera','lighting'])assert.equal(generated.body.framePassport[field],anchored[field]);
 assert.equal(generated.body.framePassport.subjects[0].outfit,'blue coat');assert.equal(generated.body.framePassport.subjects[0].appearance,'black hair, green eyes');
 assert.match(generated.body.prompt,/north gates/);assert.match(generated.body.prompt,/blue coat/);assert.doesNotMatch(generated.body.prompt,/cafe|red coat|red hair|drinking tea|sipping tea/);
 assert.ok(generated.body.warnings.some(w=>w.includes('Ваши заполненные поля сохранены')));assert.deepEqual(f.getState(),before);
});

test('Only empty author fields may receive matching model proposal details; invalid raw tags are ignored',async t=>{
 const f=await fixture(t,{structured:options=>options.parse(JSON.stringify({tags:['wrong'],framePassport:{subjects:[{characterId:'lira',name:'Лира',appearance:'black hair',outfit:'red coat'}],moment:'different moment',action:'different action',location:'cafe',camera:'medium close-up',lighting:'warm lantern light'}}))});
 const anchored={subjects:[{characterId:'lira',name:'Лира',appearance:'',outfit:'blue coat'}],moment:'standing at north gates',action:'holding a lantern',location:'north gates',camera:'',lighting:''};
 const generated=await f.api('image-prompt',{framePassport:anchored,expectedRevision:4});assert.equal(generated.status,200);
 assert.equal(generated.body.framePassport.subjects[0].appearance,'black hair');assert.equal(generated.body.framePassport.subjects[0].outfit,'blue coat');assert.equal(generated.body.framePassport.camera,'medium close-up');assert.equal(generated.body.framePassport.lighting,'warm lantern light');assert.doesNotMatch(generated.body.prompt,/red coat|cafe|different|wrong/);
 assert.equal(f.getState().fanficProjects[0].episodes[0].framePassport,undefined);
});

test('Russian anchors and full long author descriptions remain literal with honest warnings after context clipping',async t=>{
 const f=await fixture(t,{structured:options=>options.parse(JSON.stringify({tags:['Lira','red coat','cafe'],framePassport:{subjects:[],moment:'',action:'',location:'cafe',camera:'',lighting:''}}))});
 f.mutate(state=>{state.connections[0].contextWindow=1024;});
 const outfit='blue coat, '+ 'silver embroidery '.repeat(65)+'with a small bronze pin';
 const anchored={subjects:[{characterId:'lira',name:'Лира',appearance:'black hair',outfit}],moment:'At the north gates',action:'Держит фонарь.',location:'north gates',camera:'medium shot',lighting:'lantern light'};
 const generated=await f.api('image-prompt',{framePassport:anchored,expectedRevision:4});assert.equal(generated.status,200);assert.ok(generated.body.prompt.includes(outfit));assert.match(generated.body.prompt,/Держит фонарь/);assert.doesNotMatch(generated.body.prompt,/cafe|red coat/);
 assert.ok(generated.body.warnings.some(w=>w.includes('без автоматического перевода')));assert.ok(generated.body.warnings.some(w=>w.includes('сокращён только в контексте модели')));assert.ok(generated.body.warnings.some(w=>w.includes('длинное описание')));
});

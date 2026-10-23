import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {focusedRoleplay,uniqueSentences,roleplayMessages,roleplayWordLimit,roleplaySampling,roleplayStops,createRoleplayOutputFilter,repeatedReply} from '../server/roleplay.mjs';
import {runtimeArgs} from '../server/local-runtime.mjs';
import {samplingDefaults} from '../shared/local-options.mjs';
import {sanitizeState} from '../server/store.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {normalizeItem} from '../shared/equipment.mjs';
import {normalizeSkill} from '../shared/rpg-rules.mjs';
import {createAdventureGame,adventureActor,adventureAction,resetRound} from '../server/adventure-engine.mjs';
import {storyDirector} from '../server/story-director.mjs';
import {createMultiplayer} from '../server/multiplayer.mjs';
import {createComfyRouter} from '../server/comfy.mjs';
import {createTasks} from '../server/tasks.mjs';
import {comfyDefaults} from '../shared/defaults.mjs';
import {battlemapPreset,battlemapWorkflow} from '../shared/battlemap-preset.mjs';
import {generateMap,mapPNG} from '../server/battlemap.mjs';
const local={id:'sas-local',promptFormat:'alpaca',sampling:{...samplingDefaults}};
const persona={id:'test',kind:'srp',name:'Воин',className:'Воин',abilities:defaultAbilities()};
const item=(weapon,buffs={})=>normalizeItem({id:'weapon',name:'Оружие',equipped:true,weapon,buffs});
function table(weapon={damage:'2d6'}){const g=createAdventureGame('dnd');const a=adventureActor('host',{...persona,inventory:[item(weapon)]},g.rules),n=adventureActor('npc',{...persona,name:'Страж'},g.rules);n.player=false;n.x=3;g.actors=[a,n];g.order=['host'];return g;}
function attack(g,random,skillId='weapon'){return adventureAction(g,{action:'skill',skillId,targetId:'npc'},'host',{host:true,random});}

test('Alpaca adaptation is opt-out and never selects remote or other local templates',()=>{
 assert.equal(focusedRoleplay(local,{}),true);assert.equal(focusedRoleplay(local,{localRpAdaptive:false}),false);
 assert.equal(focusedRoleplay({...local,id:'api'},{}),false);assert.equal(focusedRoleplay({...local,promptFormat:'single-system'},{}),false);
});
test('RP prompt removes exact repeated sentences without changing original text or unique events',()=>{
 const text='Я осматриваю зал. '.repeat(80)+'Борис жив. Я возвращаюсь домой.';
 assert.equal(uniqueSentences(text),'Я осматриваю зал. Борис жив. Я возвращаюсь домой.');assert.equal(text.match(/осматриваю/g).length,80);
 const source=[{role:'system',content:'Только Селина'},{role:'user',content:'Я осматриваю зал.'},{role:'assistant',content:'Селина ждёт.'},{role:'user',content:text}];const old=structuredClone(source);
 const p=roleplayMessages(source,{characterName:'Селина',playerName:'Мира'});assert.equal(p.length,1);assert.match(p[0].content,/Селина: Селина ждёт/);assert.match(p[0].content,/Не копируй пост игрока/);assert.deepEqual(source,old);
});
test('RP source provenance preserves speaker, names and exact return conditions at the task tail',()=>{
 const p=roleplayMessages([{role:'system',content:'Исходные события ЭТОЙ истории archive'},{role:'user',content:'Когда вернуть печать?'}],{characterName:'Селина',playerName:'Мира',archive:[{id:'old',role:'assistant'}],sourceExcerpts:[{messageId:'old',index:34,text:'Вернуть печать Эльдору после открытия обсерватории.'}]})[0].content;
 assert.match(p,/Ход 35; Селина/);assert.match(p,/после открытия обсерватории/);assert.ok(p.indexOf('Вернуть печать Эльдору')<p.indexOf('Когда вернуть печать?'));assert.ok(p.indexOf('Вернуть печать Эльдору')>p.indexOf('прошлого этой истории'));assert.doesNotMatch(p,/archive/);
});
test('RP writing instructions fit small token budgets and account for longer Russian tokenization',()=>{
 const ru='Я улыбаюсь и пишу: здравствуйте, я Ирис. Как к вам обращаться?',en='I smile and write: hello, I am Iris. What should I call you?';
 for(const tokens of [32,64,128,256,700,1024]){
  const russian=roleplayWordLimit(tokens,ru),english=roleplayWordLimit(tokens,en);assert.ok(russian>0&&russian*3<=tokens);assert.ok(russian<english);assert.ok(english<=tokens/2);
  const prompt=roleplayMessages([{role:'user',content:ru}],{maxTokens:tokens})[0].content;assert.ok(prompt.includes(`в пределах ${russian} слов`));
 }
 assert.ok(roleplayWordLimit(700,ru)<250);assert.equal(roleplayWordLimit(131072,ru),600);
});
test('RP sampler adaptation keeps manual settings, other modes and active-expert configuration unchanged',()=>{
 assert.equal(roleplaySampling(local,{}).dryMultiplier,.5);
 const c={...local,sampling:{...samplingDefaults,repeatPenalty:1.2,dryMultiplier:.6}};const old=structuredClone(c);
 const r=roleplaySampling(c,{});assert.equal(r.repeatPenalty,undefined);assert.equal(r.dryMultiplier,undefined);assert.equal(roleplaySampling({...c,id:'api'},{}),undefined);assert.deepEqual(c,old);
 assert.equal(roleplaySampling(c,{localRpAdaptive:false}),undefined);
});
test('Focused RP stops only explicit out-of-role handoff headings, preserving ordinary prose and opt-out',()=>{
 const stops=roleplayStops(local,{});const response='Тонерико назвала пароль и срок.\n\n---\n\nВот ваш следующий ход: придумай действие игрока.';
 assert.equal(response.slice(0,response.indexOf(stops[0])),'Тонерико назвала пароль и срок.');assert.ok(stops.every(s=>s.startsWith('\n\n')));assert.ok(stops.every(s=>!['Дверь открылась.\n\n---\n\nПисьмо заканчивается.','— Вот ваш следующий ход: шах королю! — сказала она.'].some(t=>t.includes(s))));
 assert.equal(roleplayStops({...local,id:'external'},{}),undefined);assert.equal(roleplayStops({...local,promptFormat:'single-system'},{}),undefined);assert.equal(roleplayStops(local,{localRpAdaptive:false}),undefined);
});
test('RP handoff filtering handles every stream split and preserves quoted dialogue, prose and separators',()=>{
 const prose='Тонерико назвала пароль и срок.';
 for(const tail of ['\n\n---\n\nВот ваш следующий ход: Ирис может спросить.','\n\n### End of Turn: Toneriko\n\nИгроку: продолжайте.','\r\n\r\n### End of Turn\r\nИгроку: продолжайте.','\n\nИгроку: придумайте следующий пост.','\n\n## YOUR NEXT TURN: choose an action.']){
  const input=prose+tail;
  for(let split=0;split<=input.length;split++){const f=createRoleplayOutputFilter(),out=f.push(input.slice(0,split))+f.push(input.slice(split))+f.flush();assert.equal(out.trimEnd(),prose);assert.equal(f.stopped,true);}
  const f=createRoleplayOutputFilter();assert.equal([...input].map(c=>f.push(c)).join('').trimEnd()+f.flush(),prose);
 }
 for(const input of ['Тонерико улыбнулась.\n\n---\n\nИрис ждёт ответа.','— Вот ваш следующий ход: шах королю! — сказала она.','Она написала «Игроку:» в своей записке.','### Новая сцена\n\nВечер в городе.',' '.repeat(600)+'Обычная реплика.','Текст.\n\n---\n']){const f=createRoleplayOutputFilter();assert.equal([...input].map(c=>f.push(c)).join('')+f.flush(),input);assert.equal(f.stopped,false);}
 const continuation=createRoleplayOutputFilter({lineStart:false});assert.equal(continuation.push('end of turn: это часть предыдущей строки')+continuation.flush(),'end of turn: это часть предыдущей строки');
});
test('RP repetition guard detects a long stream loop while allowing normal recurring names and short dialogue',()=>{
 const sentence='Мира разглядывает деревянные столы таверны и ожидает ответа собеседника. ';
 assert.equal(repeatedReply(sentence.repeat(5)),true);assert.equal(repeatedReply('Да. '.repeat(12)),false);assert.equal(repeatedReply(sentence+'Мира подходит к окну. Селина отвечает.'),false);
});
test('Attack journal compares equal AC, groups dice damage and distinguishes overkill from actual HP loss',()=>{
 const g=table();g.actors[0].abilities.strength=12;g.actors[1].hp=3;attack(g,s=>s===20?7:4);
 const a=g.log.find(e=>e.calculation?.kind==='attack'),d=g.log.find(e=>e.calculation?.kind==='damage');assert.equal(a.calculation.total,10);assert.equal(a.calculation.armor,10);assert.equal(a.calculation.hit,true);
 assert.equal(a.calculation.attribute,'strength');assert.equal(d.calculation.attackId,a.id);assert.deepEqual(d.calculation.rolls,[4,4]);assert.equal(d.calculation.raw,8);assert.equal(d.calculation.applied,3);assert.equal(d.calculation.hpAfter,0);
 assert.match(a.text,/1д20/);assert.match(d.text,/2д6 \[4 \+ 4\]/);assert.match(d.text,/потеря HP 3/);assert.equal(g.eventArchive.find(e=>e.id===d.id).calculation.attackId,a.id);
});
test('A miss never rolls damage and displays the negative Strength modifier',()=>{
 const g=table();g.actors[0].abilities.strength=8;let calls=0;attack(g,s=>{calls++;assert.equal(s,20);return 8;});assert.equal(calls,1);assert.equal(g.actors[1].hp,40);
 const a=g.log.at(-1);assert.equal(a.calculation.modifier,-1);assert.equal(a.calculation.total,9);assert.equal(a.calculation.hit,false);assert.match(a.text,/урон не бросается/);
});
test('Ranged physical journal uses Dexterity and spends ammo even on miss',()=>{
 const g=table({reach:'ranged',hands:'two',damage:'1d12',range:24,ammoTag:'arrows',ammoPerShot:1});g.actors[0].abilities.dexterity=12;g.actors[0].inventory.push(normalizeItem({id:'arrows',name:'Стрелы',ammoTag:'arrows',quantity:3}));attack(g,()=>1);
 assert.equal(g.log.at(-1).calculation.attribute,'dexterity');assert.equal(g.log.at(-1).calculation.modifier,1);assert.equal(g.actors[0].inventory.at(-1).quantity,2);
});
test('Magic projectile journal records both disadvantage dice, casting attribute, no damage on miss',()=>{
 const g=table(),a=g.actors[0];a.abilities.intelligence=12;a.spells=[normalizeSkill({id:'magic',name:'Сфера',kind:'magic',castingAttribute:'intelligence',reach:'ranged',delivery:'projectile',range:12,damage:'2d12',slotCost:2})];const rolls=[18,3];attack(g,s=>{assert.equal(s,20);return rolls.shift();},'magic');
 const c=g.log.at(-1).calculation;assert.deepEqual(c.rolls,[18,3]);assert.equal(c.roll,3);assert.equal(c.attribute,'intelligence');assert.equal(c.mode,'помеха');assert.equal(c.total,4);assert.equal(c.hit,false);assert.equal(a.slots,4);
});
test('Shield journal keeps raw damage arithmetic correct and reports zero actual HP loss',()=>{
 const g=table();g.actors[1].effects.push({type:'shield',damageType:'physical',hits:2,turns:2});attack(g,s=>s===20?20:5);
 const d=g.log.at(-1);assert.equal(d.calculation.raw,10);assert.equal(d.calculation.applied,0);assert.equal(d.calculation.blocked,true);assert.match(d.text,/5 \+ 5/);assert.match(d.text,/защита поглотила/);assert.equal(g.actors[1].hp,40);
});
test('Negative damage buffs are clamped explicitly in the journal',()=>{
 const g=table();g.actors[0].inventory[0].buffs.damage=-4;attack(g,s=>s===20?20:1);const d=g.log.at(-1);assert.equal(d.calculation.raw,0);assert.match(d.text,/− 4 = -2 → 0/);assert.equal(d.calculation.applied,0);
});
test('GM story direction retains room goal despite bypassed/dead NPCs without deciding for players',()=>{
 const room={storybook:{goal:'Найти сердце маяка',world:'Архипелаг',details:'Проводник знает вход'},scene:{location:'Кузница'},tactical:{actors:[{name:'Проводник',player:false,hp:0},{name:'Торк',player:true,hp:0}]}};
 const p=storyDirector(room);assert.match(p,/Найти сердце маяка/);assert.match(p,/Текущая локация: Кузница/);assert.match(p,/выведенные из боя.*Проводник/);assert.match(p,/не останавливай сюжет/);assert.match(p,/оставь выбор игрокам/);assert.doesNotMatch(p,/выведенные из боя.*Торк/);assert.equal(storyDirector({}), '');
});
test('D&D protected prompt includes active Story book goal and current engine state; solo lore and preset do not leak',()=>{
 let s=sanitizeState({});s.characters[0].description='FOREIGN_RP';s.settings.narrative.instructions='FOREIGN_STYLE';s.multiplayer={id:'room',mode:'dnd',storybook:{name:'Маяк',goal:'СЕРДЦЕ_МАЯКА',world:'Архипелаг',start:'Порт',details:''},lorebookIds:[],rulebookIds:[],messages:[],memory:[],tactical:createAdventureGame('dnd'),scene:{location:'Кузница'}};
 const m=createMultiplayer({getState:()=>structuredClone(s),saveState:n=>{s=n;},getSecret:()=>'',dataDir:os.tmpdir(),tasks:createTasks()});const c=m.context();assert.match(c.priorityInstructions,/СЕРДЦЕ_МАЯКА/);assert.match(c.priorityInstructions,/SAS_STORY_DIRECTION/);assert.match(c.priorityInstructions,/Кузница/);assert.doesNotMatch(c.extraInstructions,/FOREIGN_RP|FOREIGN_STYLE/);assert.equal(c.state.activePresetId,'');
 s.multiplayer.mode='roleplay';s.multiplayer.chatId=s.chats[0].id;assert.equal(m.context().priorityInstructions,'');
});
test('Comfy migration copies legacy endpoint to maps, replaces only exact old map defaults, retains custom prefixes',()=>{
 const old={baseUrl:'http://127.0.0.1:8999',mapPositivePrefix:'Battlemap, orthographic top-down tactical floor plan, clear walkable paths, readable terrain, consistent room boundaries, detailed medieval fantasy environment',mapNegative:'people, characters, tokens, figures, text, labels, numbers, watermark, grid, perspective, isometric, tilted camera, blocked corridors, blurry, low quality'};
 const s=sanitizeState({settings:{comfy:old}}).settings.comfy;assert.equal(s.mapBaseUrl,old.baseUrl);assert.equal(s.mapPositivePrefix,battlemapPreset.positive);assert.equal(s.mapNegative,battlemapPreset.negative);assert.equal(s.mapPromptVersion,2);
 const custom=sanitizeState({settings:{comfy:{...old,mapBaseUrl:'http://127.0.0.1:9999',mapPositivePrefix:'MY MAP',mapNegative:'MY NEG',positivePrefix:'MY SCENE'}}}).settings.comfy;
 assert.equal(custom.mapBaseUrl,'http://127.0.0.1:9999');assert.equal(custom.mapPositivePrefix,'MY MAP');assert.equal(custom.mapNegative,'MY NEG');assert.equal(custom.positivePrefix,'MY SCENE');
});
async function mock(t,label){const calls=[];const srv=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw);}catch{}calls.push({path:req.url,authorization:req.headers.authorization,body,raw});res.setHeader('Content-Type','application/json');if(req.url==='/object_info')res.end(JSON.stringify({CheckpointLoaderSimple:{input:{required:{ckpt_name:[[label+'.ckpt']]}}}}));else if(req.url==='/upload/image')res.end(JSON.stringify({name:label+'-'+calls.length+'.png'}));else if(req.url==='/prompt')res.end(JSON.stringify({prompt_id:label+'-job'}));else res.end('{}');});await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{srv.close(r);srv.closeAllConnections();}));return {url:'http://127.0.0.1:'+srv.address().port,calls};}
test('Scene and map Comfy routes use separate endpoints, secrets, checkpoints, prefixes and guide uploads',async t=>{
 const secrets={comfy:'SCENE_SECRET','comfy-map':'MAP_SECRET'};const scene=await mock(t,'scene'),map=await mock(t,'map'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-comfy-085-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let s={settings:{comfy:{...structuredClone(comfyDefaults),baseUrl:scene.url,mapBaseUrl:map.url,model:'scene.ckpt',workflow:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old'}},'2':{class_type:'CLIPTextEncode',_meta:{title:'Positive'},inputs:{text:'old'}},'3':{class_type:'CLIPTextEncode',_meta:{title:'Negative'},inputs:{text:'old'}}},positivePrefix:'SCENE QUALITY',negative:'SCENE NEG',mapModel:'map.ckpt',mapWorkflow:structuredClone(battlemapWorkflow),mapPositivePrefix:'MAP QUALITY',mapNegative:'MAP NEG'}},images:[],multiplayer:{id:'room',mode:'dnd',tactical:{map:generateMap({width:16,height:16,seed:1,descriptor:{title:'Зал',environment:'interior',rooms:['Зал'],entrySide:'south',visualPrompt:'stone hall'}})}}};
 const r=createComfyRouter({getState:()=>structuredClone(s),saveState:v=>{s=v;},getSecret:k=>secrets[k]||'',tasks:createTasks(),dataDir:dir});t.after(()=>r.close());
 const express=(await import('express')).default,a=express();a.use('/api',r);a.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const httpSrv=a.listen(0,'127.0.0.1');await new Promise(resolve=>httpSrv.once('listening',resolve));t.after(()=>new Promise(resolve=>{httpSrv.close(resolve);httpSrv.closeAllConnections();}));const base='http://127.0.0.1:'+httpSrv.address().port+'/api';
 const info=async kind=>(await(await fetch(base+'/comfy/info?kind='+kind)).json()).models[0].values;
 assert.deepEqual(await info('scene'),['scene.ckpt']);assert.deepEqual(await info('battlemap'),['map.ckpt']);assert.equal((await fetch(base+'/comfy/info?kind=unknown')).status,400);
 await r.queueImage({chatId:'rp',prompt:'1girl, red hair, stone hall'});await r.queueMap(s.multiplayer);
 const sp=scene.calls.find(c=>c.path==='/prompt'),mp=map.calls.find(c=>c.path==='/prompt');assert.equal(sp.body.prompt['1'].inputs.ckpt_name,'scene.ckpt');assert.match(sp.body.prompt['2'].inputs.text,/SCENE QUALITY/);assert.doesNotMatch(sp.body.prompt['2'].inputs.text,/MAP QUALITY/);
 assert.equal(mp.body.prompt['1'].inputs.ckpt_name,'map.ckpt');assert.match(mp.body.prompt['2'].inputs.text,/MAP QUALITY/);assert.match(mp.body.prompt['3'].inputs.text,/^MAP NEG/);assert.doesNotMatch(mp.body.prompt['3'].inputs.text,/SCENE NEG/);assert.ok(map.calls.filter(c=>c.path==='/upload/image').length>=3);assert.ok(!scene.calls.some(c=>c.path==='/upload/image'));
 assert.ok(scene.calls.every(c=>c.authorization==='Bearer SCENE_SECRET'));assert.ok(map.calls.every(c=>c.authorization==='Bearer MAP_SECRET'));
 assert.equal(s.images.find(i=>i.kind==='battlemap').service,'comfy-map');assert.equal(s.images.find(i=>i.chatId==='rp').baseUrl,scene.url);
 s.settings.comfy.baseUrl='http://127.0.0.1:1';s.settings.comfy.mapBaseUrl='http://127.0.0.1:2';secrets.comfy='NEW_SCENE_SECRET';secrets['comfy-map']='NEW_MAP_SECRET';await new Promise(resolve=>setTimeout(resolve,650));assert.ok(map.calls.some(c=>c.path.startsWith('/history/')));assert.ok(scene.calls.some(c=>c.path.startsWith('/history/')));
 const cancelled=await fetch(base+'/images/'+s.images.find(i=>i.kind==='battlemap').id+'/cancel',{method:'POST'});assert.equal(cancelled.status,200);assert.ok(map.calls.some(c=>c.path==='/queue'));assert.ok(!scene.calls.some(c=>c.path==='/queue'));assert.ok(map.calls.every(c=>c.authorization==='Bearer MAP_SECRET'));assert.ok(scene.calls.every(c=>c.authorization==='Bearer SCENE_SECRET'));assert.doesNotMatch(JSON.stringify(s),/SECRET/);
});

test('Validated chat-template override is local-runtime only and embeddings keep their encoder mode',()=>{
 const input={modelPath:'test.gguf',context:4096,gpuLayers:'auto',device:{backend:'cpu'},port:1234,key:'test'};
 const automatic=runtimeArgs(input);assert.ok(!automatic.includes('--chat-template'));
 for(const name of ['llama3','mistral-v1','mistral-v3','chatml','command-r']){const args=runtimeArgs({...input,options:{chatTemplate:name}});assert.equal(args[args.indexOf('--chat-template')+1],name);}
 const encoder=runtimeArgs({...input,embedding:true,options:{chatTemplate:'llama3'}});assert.ok(encoder.includes('--embedding'));assert.ok(!encoder.includes('--chat-template'));assert.throws(()=>runtimeArgs({...input,options:{chatTemplate:'--other-flag'}}),/Недопустимое/);
});

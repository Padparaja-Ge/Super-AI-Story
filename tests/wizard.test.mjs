import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {startServer} from '../server/index.mjs';
import {wizardExport,validateWizardObject} from '../server/wizard.mjs';
import {invitationUrls} from '../server/multiplayer.mjs';
import {safeAvatar} from '../shared/avatar.mjs';
import {importPersona} from '../server/personas.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
function sample(schema,key=''){
  if(schema.enum)return schema.enum[0];
  if(schema.type==='object')return Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,sample(v,k)]));
  if(schema.type==='array')return key==='entries'?[sample(schema.items)]:[];
  if(schema.type==='boolean')return false;
  if(schema.type==='integer')return -1;
  return key==='avatar'?'✧':key==='name'?'Лира':'Подробный текст '+key;
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-wizard-')),calls=[];let broken=false,slow=false;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),context=JSON.parse(body.messages[1].content),schema=body.response_format.json_schema.schema;calls.push({context,schema,body});
    let result=sample(schema);
    if(schema.properties.kind){const story=/Story book/.test(context.request),persona=/персону/.test(context.request)||context.current?.kind==='persona',edit=/только внешность/.test(context.request);result={kind:story?'storybook':persona?'persona':'character',name:'Лира',summary:'Лира — дочь улиц, потерявшая руку.',sections:edit?['personaDetails']:persona?['persona','personaDetails']:['identity','personality','appearance','dialogue','instructions','design'],fields:edit?['appearance']:[],lorebooks:/лорбук/.test(context.request)?['Город']:[]};}
    else if(schema.properties.fields){result={summary:'Изменены запрошенные данные.',fields:/только цель/.test(context.request)?['world','goal']:/внешность/.test(context.request)?['appearance']:['description','personality'],lorebooks:/лорбук/.test(context.request)?[{name:'Отношения с игроком',target:-1,instruction:context.request}]:[]};}
    else if(schema.properties.entries){result={description:'Взаимодействие',entries:[{target:-1,name:'Доверие',keys:['доверие'],brief:'Реакция на доверие'},{target:-1,name:'Спор',keys:['спор'],brief:'Поведение при споре'}]};}
    else if(context.current)for(const key of Object.keys(result))if(key in context.current)result[key]=context.current[key];
    if(schema.properties.goal&&/только цель/.test(context.request))result.goal='Спасти маяк вместо поиска сокровищ';
    if(schema.properties.appearance&&/синее/.test(context.request))result.appearance='Синее пальто';
    if(slow)await wait(160);
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:broken?'broken json':JSON.stringify(result)}}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const runtime=await startServer({port:0,dataDir:dir}),store=runtime.app.locals.runtime.store;
  const s=store.getState();s.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;s.connections[0].model='mock';store.saveState(s);
  const request=async(route,body,method)=>{const r=await fetch(`http://127.0.0.1:${runtime.port}/api${route}`,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-SAS-Client':'test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const create=async()=> (await request('/wizard',{})).data.id;
  const done=async()=>{for(let i=0;i<200;i++){const job=runtime.app.locals.runtime.tasks.publicTask();if(job&&job.status!=='running')return job;await wait(20);}throw new Error('Wizard timed out');};
  t.after(async()=>{await runtime.close();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});assert.ok(dir.startsWith(path.join(os.tmpdir(),'sas-wizard-')));await fs.rm(dir,{recursive:true,force:true});});
  return {store,request,create,done,calls,setBroken:v=>{broken=v;},setSlow:v=>{slow=v;}};
}

test('Story book wizard creates narrative blocks, edits only requested fields, imports and applies independently',async t=>{
 const f=await fixture(t),before=f.store.getState(),id=(await f.request('/wizard',{kind:'storybook'})).data.id;
 await f.request(`/wizard/${id}/messages`,{text:'Создай Story book для НРИ о спасении маяка'});assert.equal((await f.done()).status,'done');
 const first=f.store.getState().wizardSessions.find(s=>s.id===id).artifact;
 assert.equal(first.kind,'storybook');assert.deepEqual(first.lorebooks,[]);
 for(const field of ['name','world','start','goal','details','playerCount'])assert.ok(first.data[field]);
 await f.request(`/wizard/${id}/messages`,{text:'Измени только цель: спасти мир и маяк'});assert.equal((await f.done()).status,'done');
 const next=f.store.getState().wizardSessions.find(s=>s.id===id).artifact;
 assert.equal(next.data.goal,'Спасти маяк вместо поиска сокровищ');
 for(const key of ['name','world','start','details','playerCount'])assert.equal(next.data[key],first.data[key]);
 const saved=await f.request(`/wizard/${id}/artifact`,{version:next.version,field:'start',value:'Начинаем на затопленной пристани'},'PUT');assert.equal(saved.status,200);
 const exported=(await f.request(`/wizard/${id}/export`)).data;assert.equal(exported.spec,'sas_storybook_v1');assert.equal(exported.storybook.start,'Начинаем на затопленной пристани');
 assert.equal((await f.request('/import',{kind:'storybook',data:exported})).status,200);
 const applied=await f.request(`/wizard/${id}/apply`,{});assert.equal(applied.status,200);assert.equal(applied.data.kind,'storybook');
 assert.deepEqual((await f.request(`/wizard/${id}/apply`,{})).data,applied.data);
 const after=f.store.getState();for(const key of ['chats','characters','personas','lorebooks','fanficProjects','multiplayerHistories'])assert.deepEqual(after[key],before[key],'Unrelated collection changed: '+key);
 assert.equal(after.storybooks.length,before.storybooks.length+2);
});
test('Wizard creates all character blocks, exports importable JSON, binds lore, applies idempotently',async t=>{
  const f=await fixture(t),id=await f.create();assert.equal((await f.request(`/wizard/${id}/messages`,{text:'Создай персонажа и лорбук'})).status,202);assert.equal((await f.done()).status,'done');
  const session=f.store.getState().wizardSessions[0];assert.equal(session.artifact.kind,'character');assert.equal(session.artifact.lorebooks.length,1);assert.ok(session.artifact.data.firstMessage);assert.equal(f.calls.length,10);assert.deepEqual(session.artifact.data.blocks,[]);
  const exported=(await f.request(`/wizard/${id}/export`)).data;assert.equal(exported.spec,'chara_card_v2');assert.ok(exported.data.character_book.entries.length);
  const imported=await f.request('/import',{kind:'character',data:exported});assert.equal(imported.status,200);assert.equal(imported.data.imported.lorebookIds.length,1);
  const state=f.store.getState(),book=state.lorebooks.find(b=>b.id===imported.data.imported.lorebookIds[0]);assert.equal(book.enabled,false);assert.equal(book.entries[0].enabled,true);
  const first=await f.request(`/wizard/${id}/apply`,{}),second=await f.request(`/wizard/${id}/apply`,{});assert.deepEqual(first.data,second.data);
  assert.equal(f.store.getState().characters.filter(c=>c.id===first.data.id).length,1);
});
test('Wizard remembers revisions but preserves unselected persona fields and isolates new conversations',async t=>{
  const f=await fixture(t),id=await f.create();await f.request(`/wizard/${id}/messages`,{text:'Создай персону Марк'});assert.equal((await f.done()).status,'done');const before=f.store.getState().wizardSessions[0].artifact;
  await f.request(`/wizard/${id}/messages`,{text:'Измени только внешность: синее пальто. Лорбуки оставь без изменений.'});assert.equal((await f.done()).status,'done');const after=f.store.getState().wizardSessions[0].artifact;
  assert.equal(after.data.personality,before.data.personality);assert.equal(after.data.description,before.data.description);assert.equal(after.data.appearance,'Синее пальто');assert.notEqual(after.version,before.version);
  assert.ok(f.calls.at(-1).context.messages.some(m=>m.content==='Создай персону Марк'));assert.deepEqual(Object.keys(f.calls.at(-1).schema.properties),['appearance']);
  const file=wizardExport(after);assert.equal(importPersona(file).appearance,'Синее пальто');assert.equal((await f.request('/import',{kind:'persona',data:file})).status,200);
  const next=await f.create();await f.request(`/wizard/${next}/messages`,{text:'Создай другого персонажа'});await f.done();assert.ok(!f.calls.at(-1).context.messages.some(m=>m.content.includes('Марк')));
});
test('Wizard failure keeps last artifact, stop saves partial sections, resume completes; state PUT cannot erase sessions',async t=>{
  const f=await fixture(t),id=await f.create();await f.request(`/wizard/${id}/messages`,{text:'Создай персонажа'});await f.done();const before=f.store.getState().wizardSessions[0].artifact;
  f.setBroken(true);await f.request(`/wizard/${id}/messages`,{text:'Сделай другую внешность'});assert.equal((await f.done()).status,'error');assert.deepEqual(f.store.getState().wizardSessions[0].artifact,before);
  f.setBroken(false);f.setSlow(true);const other=await f.create();await f.request(`/wizard/${other}/messages`,{text:'Создай персонажа'});
  assert.equal((await f.request(`/wizard/${id}`,undefined,'DELETE')).status,409);
  for(let i=0;i<100&&!f.store.getState().wizardSessions[0].completed?.length;i++)await wait(20);
  await f.request('/tasks/stop',{});assert.equal((await f.done()).status,'stopped');assert.ok(f.store.getState().wizardSessions[0].completed.length);
  f.setSlow(false);await f.request(`/wizard/${other}/resume`,{});assert.equal((await f.done()).status,'done');
  const s=f.store.getState();s.wizardSessions=[];assert.equal((await f.request('/state',s,'PUT')).status,200);assert.equal(f.store.getState().wizardSessions.length,2);
  assert.equal((await f.request(`/wizard/${other}`,undefined,'DELETE')).status,200);assert.equal(f.store.getState().wizardSessions.length,1);
});
test('Wizard rejects malformed fields; portraits allow bounded local images and invitation URLs list VPN/LAN',()=>{
  assert.throws(()=>validateWizardObject({name:2},{type:'object',properties:{name:{type:'string'}}}));
  assert.equal(safeAvatar('data:image/svg+xml;base64,AAAA'),'✧');assert.equal(safeAvatar('https://tracking.invalid/a.png'),'✧');assert.equal(safeAvatar('data:image/png;base64,AAAA'),'data:image/png;base64,AAAA');
  const urls=invitationUrls(3211,'a+b',{'Ethernet':[{family:'IPv4',address:'192.168.0.5'}],'VPN':[{family:'IPv4',address:'10.20.0.3'}],'Loopback':[{family:'IPv4',address:'127.0.0.1'}]});
  assert.equal(urls.length,3);assert.equal(urls[1].name,'VPN');assert.equal(new URL(urls[1].url).searchParams.get('code'),'a+b');assert.equal(new URL(urls[1].url).hostname,'10.20.0.3');
});

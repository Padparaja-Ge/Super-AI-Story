import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startWebServer} from '../server/web.mjs';
import {networkDefaults,validateNetwork} from '../server/network.mjs';
import {contextSwipe} from '../shared/context-swipe.mjs';
import {createStore} from '../server/store.mjs';
import {createTasks} from '../server/tasks.mjs';
import {createWizard,loreOnlyRequest} from '../server/wizard.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-041-'));t.after(async()=>{assert.ok(dir.startsWith(path.join(os.tmpdir(),'sas-041-')));await fs.rm(dir,{recursive:true,force:true});});return dir;}
test('Configured access key, empty key, hot rotation and restart use the configuration file',async t=>{
  const dir=await temp(t),file=path.join(dir,'web-server.json'),config={...networkDefaults,host:'0.0.0.0',accessKey:'мой ключ 123'};
  await fs.writeFile(file,JSON.stringify(config));let web=await startWebServer({port:0,dataDir:dir,networkFile:file,coreMode:'embedded'});t.after(()=>web.close());
  const request=(url,options={})=>fetch(`http://127.0.0.1:${web.port}`+url,options);
  const login=password=>request('/auth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}),redirect:'manual'});
  const update=(value,cookie)=>request('/api/network',{method:'PUT',headers:{'Content-Type':'application/json','X-SAS-Client':'test',cookie},body:JSON.stringify({...value,port:web.port})});
  assert.equal((await request('/api/state')).status,401);assert.equal((await login('wrong')).status,401);
  const authenticated=await login(config.accessKey);assert.equal(authenticated.status,302);const cookie=authenticated.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/state',{headers:{cookie}})).status,200);
  const rotated=await update({...config,accessKey:'replacement'},cookie);assert.equal(rotated.status,200);const renewed=rotated.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/state',{headers:{cookie}})).status,401);assert.equal((await request('/api/state',{headers:{cookie:renewed}})).status,200);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).accessKey,'replacement');
  assert.equal((await update({...config,accessKey:''},renewed)).status,200);assert.equal((await request('/api/state')).status,200);assert.equal(web.authRequired,false);
  await web.close();web=await startWebServer({port:0,dataDir:dir,networkFile:file,coreMode:'embedded'});assert.equal((await request('/api/state')).status,200);
  await fs.writeFile(file,JSON.stringify({...config,accessKey:'edited-before-start'}));assert.equal((await request('/api/state')).status,401);assert.equal((await login('edited-before-start')).status,302);
  assert.throws(()=>validateNetwork({...config,accessKey:17}));assert.throws(()=>validateNetwork({...config,accessKey:'a\nb'}));
});
test('Desktop saves shared access key without locking its own local GUI',async t=>{
 const dir=await temp(t),file=path.join(dir,'web-server.json');await fs.writeFile(file,JSON.stringify({...networkDefaults,accessKey:'remote-key'}));
 const web=await startWebServer({port:0,dataDir:dir,networkFile:file,desktop:true,coreMode:'embedded'});t.after(()=>web.close());
 assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/state`)).status,200);
});
test('Drawer swipe distinguishes edge swipe and reverse gesture from text/vertical scrolling',()=>{
 const base={startX:380,startY:200,endX:260,endY:208,width:390,open:false};assert.equal(contextSwipe(base),'open');
 assert.equal(contextSwipe({...base,startX:120} ),null);assert.equal(contextSwipe({...base,endY:450}),null);assert.equal(contextSwipe({...base,endX:350}),null);
 assert.equal(contextSwipe({...base,open:true,startX:230,endX:350}),'close');assert.equal(contextSwipe({...base,open:true}),null);
});
test('Adding lore to an existing card does not rewrite any fields, create custom blocks, or duplicate prior entries',async t=>{
 const dir=await temp(t),store=createStore(dir),tasks=createTasks(),calls=[];t.after(()=>tasks.stop());
 const state=store.getState(),original={kind:'character',data:structuredClone(state.characters[0]),summary:'Existing character',lorebooks:[{name:'Канон',description:'Сохранить',entries:[{name:'История',content:'Не менять',keys:['архив'],constant:false}]}]};
 state.connections[0].model='test';state.wizardSessions=[{id:'edit',messages:[],artifact:original}];store.saveState(state);
 let failEntry=false;
 const complete=async opts=>{
  calls.push(opts);if(opts.name==='wizard_edit_plan')return {summary:'Добавлен лорбук взаимодействия.',fields:['description','personality','systemPrompt'],lorebooks:[{name:'Взаимодействие',target:-1,instruction:'Взаимодействие с игроком'}]};
  if(opts.name==='wizard_outline')return {description:'Правила отношений',entries:[{name:'Доверие',keys:['доверие'],brief:'Доверие',target:-1},{name:'Ссоры',keys:['ссора'],brief:'Ссоры',target:-1}]};
  if(opts.name==='wizard_entry'){if(failEntry&&opts.context.entry.name==='Ссоры')throw new Error('Endpoint interrupted');return {content:'Реакция на '+opts.context.entry.name};}
  throw new Error('Unexpected character rewrite: '+opts.name);
 };
 const wizard=createWizard({...store,tasks,getSecret:()=>'',complete});
 const done=async()=>{for(let i=0;i<100&&tasks.busy();i++)await wait(10);return tasks.publicTask();};
 failEntry=true;await wizard.generate('edit','Добавь персонажу лор бук для более подробного описания взаимодействия с игроком.');assert.equal((await done()).status,'error');assert.deepEqual(store.getState().wizardSessions[0].artifact,original);
 failEntry=false;await wizard.generate('edit','',true);assert.equal((await done()).status,'done');let updated=store.getState().wizardSessions[0].artifact;
 assert.deepEqual(updated.data,original.data);assert.deepEqual(updated.lorebooks[0],original.lorebooks[0]);assert.equal(updated.lorebooks[1].entries.length,2);
 assert.ok(calls.filter(c=>c.name==='wizard_entry').every(c=>Object.keys(c.schema.properties).join()==='content'));assert.equal(calls.filter(c=>c.name==='wizard_outline').length,1);
 await wizard.generate('edit','Доработай лорбук Взаимодействие.');assert.equal((await done()).status,'done');updated=store.getState().wizardSessions[0].artifact;assert.equal(updated.lorebooks.length,2);assert.equal(updated.lorebooks[1].entries.length,2);assert.deepEqual(updated.data,original.data);
 assert.equal(loreOnlyRequest('Добавь лорбук и измени внешность'),false);assert.equal(loreOnlyRequest('Добавь лорбук для подробного описания взаимодействия'),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {startWebServer} from '../server/web.mjs';
import {networkDefaults,isAddressAllowed,validateNetwork} from '../server/network.mjs';
import {createStore} from '../server/store.mjs';
import {inferScene} from '../server/language.mjs';
import {parseObject} from '../server/services/structuredCompletion.js';
import {makeSceneImagePrompt,visualTags,positivePrompt} from '../server/services/imagePromptService.js';
import {prepareWorkflow} from '../server/comfy-workflow.mjs';
import {comfyDefaults} from '../shared/defaults.mjs';

async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-031-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'sas-031-')));await fs.rm(dir,{recursive:true,force:true});});return dir;}
async function listener(t,handler,host='127.0.0.1'){const server=http.createServer(handler);await new Promise(r=>server.listen(0,host,r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return server;}
test('Access mode activates only one list; empty blacklist allows all, empty whitelist denies all',()=>{
  const config={...networkDefaults,allowlist:['10.0.0.0/8','2001:db8::/32'],blocklist:['10.0.0.9','2001:db8::9']};
  for(const ip of ['10.0.0.9','::ffff:10.0.0.9','2001:db8::9'])assert.equal(isAddressAllowed(config,ip),true);
  assert.equal(isAddressAllowed(config,'192.168.1.3'),false);
  const blacklist={...config,mode:'blocklist'};assert.equal(isAddressAllowed(blacklist,'10.0.0.9'),false);assert.equal(isAddressAllowed(blacklist,'192.168.1.3'),true);
  assert.equal(isAddressAllowed({...blacklist,blocklist:[]},'8.8.8.8'),true);
  assert.equal(isAddressAllowed({...config,allowlist:[]},'127.0.0.1'),false);
  assert.throws(()=>validateNetwork({...config,mode:'both'}));
});
test('Network PUT rebinds live host and port, persists settings and rolls back an occupied port',async t=>{
  const dir=await temp(t),file=path.join(dir,'web-server.json');
  const web=await startWebServer({port:0,host:'127.0.0.1',dataDir:dir,networkFile:file,coreMode:'embedded'});t.after(()=>web.close());
  let cookie='';
  const put=body=>fetch(`http://127.0.0.1:${web.port}/api/network`,{method:'PUT',headers:{'Content-Type':'application/json','X-SAS-Client':'test',cookie},body:JSON.stringify(body)});
  const config={...networkDefaults,host:'0.0.0.0',port:web.port,allowlist:['localhost','192.168.0.0/16']};
  const applied=await put(config);assert.equal(applied.status,200,await applied.clone().text());cookie=applied.headers.get('set-cookie').split(';')[0];
  const data=await applied.json();assert.equal(data.generatedPassword,undefined);assert.equal(data.runtime.authRequired,false);assert.equal(web.host,'0.0.0.0');assert.equal(web.server.address().address,'0.0.0.0');assert.equal(data.runtime.port,web.port);
  assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/state`,{headers:{cookie}})).status,200);
  const occupied=await listener(t,(_req,res)=>res.end('occupied'),'0.0.0.0');
  assert.equal((await put({...config,port:occupied.address().port})).status,400);
  assert.equal(web.port,config.port);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).port,config.port);
  const spare=await listener(t,(_req,res)=>res.end());const newPort=spare.address().port;await new Promise(r=>spare.close(r));
  const moved=await put({...config,port:newPort,mode:'blocklist',blocklist:['10.0.0.0/8']});assert.equal(moved.status,200);assert.equal(web.port,newPort);
  assert.equal((await fetch(`http://127.0.0.1:${newPort}/api/state`,{headers:{cookie}})).status,200);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).mode,'blocklist');
});
test('Startup reads host from config; desktop remains loopback even with a blocking web policy',async t=>{
  const dir=await temp(t),file=path.join(dir,'web-server.json');await fs.writeFile(file,JSON.stringify({...networkDefaults,host:'0.0.0.0',mode:'blocklist',blocklist:['localhost']}));
  const web=await startWebServer({port:0,dataDir:dir,networkFile:file,coreMode:'embedded',password:'test'});t.after(()=>web.close());assert.equal(web.host,'0.0.0.0');assert.equal((await fetch(`http://127.0.0.1:${web.port}/`)).status,403);
  const desktop=await startWebServer({port:0,host:'127.0.0.1',desktop:true,dataDir:dir,networkFile:file,coreMode:'embedded'});t.after(()=>desktop.close());assert.equal((await fetch(`http://127.0.0.1:${desktop.port}/api/state`)).status,200);
  const res=await fetch(`http://127.0.0.1:${desktop.port}/api/network`,{method:'PUT',headers:{'Content-Type':'application/json','X-SAS-Client':'test'},body:JSON.stringify({...networkDefaults,host:'0.0.0.0',mode:'blocklist',blocklist:['localhost']})});assert.equal(res.status,200);assert.equal(desktop.server.address().address,'127.0.0.1');
});
async function model(t,replies,{local=true}={}){
  const calls=[],dir=await temp(t),store=createStore(dir);
  const server=await listener(t,async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);const reply=replies[Math.min(calls.length-1,replies.length-1)];res.setHeader('Content-Type','application/json');if(reply.status){res.writeHead(reply.status);res.end(JSON.stringify({error:{message:'response_format unsupported'}}));}else res.end(JSON.stringify({choices:[{message:{content:reply}}]}));});
  const state=store.getState(),chat=state.chats[0];state.connections=[{id:local?'sas-local':'external',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'test',contextWindow:8192}];state.activeConnectionId=state.connections[0].id;
  chat.messages=[{role:'user',content:'Мы вошли в дом Тонерико.'},{role:'assistant',content:'Тонерико держит блокнот и ручку у окна.'}];state.plugins.find(p=>p.id==='rpg').enabled=true;chat.scene.autoUpdate=true;
  Object.assign(state.characters.find(c=>c.id===chat.characterId),{name:'Toneriko',appearance:'Cream fur, cat ears, amber eyes, glasses',description:'A government clerk wearing a navy blazer'});
  return {state,chat,calls};
}
test('Scene uses native JSON schema on local model, retries prose, strips reasoning and saves short scene fields',async t=>{
  const f=await model(t,['She opens the door and smiles.','<think>not part of scene</think>\n```json\n{"location":"Дом Тонерико","time":"Вечер","weather":"Дождь"}\n```']);
  const scene=await inferScene(f.state,f.chat,()=>'',undefined);assert.equal(scene.location,'Дом Тонерико');assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].response_format.type,'json_object');assert.deepEqual(f.calls[0].response_format.schema.required,['location','time','weather']);assert.equal(f.calls[0].chat_template_kwargs.enable_thinking,false);
  assert.ok(f.calls[0].max_tokens>=600);assert.equal(f.chat.messages.length,2);
});
test('Scene supports APIs without response_format and preserves previous scene on invalid responses',async t=>{
  const f=await model(t,[{status:400},'{"location":"Дом","time":"","weather":""}'],{local:false});assert.equal((await inferScene(f.state,f.chat,()=>'',undefined)).location,'Дом');assert.equal(f.calls[1].response_format,undefined);
  const bad=await model(t,['{"location":42,"time":null,"weather":[]}']);const before=structuredClone(bad.chat.scene);await assert.rejects(inferScene(bad.state,bad.chat,()=>'',undefined),/формат/);assert.deepEqual(bad.chat.scene,before);assert.equal(bad.calls.length,2);
});
test('JSON parser handles quoted braces instead of greedy first-to-last brace extraction',()=>{
  assert.deepEqual(parseObject('result {"location":"Комната {А}","time":"","weather":""} trailing {bad}'),{location:'Комната {А}',time:'',weather:''});
});
const tagObject={subject:['Toneriko','anthropomorphic cat woman'],appearance:['cream fur','amber eyes','round glasses'],clothing:['navy blazer'],pose:['holding a pen and notepad'],expression:['hopeful gaze'],environment:['office interior'],lighting:['soft window light'],composition:['medium close-up']};
test('Image prompt converts narration to visual facts, preserves character context and applies editable prefix once',async t=>{
  const f=await model(t,['Toneriko watches you carefully as you pull out the crumpled piece of paper.\n\nShe speaks in her native language.',JSON.stringify(tagObject)]);
  const prompt=await makeSceneImagePrompt(f.state,f.chat,()=>'',undefined);assert.match(prompt,/^masterpiece, best quality/);assert.match(prompt,/cream fur/);assert.match(prompt,/holding a pen and notepad/);assert.doesNotMatch(prompt,/She speaks|watches you/);assert.equal(f.calls.length,2);
  const source=JSON.parse(f.calls[0].messages[1].content);assert.match(source.character.appearance,/amber eyes/);assert.match(source.recent.at(-1).content,/блокнот/);
  assert.equal(positivePrompt(f.state.settings.comfy,prompt),prompt);assert.equal(positivePrompt({positivePrefix:'watercolor'},'cat woman, glasses, desk'),'watercolor, cat woman, glasses, desk');
});
test('Image prompt refuses repeated roleplay prose rather than forwarding it to ComfyUI',async t=>{
  const f=await model(t,['She smiles at you and says hello.']);await assert.rejects(makeSceneImagePrompt(f.state,f.chat,()=>'',undefined),/визуальных тегов/);assert.equal(f.calls.length,2);
  assert.throws(()=>visualTags('I look at you. Then I speak.'),/визуальных тегов/);
});

test('Valid possessive visual phrases from local models do not trigger format failures',async t=>{
 const tags={...tagObject,pose:['standing beside a wooden table','tail wrapped around her leg'],clothing:['her navy blazer','his dark coat','their worn boots']};
 const f=await model(t,[JSON.stringify(tags)]);const prompt=await makeSceneImagePrompt(f.state,f.chat,()=>'',undefined);
 assert.match(prompt,/tail wrapped around leg/);assert.match(prompt,/navy blazer/);assert.equal(f.calls.length,1);
 assert.doesNotMatch(prompt,/\b(?:her|his|their)\s/);assert.throws(()=>visualTags('She smiles at you and writes her name. Then she leaves.'),/визуальных тегов/);
});
const workflow={
  '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'original.safetensors'}},
  '2':{class_type:'LoraLoader',inputs:{model:['1',0],clip:['1',1],lora_name:'character.safetensors',strength_model:.7,strength_clip:.8}},
  '3':{class_type:'CLIPTextEncode',inputs:{clip:['2',1],text:'old positive'}},
  '4':{class_type:'CLIPTextEncode',inputs:{clip:['2',1],text:'old negative'}},
  '5':{class_type:'ControlNetApplyAdvanced',inputs:{positive:['3',0],negative:['4',0],strength:.6}},
  '6':{class_type:'EmptyLatentImage',inputs:{width:1024,height:768,batch_size:1}},
  '7':{class_type:'KSampler',inputs:{model:['2',0],positive:['5',0],negative:['5',1],latent_image:['6',0],seed:1,steps:24,cfg:7}},
  '8':{class_type:'SaveImage',inputs:{images:['9',0],filename_prefix:'test'}}
};
test('Automatic workflow mapping follows ControlNet conditioning, preserves LoRA and sampler settings, sets dimensions and checkpoint',()=>{
  const config={...comfyDefaults,workflow,model:'selected.safetensors',width:512,height:512};
  const result=prepareWorkflow(config,'cat woman, round glasses, office',123);
  assert.equal(result['1'].inputs.ckpt_name,'selected.safetensors');assert.deepEqual(result['2'],workflow['2']);assert.deepEqual(result['5'],workflow['5']);assert.match(result['3'].inputs.text,/masterpiece.*cat woman/);assert.equal(result['4'].inputs.text,comfyDefaults.negative);
  assert.equal(result['6'].inputs.width,512);assert.equal(result['6'].inputs.height,512);assert.equal(result['7'].inputs.seed,123);assert.equal(result['7'].inputs.steps,24);assert.equal(workflow['6'].inputs.width,1024);
  assert.throws(()=>prepareWorkflow({...config,width:513},'cat, glasses, office'),/кратный/);
});

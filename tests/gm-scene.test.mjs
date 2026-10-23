import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {inferScene} from '../server/language.mjs';
import {sanitizeState} from '../server/store.mjs';
const seed=JSON.parse(await fs.readFile(new URL('../shared/seed.json',import.meta.url),'utf8'));
test('D&D scene tracking works with isolated plugins and ignores dice and incomplete narration',async t=>{
 const calls=[],provider=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;calls.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({location:'Лавка Арвина',time:'день',weather:'ясно'})}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{provider.close(r);provider.closeAllConnections();}));
 const state=sanitizeState(structuredClone(seed));state.plugins=[];state.connections[0].baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;state.connections[0].model='test';state.connections[0].contextWindow=8192;
 const chat={id:'room-test',characterId:'sas-gm',connectionId:state.connections[0].id,scene:{location:'Рыночная площадь',autoUpdate:true},messages:[{role:'user',content:'Вхожу в лавку Арвина.'},{role:'user',kind:'dice',content:'FREE_D20_NOT_SCENE'},{role:'assistant',interrupted:true,content:'INCOMPLETE_NOT_CANON'},{role:'assistant',content:'Арвин встречает вошедшего в своей лавке.'}]};
 const before=structuredClone(chat);
 assert.equal(await inferScene(state,chat,()=>''),null,'Solo plugin state must remain isolated');
 const scene=await inferScene(state,chat,()=>'',undefined,{game:true});assert.equal(scene.location,'Лавка Арвина');assert.equal(calls.length,1);
 const context=JSON.parse(calls[0].messages[1].content);assert.match(context.constraint,/движения и решения героев выбирают только игроки/);assert.equal(context.messages.length,2);assert.doesNotMatch(JSON.stringify(context),/FREE_D20_NOT_SCENE|INCOMPLETE_NOT_CANON/);assert.deepEqual(chat,before);
 assert.equal(await inferScene(state,{...chat,scene:{...chat.scene,autoUpdate:false}},()=>'',undefined,{game:true}),null);assert.equal(calls.length,1);
});

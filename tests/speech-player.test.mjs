import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

async function player(){
 const code=ts.transpileModule(await fs.readFile(new URL('../src/speechPlayer.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('../shared/speech.mjs',new URL('../shared/speech.mjs',import.meta.url).href);
 return import('data:text/javascript;base64,'+Buffer.from(code+'\n// '+Math.random()).toString('base64'));
}
const tick=()=>new Promise(r=>setImmediate(r));
function environment(t,fetch){
 const saved={fetch:globalThis.fetch,window:globalThis.window,AudioContext:globalThis.AudioContext},sources=[];
 globalThis.window={};globalThis.fetch=fetch;
 globalThis.AudioContext=class{
  destination={};resume(){return Promise.resolve();}decodeAudioData(){return Promise.resolve({});}
  createGain(){return {gain:{value:0},connect(){},disconnect(){}};}
  createBufferSource(){const source={connect(){},disconnect(){},start(){sources.push(source);},stop(){source.onended?.();}};return source;}
 };
 t.after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete globalThis[k];else globalThis[k]=v;});return sources;
}
test('Playback prefetches only one sentence, preserves sequence and deletes its session at the end',async t=>{
 const calls=[],sources=environment(t,async(url,options={})=>{calls.push([String(url),options.method||'GET']);if(options.method==='POST')return Response.json({id:'reading',count:3});return new Response(new Uint8Array(44));}),p=await player(),done=p.playSpeech('post','One. Two. Three.',{pauseMs:0});
 await tick();assert.equal(sources.length,1);assert.equal(calls.filter(([u])=>u.endsWith('/0')).length,1);assert.equal(calls.filter(([u])=>u.endsWith('/1')).length,1);assert.ok(!calls.some(([u])=>u.endsWith('/2')));
 sources[0].onended();await tick();assert.equal(sources.length,2);assert.equal(p.speechSnapshot().index,2);assert.equal(calls.filter(([u])=>u.endsWith('/2')).length,1);
 sources[1].onended();await tick();sources[2].onended();await done;assert.equal(p.speechSnapshot().phase,'idle');assert.deepEqual(calls.at(-1),['/api/speech/sessions/reading','DELETE']);
});
test('Stopping while session creation finishes cleans the late response without starting playback',async t=>{
 let complete;const calls=[];environment(t,async(url,options={})=>{calls.push([String(url),options.method]);if(options.method==='POST')return new Promise(r=>complete=r);return Response.json({ok:true});});const p=await player(),done=p.playSpeech('old','A sentence.',{});await tick();p.stopSpeech();complete(Response.json({id:'late',count:1}));await done;
 assert.ok(calls.some(([u,m])=>u.endsWith('/late')&&m==='DELETE'));assert.equal(p.speechSnapshot().phase,'idle');assert.equal(calls.filter(([,m])=>m==='GET').length,0);
});
test('Switching from a Fanfic reader to RP stops the old audio and keeps the new session alive',async t=>{
 let count=0;const calls=[],sources=environment(t,async(url,options={})=>{calls.push([String(url),options.method||'GET']);if(options.method==='POST')return Response.json({id:'reader-'+(++count),count:2});return new Response(new Uint8Array(44));}),p=await player(),first=p.playSpeech('fanfic:one','Первая серия. Продолжение.',{pauseMs:0});await tick();assert.equal(sources.length,1);
 const second=p.playSpeech('rp:two','Ответ персонажа. Завершение.',{pauseMs:0});await tick();await first;assert.equal(p.speechSnapshot().key,'rp:two');assert.ok(calls.some(([url,method])=>url.endsWith('/reader-1')&&method==='DELETE'));assert.equal(sources.length,2);sources[1].onended();await tick();sources[2].onended();await second;assert.ok(calls.some(([url,method])=>url.endsWith('/reader-2')&&method==='DELETE'));
});
test('System voices apply the same pronunciation dictionary without changing story text',async t=>{
 const spoken=[],old=globalThis.SpeechSynthesisUtterance;environment(t,async()=>{throw Error('No backend request expected');});globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};t.after(()=>{if(old===undefined)delete globalThis.SpeechSynthesisUtterance;else globalThis.SpeechSynthesisUtterance=old;});window.speechSynthesis={cancel(){},speak(u){spoken.push(u.text);queueMicrotask(()=>u.onend());}};
 const text='Тонерико подошла к окну.',p=await player();await p.playSpeech('fanfic:system',text,{provider:'system',pronunciations:[{from:'Тонерико',to:'Тонэрико'}]});assert.deepEqual(spoken,['Тонэрико подошла к окну.']);assert.equal(text,'Тонерико подошла к окну.');
});

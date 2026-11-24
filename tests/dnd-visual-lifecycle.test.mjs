import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {collectNewRolls,hasPhysicalDie} from '../shared/dice-visual.mjs';

async function compile(name,require,globals={}){
 const source=await fs.readFile(new URL('../src/dnd-visuals/'+name,import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context=vm.createContext({exports:{},require,console,setTimeout,clearTimeout,performance,AbortController,...globals});
 vm.runInContext(code,context,{filename:name});return context.exports;
}

function hooks(){
 const slots=[];let cursor=0,pending=[];
 const same=(before,after)=>before&&after&&before.length===after.length&&before.every((value,index)=>Object.is(value,after[index]));
 const api={
  useRef(initial){const index=cursor++;if(!slots[index])slots[index]={kind:'ref',value:{current:initial}};return slots[index].value;},
  useState(initial){const index=cursor++;if(!slots[index])slots[index]={kind:'state',value:initial};return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
  useCallback(callback,deps){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={kind:'callback',value:callback,deps};return slots[index].value;},
  useEffect(effect,deps){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))pending.push(()=>{slots[index]?.cleanup?.();slots[index]={kind:'effect',deps,cleanup:effect()};});},
 };
 return {api,render(component,props){cursor=0;pending=[];const tree=component(props);for(const effect of pending)effect();return tree;},states:()=>slots.filter(slot=>slot.kind==='state').map(slot=>slot.value),unmount(){for(const slot of slots)slot.cleanup?.();}};
}

async function layerFixture(settings={}){
 const react=hooks(),timers=new Map();let nextTimer=0;
 const preferences={dice3d:false,cinematics:true,autoSkipCinematics:false,resultHold:2.2,volume:0,quality:'low',...settings};
 const modules={
  react:react.api,
  'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  '../i18n':{t:text=>text},
  '../../shared/dice-visual.mjs':{collectNewRolls,hasPhysicalDie},
  '../../shared/equipment.mjs':{checkSkills:[]},
  '../../shared/srp.mjs':{abilityNames:{}},
  './settings':{getVisualSettings:()=>preferences,useVisualSettings:()=>preferences,qualityProfile:()=>({pixelRatio:1}),prefersReducedMotion:()=>false},
  './audio':{SoundBus:{create:()=>null},diceClack(){},resultChime(){}},
  './cinematics/CinematicPlayer':{CinematicPlayer(){},preloadCinematics(){}},
  './replay':{rememberCinematic(){},setReplayHandler(){}},
  './dnd-visuals.css':{},
 };
 const exports=await compile('DnDVisualLayer.tsx',name=>{if(!(name in modules))throw Error('Unexpected import '+name);return modules[name];},{document:{hidden:false},window:{addEventListener(){},removeEventListener(){},setTimeout(callback){const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)},clearTimeout:id=>timers.delete(id)});
 return {...react,timers,component:exports.DnDVisualLayer};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const roll=(id,critical=null)=>({id,text:'roll',calculation:{kind:'check',die:20,roll:critical==='success'?20:critical==='failure'?1:7,rolls:[critical==='success'?20:critical==='failure'?1:7],total:7,modifier:0,critical,success:critical!=='failure'}});

test('Changing rooms cancels a cinematic and releases the queue for the new room',async()=>{
 const fixture=await layerFixture();
 fixture.render(fixture.component,{roomKey:'first',game:{log:[]}});
 fixture.render(fixture.component,{roomKey:'first',game:{log:[roll('first-roll','success')]}});
 assert.equal(fixture.states()[0].phase,'cinematic');
 fixture.render(fixture.component,{roomKey:'second',game:{log:[]}});await flush();
 assert.equal(fixture.states()[0],null);
 fixture.render(fixture.component,{roomKey:'second',game:{log:[roll('second-roll','failure')]}});
 assert.equal(fixture.states()[0].roll.eventId,'second-roll');assert.equal(fixture.states()[0].phase,'cinematic');
 fixture.unmount();await flush();assert.equal(fixture.timers.size,0);
});

test('A burst of engine events keeps only six pending presentations while preserving the engine log',async()=>{
 const fixture=await layerFixture({cinematics:false}),log=[];
 fixture.render(fixture.component,{roomKey:'room',game:{log:[]}});
 for(let index=0;index<30;index++){log.push(roll('roll-'+index));fixture.render(fixture.component,{roomKey:'room',game:{log:[...log]}});}
 assert.equal(fixture.states()[0].queue,6);assert.equal(log.length,30);
 fixture.unmount();await flush();assert.equal(fixture.timers.size,0);
});

test('Disposing the dice stage resolves its pending animations and future calls immediately',async()=>{
 const exports=await compile('DiceStage.ts',()=>({}),{requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
 const stage=Object.create(exports.DiceStage.prototype);Object.assign(stage,{disposed:false,tickers:new Set(),raf:0,last:0,dice:[],cores:new Map(),disposables:[],renderer:{dispose(){},forceContextLoss(){}}});
 let finished=false,lastFrame=0;const pending=stage.tween(1,value=>lastFrame=value).then(()=>finished=true);assert.equal(finished,false);
 stage.dispose();await pending;assert.equal(finished,true);assert.equal(lastFrame,1);assert.equal(stage.tickers.size,0);
 await stage.tween(1,value=>lastFrame=value);assert.equal(stage.tickers.size,0);
 assert.equal((await stage.play({dice:[]})).length,0);
});

test('Overlapping sound buses share impulse data while keeping independent reverb routing and cleanup',async()=>{
 const exports=await compile('audio.ts',()=>{throw Error('No imports expected');},{setTimeout:callback=>{callback();return 1;}});
 class Node{
  connections=[];gain={value:0,cancelScheduledValues(){},setValueAtTime(){},linearRampToValueAtTime(){}};
  connect(target){this.connections.push(target);}disconnect(){this.connections=[];}
 }
 const convolvers=[],ac={sampleRate:100,currentTime:0,destination:{},createGain:()=>new Node(),createConvolver(){const node=new Node();convolvers.push(node);return node;},createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {sampleRate,getChannelData:channel=>data[channel]};}};
 const first=new exports.SoundBus(ac,.8),second=new exports.SoundBus(ac,.3);
 assert.equal(convolvers.length,2);assert.equal(convolvers[0].buffer,convolvers[1].buffer);
 assert.deepEqual(convolvers[0].connections,[first.out]);assert.deepEqual(convolvers[1].connections,[second.out]);
 first.stop();assert.equal(convolvers[0].connections.length,0);assert.deepEqual(convolvers[1].connections,[second.out]);
 second.stop();assert.equal(convolvers[1].connections.length,0);
});

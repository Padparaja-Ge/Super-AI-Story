import test from 'node:test';
import assert from 'node:assert/strict';
import {guidePreferences,readGuidePreferences,writeGuidePreferences,GUIDE_STEPS,GUIDE_STORAGE_KEY} from '../shared/onboarding.mjs';
import {windowsVersion} from '../scripts/launch-desktop.mjs';
import permissions from '../electron/permissions.cjs';
import closePolicy from '../electron/close-policy.cjs';

test('Beginner guide preferences are local, bounded and safe when storage is unavailable',()=>{
  assert.deepEqual(guidePreferences(),{version:1,enabled:true,welcomed:false,completed:false,step:0});
  assert.equal(guidePreferences({enabled:false,step:100000}).step,GUIDE_STEPS.length-1);
  assert.equal(guidePreferences({step:-3}).step,0);
  assert.equal(guidePreferences({step:'2'}).step,0);
  assert.equal(guidePreferences({enabled:'false'}).enabled,true);
  assert.equal(readGuidePreferences({getItem(){throw Error('blocked');}}).enabled,true);
  assert.equal(readGuidePreferences({getItem(){return '{broken';}}).step,0);
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const prefs=writeGuidePreferences(storage,{enabled:false,welcomed:true,completed:true,step:3});
  assert.equal(values.size,1);assert.ok(values.has(GUIDE_STORAGE_KEY));
  assert.deepEqual(readGuidePreferences(storage),prefs);
  assert.equal(writeGuidePreferences({setItem(){throw Error('blocked');}},prefs).completed,true);
});

test('Guide distinguishes roleplay, fanfic and multiplayer memory, rules and lore',()=>{
  assert.equal(GUIDE_STEPS.length,6);
  const story=GUIDE_STEPS.find(step=>step.id==='stories'),fanfic=GUIDE_STEPS.find(step=>step.id==='fanfic'),multi=GUIDE_STEPS.find(step=>step.id==='multiplayer');
  assert.match(story.points.join(' '),/выберите нужную историю/);
  assert.match(fanfic.tip,/не подмешивают память/);
  assert.match(multi.points.join(' '),/Rule book.*правила.*lore book.*мире/);
  assert.equal(new Set(GUIDE_STEPS.map(step=>step.id)).size,GUIDE_STEPS.length);
});

test('Desktop Windows resource version is explicit and rejects unsupported input',()=>{
  assert.equal(windowsVersion('0.9.1'),'0.9.1.0');
  assert.equal(windowsVersion('1.2.3-beta.4'),'1.2.3.0');
  assert.throws(()=>windowsVersion('oops'));
  assert.throws(()=>windowsVersion('65536.0.0'));
});

test('Desktop microphone is audio-only and restricted to its own main frame',()=>{
  const frame={},other={},origin='http://127.0.0.1:49678',details={isMainFrame:true,requestingUrl:origin+'/'};
  const request=(permission,extra={},contents=frame)=>permissions.requestPermission(contents,permission,{...details,...extra},frame,origin);
  const check=(permission,extra={},requestingOrigin=origin)=>permissions.checkPermission(frame,permission,requestingOrigin,{...details,...extra},frame,origin);
  assert.equal(request('media',{mediaTypes:['audio']}),true);
  assert.equal(check('media',{mediaType:'audio'}),true);
  for(const mediaTypes of [undefined,[],['video'],['audio','video'],['unknown']])assert.equal(request('media',{mediaTypes}),false);
  assert.equal(request('media',{mediaTypes:['audio'],isMainFrame:false}),false);
  assert.equal(request('media',{mediaTypes:['audio'],requestingUrl:'https://elsewhere.example/'}),false);
  assert.equal(request('media',{mediaTypes:['audio']},other),false);
  assert.equal(check('media',{mediaType:'video'}),false);
  assert.equal(check('media',{mediaType:'unknown'}),false);
  assert.equal(check('media',{mediaType:'audio'},'http://127.0.0.1:49679'),false);
  assert.equal(request('clipboard-sanitized-write'),true);
  assert.equal(check('clipboard-sanitized-write'),true);
  for(const name of ['clipboard-read','display-capture','geolocation','notifications'])assert.equal(request(name),false);
});

test('Desktop manual autosave close supports Save, Discard and Cancel without hidden writes',async()=>{
  let saves=0,prompts=0;
  const fixture=choice=>({getStatus:async()=>({enabled:false,dirty:true}),save:async()=>{saves++;},choose:async()=>{prompts++;return choice;}});
  assert.equal(await closePolicy.confirmManualClose(fixture('cancel')),false);assert.equal(saves,0);
  assert.equal(await closePolicy.confirmManualClose(fixture('discard')),true);assert.equal(saves,0);
  assert.equal(await closePolicy.confirmManualClose(fixture('save')),true);assert.equal(saves,1);
  assert.equal(prompts,3);
  for(const status of [{enabled:true,dirty:true},{enabled:false,dirty:false}]){
    assert.equal(await closePolicy.confirmManualClose({...fixture('save'),getStatus:async()=>status}),true);
  }
  assert.equal(saves,1);assert.equal(prompts,3);
  await assert.rejects(closePolicy.confirmManualClose({...fixture('save'),save:async()=>{throw Error('disk full');}}),/disk full/);
});

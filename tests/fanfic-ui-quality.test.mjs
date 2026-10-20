import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

// Exercise the same draft lifecycle used by React without adding a browser test dependency.
const source=await fs.readFile(new URL('../src/fanficDrafts.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {asEpisodeDraft,draftHasChanges,draftSavePayload,fanficStorageKey,persistEpisodeDraft,restoreEpisodeDraft,sameDraftScope}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const episode=(id='chapter')=>({id,revision:4,title:'Ключ',brief:'Герои нашли ключ.',content:'Мира передала ключ Борису.',season:2,number:3});
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};

test('Fanfic browser drafts and editor instructions cannot collide between works with the same episode id',()=>{
  const s=storage(),e=episode('shared-chapter'),a={...asEpisodeDraft('work-a',e),content:'Правки Мира.',dirty:true},b={...asEpisodeDraft('work-b',e),content:'Правки Борис.',dirty:true};
  assert.equal(persistEpisodeDraft(s,a),true);assert.equal(persistEpisodeDraft(s,b),true);
  assert.equal(restoreEpisodeDraft(s,'work-a',e).content,'Правки Мира.');assert.equal(restoreEpisodeDraft(s,'work-b',e).content,'Правки Борис.');
  assert.notEqual(fanficStorageKey('instruction','work-a',e.id),fanficStorageKey('instruction','work-b',e.id));
  assert.equal(sameDraftScope(a,'work-b',e.id),false);assert.equal(sameDraftScope(a,'work-a',e.id),true);
  persistEpisodeDraft(s,asEpisodeDraft('work-a',e));persistEpisodeDraft(s,asEpisodeDraft('work-b',e));
});

test('Fanfic polling cannot replace a dirty draft or silently update its expected revision',()=>{
  const s=storage(),e=episode('revision-chapter'),d={...asEpisodeDraft('revision-work',e),content:'Мой исправленный текст',dirty:true};
  persistEpisodeDraft(s,d);
  const restored=restoreEpisodeDraft(s,'revision-work',{...e,revision:9,content:'Новая серверная версия'});
  assert.equal(restored.content,d.content);assert.equal(draftSavePayload(restored).expectedRevision,4);
  assert.equal(restored.dirty,true);assert.equal(draftHasChanges(restored,e),true);
  persistEpisodeDraft(s,asEpisodeDraft('revision-work',{...e,revision:9}));
  assert.equal(restoreEpisodeDraft(s,'revision-work',{...e,revision:9}).dirty,false);
});

test('Fanfic restores valid legacy drafts but ignores broken storage, foreign scope, oversized text and invalid numbering',()=>{
  const s=storage(),e=episode('legacy-chapter'),key='sas-fanfic-draft-'+e.id,legacy={...asEpisodeDraft('legacy-work',e),dirty:true,brief:'Ручное задание'};
  delete legacy.projectId;s.setItem(key,JSON.stringify(legacy));
  assert.equal(restoreEpisodeDraft(s,'legacy-work',e).brief,'Ручное задание');
  for(const invalid of [{...legacy,projectId:'other-work'},{...legacy,content:'x'.repeat(2000001)},{...legacy,season:0},{...legacy,revision:NaN},{...legacy,number:1.5},{...legacy,title:undefined}]){
    s.setItem(key,JSON.stringify(invalid));assert.deepEqual(restoreEpisodeDraft(s,'legacy-work',e),asEpisodeDraft('legacy-work',e));
  }
  s.setItem(key,'{broken');assert.deepEqual(restoreEpisodeDraft(s,'legacy-work',e),asEpisodeDraft('legacy-work',e));
  assert.notEqual(fanficStorageKey('draft','a:b','c'),fanficStorageKey('draft','a','b:c'));
});

test('Fanfic storage quota failures preserve the writer draft across view remounts and report that backup failed',()=>{
  const s={getItem:()=>null,setItem:()=>{throw new Error('Quota exceeded')},removeItem:()=>{}},e=episode('quota-chapter'),d={...asEpisodeDraft('quota-work',e),dirty:true,content:'Важный не потерянный текст'};
  assert.equal(persistEpisodeDraft(s,d),false);
  assert.equal(restoreEpisodeDraft(s,'quota-work',e).content,d.content);
  persistEpisodeDraft(s,asEpisodeDraft('quota-work',e));
  assert.equal(restoreEpisodeDraft(s,'quota-work',e).content,e.content);
});

test('Fanfic save validates integer chapter order and leaves canonical draft identity out of PATCH data',()=>{
  const d=asEpisodeDraft('number-work',episode('number-chapter'));
  for(const patch of [{season:0},{season:1000},{number:10000},{number:1.2},{season:NaN}])assert.throws(()=>draftSavePayload({...d,...patch}),/целые номера/);
  const payload=draftSavePayload(d);assert.equal(payload.expectedRevision,4);assert.equal('projectId' in payload,false);assert.equal('dirty' in payload,false);
  assert.equal(draftHasChanges(d,episode('number-chapter')),false);
});

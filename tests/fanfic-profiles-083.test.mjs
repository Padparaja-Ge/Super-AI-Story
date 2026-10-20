import test from 'node:test';
import assert from 'node:assert/strict';
import {FANFIC_MODEL_KINDS,FANFIC_PROFILE_STAGES,normalizeFanficProfiles,resolveFanficStageProfile} from '../shared/fanfic-profiles.mjs';

test('Fanfic generic stage profiles preserve legacy prose settings without mutating runtime or other projects',()=>{
  const settings={maxTokens:1777,temperature:.83,localRuntime:{expertUsedCount:3},generationProfiles:undefined};
  const other={maxTokens:1200,temperature:.8,generationProfiles:{modelKind:'moe',stages:{}}};
  const before=structuredClone({settings,other});
  const prose=resolveFanficStageProfile(settings,'writing',{contextWindow:8192});
  assert.equal(prose.maxTokens,1777);assert.equal(prose.temperature,.83);assert.equal(prose.modelKind,'generic');
  assert.deepEqual(resolveFanficStageProfile(settings,'memory').overridden,[]);
  assert.deepEqual({settings,other},before);assert.equal(settings.localRuntime.expertUsedCount,3);
});

test('Fanfic profile normalization keeps only explicit finite supported stage overrides',()=>{
  const input={modelKind:'moe',expertUsedCount:1,stages:{writing:{maxTokens:99999,temperature:999,contextWindow:1},memory:{maxTokens:-10,temperature:-1},review:{maxTokens:NaN,temperature:Infinity},other:{maxTokens:2}}};
  const saved=normalizeFanficProfiles(input);
  assert.deepEqual(saved,{modelKind:'moe',stages:{writing:{maxTokens:4096,temperature:1.5},memory:{maxTokens:128,temperature:0}}});
  saved.stages.writing.maxTokens=300;assert.equal(input.stages.writing.maxTokens,99999);
  assert.deepEqual(normalizeFanficProfiles({modelKind:'automatic',stages:{writing:{maxTokens:'1000',temperature:null}}}),{modelKind:'generic',stages:{}});
  assert.deepEqual(normalizeFanficProfiles([]),{modelKind:'generic',stages:{}});
});

test('Fanfic Dense and MoE starter profiles remain explicit and bounded in every stage',()=>{
  for(const modelKind of FANFIC_MODEL_KINDS)for(const stage of FANFIC_PROFILE_STAGES){
    const settings={maxTokens:1200,temperature:.8,generationProfiles:{modelKind,stages:{}}};
    const output=resolveFanficStageProfile(settings,stage,{contextWindow:1024});
    assert.equal(output.modelKind,modelKind);assert.ok(output.maxTokens<=(stage==='writing'?512:341));
    assert.ok(output.temperature>=0&&output.temperature<=1.5);assert.deepEqual(output.overridden,[]);
  }
  const raw={maxTokens:1500,temperature:.9,generationProfiles:{modelKind:'moe',stages:{writing:{maxTokens:1600,temperature:.84},memory:{maxTokens:1200}}}};
  const prose=resolveFanficStageProfile(raw,'writing',{contextWindow:8192});
  assert.equal(prose.maxTokens,1600);assert.equal(prose.temperature,.84);assert.deepEqual(prose.overridden,['maxTokens','temperature']);
  assert.equal(resolveFanficStageProfile(raw,'memory',{contextWindow:8192}).maxTokens,1200);
  assert.equal(resolveFanficStageProfile(raw,'rewrite',{maxTokensFallback:1700}).maxTokens,1700);
  assert.throws(()=>resolveFanficStageProfile(raw,'multiplayer'),/Unknown Fanfic/);
});

test('Fanfic stage starter profiles survive independent JSON export and import',()=>{
  const first=normalizeFanficProfiles({modelKind:'dense',stages:{planning:{maxTokens:700,temperature:.12},review:{temperature:0}}});
  const imported=normalizeFanficProfiles(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(imported,first);imported.stages.review.temperature=.4;assert.equal(first.stages.review.temperature,0);
  assert.equal(resolveFanficStageProfile({generationProfiles:first},'planning').temperature,.12);
});

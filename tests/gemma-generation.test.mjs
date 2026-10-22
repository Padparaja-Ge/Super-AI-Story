import test from 'node:test';
import assert from 'node:assert/strict';
import {chatTemplateProblem} from '../shared/chat-template.mjs';
import {runtimeArgs} from '../server/local-runtime.mjs';
import {applyModelProfile} from '../shared/model-profiles.mjs';
import {samplingDefaults,samplingBody} from '../shared/local-options.mjs';

const gemma={architecture:'gemma4',chatTemplate:"{{ '<|turn>' + role }}"};
const input={modelPath:'gemma.gguf',context:8192,gpuLayers:'auto',device:{backend:'cuda',device:'CUDA0'},port:9090,key:'test',modelInfo:gemma};
test('Known native Gemma turn format cannot be launched with a foreign override',()=>{
 for(const chatTemplate of ['llama3','chatml','mistral-v1','mistral-v3','command-r']){
  assert.match(chatTemplateProblem(gemma,chatTemplate),/Из GGUF/);
  assert.throws(()=>runtimeArgs({...input,options:{chatTemplate}}),/Gemma.*GGUF/);
 }
 assert.ok(!runtimeArgs(input).includes('--chat-template'));
 assert.equal(chatTemplateProblem({...gemma,chatTemplate:'<start_of_turn>model'},'llama3').length>0,true);
 // Fine-tunes with other native formats and unknown metadata stay editable.
 assert.equal(chatTemplateProblem({...gemma,chatTemplate:'[INST]'},'llama3'),'');
 assert.equal(chatTemplateProblem({architecture:'llama',chatTemplate:'<|turn>'},'llama3'),'');
 assert.equal(chatTemplateProblem(null,'llama3'),'');
 assert.equal(chatTemplateProblem(gemma,'gguf'),'');
 assert.ok(runtimeArgs({...input,embedding:true,options:{chatTemplate:'llama3'}}).includes('--embedding'));
});
test('Applying a model profile replaces old experimental samplers instead of retaining them',()=>{
 const before={localDevice:'cpu',localEmbeddings:true,localRuntime:{chatTemplate:'llama3',threads:6},localSampling:{adaptiveTarget:.8,topNSigma:1.5,mirostat:'2',xtcProbability:1,dryMultiplier:4,temperature:3},narrative:{mode:'roleplay'}};
 const snapshot=structuredClone(before),after=applyModelProfile(before,'luchador-gemma4');
 assert.deepEqual(before,snapshot);assert.equal(after.localRuntime.chatTemplate,'gguf');assert.equal(after.localRuntime.threads,6);
 assert.equal(after.localDevice,'cpu');assert.equal(after.localEmbeddings,true);assert.deepEqual(after.narrative,before.narrative);
 for(const key of ['adaptiveTarget','topNSigma','mirostat','xtcProbability','dryMultiplier'])assert.equal(after.localSampling[key],samplingDefaults[key]);
 assert.equal(after.localSampling.temperature,.8);assert.equal(after.localSampling.maxTokens,1024);
 for(const id of ['careful','multiverse-moe','sainemo-dense'])assert.equal(applyModelProfile(before,id).localSampling.adaptiveTarget,-1);
});
test('Explicit reset transmits disabled sampler values after every experimental setting',()=>{
 const names={topNSigma:'top_n_sigma',adaptiveTarget:'adaptive_target',mirostat:'mirostat',xtcProbability:'xtc_probability',dryMultiplier:'dry_multiplier',dynatempRange:'dynatemp_range',repeatPenalty:'repeat_penalty'};
 const enabled={topNSigma:1.5,adaptiveTarget:.2,mirostat:'2',xtcProbability:.2,dryMultiplier:.8,dynatempRange:.2,repeatPenalty:1.1};
 const reset=samplingBody(samplingDefaults),experimental=samplingBody(enabled);
 for(const [key,native] of Object.entries(names)){assert.notEqual(reset[native],experimental[native]);assert.equal(reset[native],Number(samplingDefaults[key]));}
});

// These are conservative starting points for one Fanfic project, not model/runtime presets.
// Every stage remains within the connection's context budget. A model family's name
// is not evidence of its prose quality, context retention or safe expert routing.
export const FANFIC_PROFILE_STAGES = Object.freeze(['writing', 'planning', 'memory', 'review', 'rewrite']);
export const FANFIC_MODEL_KINDS = Object.freeze(['generic', 'dense', 'moe']);
export const FANFIC_PROFILE_DEFAULTS = Object.freeze({
  generic: Object.freeze({writing: Object.freeze({}), planning: Object.freeze({maxTokens:850, temperature:.25}), memory:Object.freeze({maxTokens:850, temperature:.1}), review:Object.freeze({maxTokens:1000, temperature:.1}), rewrite:Object.freeze({temperature:.15})}),
  dense: Object.freeze({writing:Object.freeze({maxTokens:1200, temperature:.75}), planning:Object.freeze({maxTokens:850, temperature:.2}), memory:Object.freeze({maxTokens:850, temperature:.1}), review:Object.freeze({maxTokens:1000, temperature:.1}), rewrite:Object.freeze({temperature:.15})}),
  moe: Object.freeze({writing:Object.freeze({maxTokens:1024, temperature:.7}), planning:Object.freeze({maxTokens:750, temperature:.15}), memory:Object.freeze({maxTokens:750, temperature:.05}), review:Object.freeze({maxTokens:900, temperature:.05}), rewrite:Object.freeze({temperature:.1})}),
});

const own=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const bounds={maxTokens:[128,4096],temperature:[0,1.5]};
const clamp=(value,[min,max])=>Math.max(min,Math.min(max,value));

// Only explicit supported overrides survive serialization. This cannot change
// global presets, connection parameters, llama flags or another project's settings.
export function normalizeFanficProfiles(value){
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const result={modelKind:FANFIC_MODEL_KINDS.includes(input.modelKind)?input.modelKind:'generic',stages:{}};
  for(const stage of FANFIC_PROFILE_STAGES){
    const raw=input.stages?.[stage];
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const normalized={};
    for(const key of Object.keys(bounds))if(own(raw,key)&&numeric(raw[key]))normalized[key]=key==='maxTokens'?Math.round(clamp(raw[key],bounds[key])):clamp(raw[key],bounds[key]);
    if(Object.keys(normalized).length)result.stages[stage]=normalized;
  }
  return result;
}

// Fallbacks let old projects retain their established settings. Explicit Dense
// and MoE profiles only select modest request sizes/temperatures; validation on
// real models is still required. They never alter an MoE's active expert count.
export function resolveFanficStageProfile(settings={},stage='writing',options={}){
  if(!FANFIC_PROFILE_STAGES.includes(stage))throw new Error('Unknown Fanfic generation stage: '+stage);
  const profiles=normalizeFanficProfiles(settings.generationProfiles),family=FANFIC_PROFILE_DEFAULTS[profiles.modelKind][stage];
  const override=profiles.stages[stage]||{};
  const contextWindow=Number.isFinite(Number(options.contextWindow))&&Number(options.contextWindow)>0?Math.floor(Number(options.contextWindow)):8192;
  const legacyTokens=numeric(settings.maxTokens)?settings.maxTokens:1200;
  const legacyTemperature=numeric(settings.temperature)?settings.temperature:.8;
  const fallbackTokens=numeric(options.maxTokensFallback)?options.maxTokensFallback:(stage==='writing'?legacyTokens:stage==='rewrite'?legacyTokens:family.maxTokens);
  const fallbackTemperature=numeric(options.temperatureFallback)?options.temperatureFallback:(stage==='writing'?legacyTemperature:family.temperature);
  // Context caps stay conservative for structured output; the real tokenizer
  // may reduce the input further in each existing task's prepare function.
  const maxTokens=Math.max(1,Math.min(Math.round(clamp(override.maxTokens??family.maxTokens??fallbackTokens,bounds.maxTokens)),Math.floor(contextWindow/(stage==='writing'?2:3))));
  const temperature=clamp(override.temperature??family.temperature??fallbackTemperature,bounds.temperature);
  return {stage,modelKind:profiles.modelKind,maxTokens,temperature,overridden:Object.keys(override)};
}

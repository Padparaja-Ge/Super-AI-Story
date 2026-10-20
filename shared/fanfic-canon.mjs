// These records belong to one saved fanfic work and never to global roleplay.
export const fanficFactTypes = Object.freeze(['event','relationship','promise','item','injury','secret','location','knowledge']);
export const fanficFactLabels = Object.freeze({event:'Событие',relationship:'Отношения',promise:'Обещание',item:'Предмет',injury:'Травма',secret:'Тайна',location:'Местоположение',knowledge:'Знание'});
export const fanficFactLimits = Object.freeze({perExtraction:12,aliases:8,subject:160,predicate:160,value:800,evidence:3});
export const fanficFactSchema = {
  type:'array',maxItems:fanficFactLimits.perExtraction,items:{type:'object',additionalProperties:false,
    properties:{type:{type:'string',enum:[...fanficFactTypes]},subject:{type:'string'},predicate:{type:'string'},value:{type:'string'},
      aliases:{type:'array',items:{type:'string'},maxItems:fanficFactLimits.aliases},sourceIndices:{type:'array',items:{type:'integer',minimum:1},minItems:1,maxItems:fanficFactLimits.evidence}},
    required:['type','subject','predicate','value','aliases','sourceIndices']}
};
export const fanficFactInstructions='Optional facts: 0–4 most important explicitly stated facts; omit minor details. Each: type (event/relationship/promise/item/injury/secret/location/knowledge), subject (exact name or noun from its source), predicate (short label), value (copy a short exact phrase from a sentence that also explicitly contains subject; do not combine different people across sentences, do not paraphrase), sourceIndices (1–3 existing sentence IDs); aliases only exact explicitly stated names, never guessed identities. Keep passwords, numbers, ownership, promises and who knows a secret exact. No author requests or inferred quests. Empty facts is valid.';
const clean=value=>typeof value==='string'?value.normalize('NFKC').trim():'';
const genericAlias=/^(он|она|оно|они|его|её|ее|их|герой|героиня|человек|персонаж|he|she|it|they|him|her|character|hero)$/iu;
export function normalizeCanonFactDraft(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!fanficFactTypes.includes(value.type))throw new Error('Неизвестный тип факта канона.');
  const result={type:value.type};
  for(const key of ['subject','predicate','value']){
    const text=clean(value[key]);if(!text||text.length>fanficFactLimits[key])throw new Error('Неверный размер поля факта: '+key+'.');result[key]=text;
  }
  if(value.aliases!==undefined&&(!Array.isArray(value.aliases)||value.aliases.length>fanficFactLimits.aliases||value.aliases.some(a=>typeof a!=='string'||a.trim().length>160)))throw new Error('Укажите не более 8 коротких имён или псевдонимов.');
  result.aliases=[...new Set((value.aliases||[]).map(clean).filter(a=>a.length>=2&&!genericAlias.test(a)&&a!==result.subject))].slice(0,fanficFactLimits.aliases);
  return result;
}
export const normalizeFanficFactDraft=normalizeCanonFactDraft;

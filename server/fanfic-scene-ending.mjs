import {structuredCompletion} from './services/structuredCompletion.js';
import {countCompletionTokens} from './llm.mjs';
import {messageTokens} from './prompt.mjs';

// A tiny grammar avoids the huge maxLength-derived GBNF that older GGUF
// instruction models cannot initialize. Semantic bounds remain server-side.
export const fanficSceneEndingSchema={type:'object',properties:{ending:{type:'string'}},required:['ending'],additionalProperties:false};
export const fanficSceneEndingInstructions='Complete ONLY the unfinished LAST sentence in tail. Return JSON {"ending":"exact suffix"}. Do not summarize tail. Do not start a new scene, journey, event, or paragraph. Use the SAME LANGUAGE as tail: Russian Cyrillic for Russian tail, English for English tail. The suffix must be at most 25 words, ONE sentence, and end with punctuation. Keep the required initial space, or start with the missing letters if the last word is cut off. Example: tail="Лира сказала, что она" -> ending=" вернётся завтра."; tail="Лира увидела две" -> ending="рь.". If tail is already complete, return one short closing sentence at most 25 words, with its initial space or newline. Complete the predicate if tail ends in a subject pronoun: она -> вернулась, not к себе. Keep the speaker and viewpoint. If the final paragraph is an open quoted dialogue line, close that same quote. Never repeat the tail or provide commentary. Не переводи русскую прозу на английский, не пересказывай её: допиши только последнее предложение.';
const terminal=/[.!?…]["'»”’\)\]]*\s*$/u;
const normalize=value=>value.trim().replace(/\s+/gu,' ').toLocaleLowerCase();
const formatError=message=>Object.assign(new Error(message),{code:'FANFIC_ENDING_FORMAT'});
const contextError=()=>Object.assign(new Error('Короткое завершение сцены не помещается в контекст модели. Черновик сохранён.'),{code:'FANFIC_ENDING_CONTEXT'});
function clipStart(value,limit){let result=String(value||'').slice(0,limit);if(/[\uD800-\uDBFF]$/u.test(result))result=result.slice(0,-1);return result;}
function clipTail(value,limit){let result=String(value||'').slice(-limit);if(/^[\uDC00-\uDFFF]/u.test(result))result=result.slice(1);return result;}

export function validateFanficSceneEnding(ending,{tail}={}){
 if(typeof ending!=='string'||!ending.trim()||ending.length>900)throw formatError('Нужно непустое короткое завершение сцены, не более 900 символов.');
 if(!terminal.test(ending))throw formatError('Модель снова оборвала заключительное предложение.');
 const clean=ending.trim();
 if(/```|<\/?think\b|\[SAS_|^\s*[\[{]|^\s*(?:Комментарий(?: автора| редактора)?|Пояснение|Завершение сцены|Сцена завершена|Вот (?:завершение|продолжение|JSON)|Готово|This (?:text|narrative) is|The narrative is|Here is|Note\s*:|Explanation\s*:)/iu.test(clean)||/(?:"ending"\s*:|"replacement"\s*:)/u.test(clean))throw formatError('Вместо прозы модель вернула служебный текст или JSON.');
 const original=normalize(String(tail||'')),output=normalize(ending);
 if((original.length>=12&&output.includes(original))||(original.length>=64&&output.startsWith(original.slice(-64))))throw formatError('Модель повторила исходный текст вместо его завершения.');
 const words=(clean.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)||[]).length;
 if(words>25)throw formatError('Заключительная строка должна быть не длиннее 25 слов.');
 if(/[\r\n]/u.test(clean))throw formatError('Допустима только одна заключительная строка.');
 if(/[.!?…]+["'»”’\)\]]*\s+(?=[\p{L}«"“])/u.test(clean))throw formatError('Нужно завершить одно предложение, а не пересказывать историю или начинать новые события.');
 const lastParagraph=String(tail||'').split(/\n\s*\n/u).at(-1)?.trim()||'';
 const combinedParagraph=lastParagraph+ending;
 if(lastParagraph.startsWith('«')&&((combinedParagraph.match(/«/gu)||[]).length>(combinedParagraph.match(/»/gu)||[]).length))throw formatError('Нужно закрыть кавычку последней реплики, не меняя говорящего.');
 if(lastParagraph.startsWith('"')&&(lastParagraph.match(/"/gu)||[]).length%2===1&&(combinedParagraph.match(/"/gu)||[]).length%2===1)throw formatError('Нужно закрыть кавычку последней реплики, не меняя говорящего.');
 const sourceTail=String(tail||'').slice(-512),cyrillic=(sourceTail.match(/[а-яё]/giu)||[]).length,latin=(sourceTail.match(/[a-z]/giu)||[]).length;
 const outputCyrillic=(clean.match(/[а-яё]/giu)||[]).length,outputLatin=(clean.match(/[a-z]/giu)||[]).length;
 if(cyrillic>=12&&cyrillic>latin*2&&outputLatin>=12&&outputLatin>outputCyrillic*2)throw formatError('Окончание должно быть на русском, как исходный текст, а не английским резюме.');
 if(latin>=12&&cyrillic===0&&outputCyrillic>=12&&outputCyrillic>outputLatin*2)throw formatError('Окончание должно быть на английском, как исходный текст.');
 // Preserve the exact suffix: leading space vs a mid-word continuation belongs
 // to the generated text, not to a heuristic joiner or a JSON cleaner.
 return ending;
}
export function parseFanficSceneEnding(raw,options){
 let value=raw;
 if(typeof raw==='string'){
  try{value=JSON.parse(raw.trim());}catch{throw formatError('Завершение сцены должно соответствовать JSON {"ending":""}.');}
 }
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'ending'))throw formatError('Завершение сцены должно содержать только поле ending.');
 return validateFanficSceneEnding(value.ending,options);
}
function abortable(promise,signal){
 if(!signal)return Promise.resolve(promise);
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  const aborted=()=>reject(signal.reason);
  signal.addEventListener('abort',aborted,{once:true});
  Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
 });
}

// This last-resort operation deliberately has no access to memory, cast, lore,
// other episodes, or other modes. It never changes the saved draft itself.
export async function finishFanficScene({state,connection,getSecret,signal,scene,tail,instructions='',maxTokens=256,temperature=.15,structured=structuredCompletion,countTokens=countCompletionTokens}){
 signal?.throwIfAborted();
 if(typeof tail!=='string'||!tail.trim())throw formatError('Для завершения нужен непустой хвост текущей сцены.');
 const contextWindow=connection?.contextWindow===undefined?8192:Number(connection.contextWindow);
 if(!Number.isFinite(contextWindow)||contextWindow<1)throw contextError();
 const requested=Number(maxTokens),outputTokens=Math.min(256,Number.isFinite(requested)?Math.floor(requested):256,Math.floor(contextWindow/3));
 if(outputTokens<1)throw contextError();
 const requestedTemperature=Number(temperature),endingTemperature=Math.max(0,Math.min(.15,Number.isFinite(requestedTemperature)?requestedTemperature:.15));
 let data={tail:clipTail(tail,1800),sceneSummary:clipStart(typeof scene==='string'?scene:scene?.summary,300),authorBrief:clipStart(instructions,500)};
 const minimumTail=Math.min(data.tail.length,32),secret=getSecret(connection.id);
 let prepared=false;
 for(let attempt=0;attempt<16;attempt++){
  signal?.throwIfAborted();
  const messages=[{role:'system',content:fanficSceneEndingInstructions},{role:'user',content:JSON.stringify(data)}];
  // Count the actual adapted prompt, including Alpaca/template tokens, before
  // making a completion request. External APIs use a conservative estimate.
  const actual=await abortable(countTokens(connection,secret,messages,{signal,adaptInstruction:true,disableThinking:true}),signal);
  signal?.throwIfAborted();
  const estimate=messageTokens(messages),inputTokens=Number.isFinite(actual)&&actual>=0?actual:Math.ceil(estimate*1.4);
  if(inputTokens+outputTokens+240<=contextWindow&&estimate+outputTokens+160<=contextWindow){prepared=true;break;}
  if(data.authorBrief){data={...data,authorBrief:''};continue;}
  if(data.tail.length>minimumTail){data={...data,tail:clipTail(data.tail,Math.max(minimumTail,Math.floor(data.tail.length*2/3)))};continue;}
  throw contextError();
 }
 if(!prepared)throw contextError();
 let formatRejected=false;
 const parse=raw=>{try{return parseFanficSceneEnding(raw,{tail:data.tail});}catch(error){formatRejected=true;throw error;}};
 try {
  const result=await abortable(structured({state,chat:{connectionId:connection.id},getSecret,signal,name:'fanfic_scene_ending',instructions:fanficSceneEndingInstructions,context:data,schema:fanficSceneEndingSchema,maxTokens:outputTokens,temperature:endingTemperature,adaptInstruction:true,parse}),signal);
  signal?.throwIfAborted();
  return typeof result==='string'&&!/^\s*[\[{]/u.test(result)?validateFanficSceneEnding(result,{tail:data.tail}):parse(result);
 }catch(error){
  signal?.throwIfAborted();
  // Story-tuned models can write a whole phrase but fail the instruction to
  // emit only a suffix. A single bounded copy-and-complete operation preserves
  // the prefix literally; no rewrite is ever accepted as a completion.
  if(!formatRejected&&error.code!=='FANFIC_ENDING_FORMAT')throw error;
  return completeFanficFragment({state,connection,getSecret,signal,tail,maxTokens:outputTokens,temperature:endingTemperature,structured,countTokens});
 }
}

const completedFragmentSchema={type:'object',properties:{completedText:{type:'string'}},required:['completedText'],additionalProperties:false};
export function parseFanficCompletedFragment(raw,{fragment,tail}){
 let value=raw;
 if(typeof raw==='string'){try{value=JSON.parse(raw.trim());}catch{throw formatError('Нужен JSON {"completedText":"исходный текст и окончание"}.');}}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||typeof value.completedText!=='string')throw formatError('Нужно только строковое поле completedText.');
 if(!value.completedText.startsWith(fragment))throw formatError('Модель изменила исходный фрагмент. Начало completedText должно совпадать с text буквально.');
 return validateFanficSceneEnding(value.completedText.slice(fragment.length),{tail});
}
async function completeFanficFragment({state,connection,getSecret,signal,tail,maxTokens,temperature,structured,countTokens}){
 const contextWindow=Number(connection.contextWindow)||8192;
 const lastParagraph=String(tail).split(/\n\s*\n/u).at(-1)||'';
 const fragment=clipTail(lastParagraph,Math.max(24,Math.min(240,Math.floor(maxTokens*.7))));
 const closingQuote=lastParagraph.trimStart().startsWith('«')&&!lastParagraph.endsWith('»')?'»':lastParagraph.trimStart().startsWith('"')&&(lastParagraph.match(/"/gu)||[]).length%2===1?'"':'';
 const instructions='Return JSON {"completedText":"..."}. Copy text EXACTLY, then complete ONLY its last unfinished sentence in the SAME LANGUAGE, Russian for Russian text. Finish the cut-off word. Do not rewrite any original character, summarize, explain, or start a new event. At most 25 NEW words. Close the same dialogue quote if closingQuote is given. Example: text="Я знал, что вер" -> completedText="Я знал, что вернёшься.". Use before only to identify the speaker, addressee, and completed actions. Keep who did each action; do not switch a returning addressee to the speaker.';
 const before=clipTail(String(tail).slice(0,String(tail).length-lastParagraph.length),300);
 const context={text:fragment,closingQuote,before};
 const messages=[{role:'system',content:instructions},{role:'user',content:JSON.stringify(context)}];
 const actual=await abortable(countTokens(connection,getSecret(connection.id),messages,{signal,adaptInstruction:true,disableThinking:true}),signal);
 signal?.throwIfAborted();
 const estimate=messageTokens(messages),inputTokens=Number.isFinite(actual)&&actual>=0?actual:Math.ceil(estimate*1.4);
 if(inputTokens+maxTokens+240>contextWindow||estimate+maxTokens+160>contextWindow)throw contextError();
 let parsedSuffix;
 const parse=raw=>{parsedSuffix=parseFanficCompletedFragment(raw,{fragment,tail});return parsedSuffix;};
 const result=await abortable(structured({state,chat:{connectionId:connection.id},getSecret,signal,name:'fanfic_scene_completion',instructions,context,schema:completedFragmentSchema,maxTokens,temperature,adaptInstruction:true,parse}),signal);
 signal?.throwIfAborted();
 return typeof result==='string'&&result===parsedSuffix?validateFanficSceneEnding(result,{tail}):parse(result);
}

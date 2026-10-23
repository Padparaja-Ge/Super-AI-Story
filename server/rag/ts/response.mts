import type {ParsedResponse,GameEngine,ActionResult} from './types.mjs';

const validated=new WeakSet<object>();
const errors=new WeakMap<object,string>();
const rootKeys=new Set(['thinking','action_required','action_params','narrative_text']);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
const ownKeys=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
export const structuredResponseSchema={type:'object',properties:{thinking:{type:'string',maxLength:512},action_required:{type:'string',enum:['roll_dice','update_state','none']},action_params:{type:'object',properties:{formula:{type:'string',maxLength:80},target:{type:'string',maxLength:100},reason:{type:'string',maxLength:600},field:{type:'string',maxLength:64},value:{type:['string','number','boolean','null']}},additionalProperties:false},narrative_text:{type:'string',maxLength:30000}},required:['thinking','action_required','action_params','narrative_text'],additionalProperties:false} as const;
export const structuredResponseFormat={type:'json_object',schema:structuredResponseSchema} as const;
export function isStructuredResponse(raw:unknown):boolean{return typeof raw==='string'&&(/^[\s\uFEFF]*(?:[{[]|```json\b)/iu.test(raw)||/["']?(?:thinking|action_required|action_params|narrative_text)["']?\s*:/u.test(raw)&&/[{[]/u.test(raw));}
function result(value:ParsedResponse,error?:string):ParsedResponse{Object.freeze(value.action_params);Object.freeze(value);validated.add(value);if(error)errors.set(value,error);return value;}
const invalid=()=>result({thinking:'',action_required:'none',action_params:{},narrative_text:''},'Структурированный ответ не соответствует безопасному формату.');
function duplicateKeys(source:string):boolean{
 const stack:Array<Set<string>|null>=[];let quoted=false,escaped=false,start=0;
 for(let i=0;i<source.length;i++){
  const c=source[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"'){quoted=false;let next=i+1;while(/\s/u.test(source[next]||'')&&next<source.length)next++;if(source[next]===':'&&stack.at(-1)){let key:string;try{key=JSON.parse(source.slice(start,i+1));}catch{return true;}const keys=stack.at(-1)!;if(keys.has(key))return true;keys.add(key);}}continue;}
  if(c==='"'){quoted=true;start=i;}else if(c==='{')stack.push(new Set());else if(c==='[')stack.push(null);else if(c==='}'||c===']')stack.pop();
 }return false;
}
function convert(raw:unknown):ParsedResponse|undefined{
 if(!isObject(raw)||Object.keys(raw).some(key=>!rootKeys.has(key))||!bounded(raw.thinking??'',512)||!bounded(raw.narrative_text,30000)||!['none','roll_dice','update_state'].includes(String(raw.action_required)))return;
 const params=raw.action_params??{};if(!isObject(params))return;
 for(const [key,value]of Object.entries(params))if(['__proto__','prototype','constructor'].includes(key)||key==='reason'&&!bounded(value,600)||key==='target'&&(!bounded(value,100)||!value.trim()))return;
 if(raw.action_required==='none'&&Object.keys(params).length)return;
 if(raw.action_required==='roll_dice'){
  if(!ownKeys(params,['formula','target','reason'])||!bounded(params.formula,80)||!/^([1-9]|1\d|20)[dд]([2-9]|[1-9]\d|100)(?:[+-]\d{1,3})?$/iu.test(params.formula))return;
 }
 if(raw.action_required==='update_state'){
  if(!ownKeys(params,['field','value','reason','target'])||!bounded(params.field,64)||!/^[a-z][a-z0-9_]*$/iu.test(params.field)||['__proto__','prototype','constructor'].includes(params.field)||!Object.hasOwn(params,'value'))return;
  const value=params.value;if(!(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||bounded(value,2000)))return;
 }
 return result({thinking:String(raw.thinking??''),action_required:raw.action_required as ParsedResponse['action_required'],action_params:{...params},narrative_text:raw.narrative_text});
}
// One linear scan handles braces inside quoted strings and rejects ambiguous
// multiple envelopes instead of accidentally executing the first one.
function objects(text:string):unknown[]{
 const found:unknown[]=[];let start=-1,depth=0,quoted=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(start<0){if(c==='{'){start=i;depth=1;quoted=false;escaped=false;}continue;}
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{'){if(++depth>32)return [];}else if(c==='}'&&--depth===0){const source=text.slice(start,i+1);if(duplicateKeys(source))return [];try{found.push(JSON.parse(source));}catch{}start=-1;if(found.length>8)return [];}
 }
 return start>=0?[]:found;
}
export function parseLLMResponse(raw:unknown):ParsedResponse{
 if(typeof raw!=='string'||raw.length>64000)return invalid();
 let source=raw,previous;do{previous=source;source=source.replace(/^\s*<(think|analysis)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/iu,'').replace(/^\s*<\|channel\|?>(?:thought|analysis|reasoning)\b[\s\S]*?(?:<channel\|>|<\|channel\|?>final|$)/iu,'');}while(source!==previous);
 const trimmed=source.trim();if(!isStructuredResponse(source))return result({thinking:'',action_required:'none',action_params:{},narrative_text:source});
 if(trimmed.startsWith('['))return invalid();
 let candidates:unknown[];try{const parsed=JSON.parse(trimmed);if(duplicateKeys(trimmed))return invalid();candidates=[parsed];}catch{candidates=objects(trimmed);}
 const envelopes=candidates.filter(value=>isObject(value)&&Object.keys(value).some(key=>rootKeys.has(key)));
 if(envelopes.length!==1)return invalid();return convert(envelopes[0])??invalid();
}
export function isValidatedResponse(value:unknown):value is ParsedResponse{return isObject(value)&&validated.has(value);}
export function responseParseError(value:unknown):string|undefined{return isObject(value)?errors.get(value):'Ответ не прошёл разбор.';}
const failure=(message:string):ActionResult=>({success:false,error:message.slice(0,500),narrative_text:''});
function allowed(response:ParsedResponse):ActionResult|undefined{
 if(!isValidatedResponse(response))return failure('Ответ не прошёл безопасный разбор.');
 const error=errors.get(response);if(error)return failure(error);
 if(response.action_required==='none')return {success:true,narrative_text:response.narrative_text};
}
export function executeAction(response:ParsedResponse,engine:GameEngine):ActionResult{
 const stopped=allowed(response);if(stopped)return stopped;
 try{
  const fn=response.action_required==='roll_dice'?engine.rollDice:engine.updateState;
  if(typeof fn!=='function'||fn.constructor.name==='AsyncFunction')return failure('Для асинхронного движка используйте executeActionAsync.');
  const value=fn.call(engine,{...response.action_params});
  if(value&&typeof(value as Promise<unknown>).then==='function')return failure('Для асинхронного движка используйте executeActionAsync.');
  return {success:true,result:value,narrative_text:response.narrative_text};
 }catch(error){return failure(error instanceof Error?error.message:'Не удалось выполнить действие.');}
}
export async function executeActionAsync(response:ParsedResponse,engine:GameEngine):Promise<ActionResult>{
 const stopped=allowed(response);if(stopped)return stopped;
 try{const value=await(response.action_required==='roll_dice'?engine.rollDice({...response.action_params}):engine.updateState({...response.action_params}));return {success:true,result:value,narrative_text:response.narrative_text};}
 catch(error){return failure(error instanceof Error?error.message:'Не удалось выполнить действие.');}
}

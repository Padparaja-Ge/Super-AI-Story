import {complete as llmComplete,countCompletionTokens} from './llm.mjs';
import {calculateTokenBudget} from './rag/tokens.mjs';
import {gmJsonGrammarForActions} from './gm-json-grammar.mjs';
import {parseLLMResponse,executeActionAsync,responseParseError,structuredResponseSchema} from './rag/response.mjs';

const fail=(message,code='GM_STRUCTURED_RESPONSE')=>{throw Object.assign(new Error(message),{code});};
const safeResult=value=>JSON.parse(JSON.stringify(value,(key,item)=>['thinking','reasoning','reasoning_content','analysis','raw'].includes(key)?undefined:item));
// This is a transport/output adapter. The caller owns prompts and permissions;
// no system instruction or alternative model is added here.
export async function generateStructuredNarration({connection,secret,messages,maxTokens,signal,engine,actionsAllowed=true,allowedActions=['roll_dice','update_state'],complete=llmComplete,onActionResult,countTokens}={}){
 if(!connection||typeof connection.model!=='string'||!connection.model.trim()||!Array.isArray(messages)||!messages.length||messages.some(m=>!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'))fail('Для структурированного ответа нужны подключение и корректные сообщения.');
 const source=messages.map(m=>({role:m.role,content:m.content})),window=Math.max(256,Number(connection.contextWindow)||8192),output=Math.max(32,Math.min(Number(maxTokens)||Number(connection.maxTokens)||1024,Math.floor(window/2)));
 const local=connection.id==='sas-local',schema=structuredResponseSchema;
 const tokenizer=countTokens||(local&&complete===llmComplete?countCompletionTokens:null);
 const available=actionsAllowed&&engine?['roll_dice','update_state'].filter(action=>Array.isArray(allowedActions)&&allowedActions.includes(action)):[];
 let fallbackUsed=false,utilityCalls=0;
 async function request(input,actions){
  let format=local||fallbackUsed?undefined:{type:'json_schema',json_schema:{name:'sas_game_narration',strict:true,schema:{...schema,properties:{...schema.properties,action_required:{type:'string',enum:['none',...actions]}}}}};
  signal?.throwIfAborted();const measured=tokenizer?await tokenizer(connection,secret,input,{signal,adaptInstruction:true,disableThinking:true}):null;
  const tokens=measured===null||measured===undefined?input.reduce((sum,m)=>sum+calculateTokenBudget(m.content)+8,3):measured;
  if(!Number.isInteger(tokens)||tokens<0)fail('Не удалось определить размер структурированного контекста.');
  if(tokens+output+160>window)fail('Структурированный ответ и результат действия не помещаются в контекст модели.');
  signal?.throwIfAborted();let reason='';
  const call=async()=>{utilityCalls++;reason='';return complete({...connection,maxTokens:output},secret,input,{signal,responseFormat:format,...(local?{grammar:gmJsonGrammarForActions(actions)}:{}),disableThinking:true,adaptInstruction:true,onFinish:value=>{reason=value;}});};
  let raw;
  try{raw=await call();}catch(error){
   signal?.throwIfAborted();
   if(format&&!fallbackUsed&&[400,415,422].includes(error.status)&&(/format|schema|grammar|unsupported/iu.test(String(error.message))||error.status===415)){format=undefined;fallbackUsed=true;try{raw=await call();}catch(retry){signal?.throwIfAborted();fail('Модель не завершила структурированный ответ'+(Number.isInteger(retry.status)?' (HTTP '+retry.status+')':'')+'.');}}
   else fail('Модель не завершила структурированный ответ'+(Number.isInteger(error.status)?' (HTTP '+error.status+')':'')+'.');
  }
  signal?.throwIfAborted();if(reason==='length')fail('Структурированный ответ оборвался по лимиту. Действие из незавершённого ответа не выполняется.');
  const parsed=parseLLMResponse(raw);if(responseParseError(parsed)||!parsed.narrative_text.trim()&&parsed.action_required==='none')fail('Модель вернула некорректный структурированный ответ.');return parsed;
 }
 const first=await request(source,available);
 if(first.action_required==='none')return {text:first.narrative_text,utilityCalls};
 if(actionsAllowed!==true||!engine||!available.includes(first.action_required))fail('В этой генерации действия модели запрещены; механика не изменена.','GM_STRUCTURED_ACTION');
 signal?.throwIfAborted();const executed=await executeActionAsync(first,engine);
 let actionResult,engineData,resultError='';
 try{actionResult=safeResult({...executed,narrative_text:''});engineData=JSON.stringify({kind:'SAS_ENGINE_ACTION_RESULT',authoritative:true,...actionResult});if(engineData.length>12000)resultError='Результат игрового действия слишком велик для безопасного продолжения.';}catch{resultError='Результат игрового действия нельзя безопасно передать модели.';}
 if(resultError)actionResult={success:executed.success,result:{omitted:true},error:resultError,narrative_text:''};
 const payload=safeResult({kind:'SAS_ENGINE_ACTION_RESULT',authoritative:true,action_required:first.action_required,action_params:first.action_params,success:actionResult.success,...(actionResult.result!==undefined?{result:actionResult.result}:{}),...(actionResult.error?{error:actionResult.error}:{})});
 if(onActionResult)try{await onActionResult(payload);}catch{fail('Результат выполненного действия не удалось закрепить. Повторное применение механики не требуется.','GM_STRUCTURED_ACTION');}
 signal?.throwIfAborted();if(resultError)fail(resultError,'GM_STRUCTURED_ACTION');
 const publicEnvelope=JSON.stringify({action_required:first.action_required,action_params:first.action_params,narrative_text:''});
 const followup=await request([...source,{role:'assistant',content:publicEnvelope},{role:'user',content:engineData}],[]);
 if(followup.action_required!=='none')fail('Модель запросила цепочку действий. Второе действие не выполнялось.','GM_STRUCTURED_ACTION');
 return {text:followup.narrative_text,actionResult,utilityCalls};
}

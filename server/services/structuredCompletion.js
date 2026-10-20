import {complete,getConnection} from '../llm.mjs';
import {messageTokens} from '../prompt.mjs';

export function cleanAssistantOutput(text){
  return String(text).replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi,'').replace(/^```(?:json|text)?\s*|\s*```$/gi,'').trim();
}
export function parseObject(text){
  const clean=cleanAssistantOutput(text);
  // Scan balanced objects; braces inside quoted strings are not delimiters.
  for(let start=clean.indexOf('{');start>=0;start=clean.indexOf('{',start+1)){
    let depth=0,quoted=false,escaped=false;
    for(let i=start;i<clean.length;i++){
      const c=clean[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(clean.slice(start,i+1));}catch{break;}}
    }
  }
  throw new Error('Нужен JSON указанного формата.');
}

// llama.cpp expands bounded string repetitions into GBNF rules. Large bounds can
// exceed its grammar parser limits. Shape constraints stay in the sampler;
// length/range constraints remain in the original schema and application parser.
export function samplerSchema(schema){
  if(Array.isArray(schema))return schema.map(samplerSchema);
  if(!schema||typeof schema!=='object')return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key])=>!['maxLength','minLength','pattern'].includes(key)).map(([key,value])=>[key,samplerSchema(value)]));
}

export async function structuredCompletion({state,chat,getSecret,signal,instructions,context,schema,name,parse=parseObject,maxTokens=1200,temperature=0.15,adaptInstruction=false}){
  const connection=getConnection(state,chat),limit=Number(connection.contextWindow)||8192;
  maxTokens=Math.min(maxTokens,Math.floor(limit/3));
  const data=structuredClone(context),messages=[{role:'system',content:instructions},{role:'user',content:JSON.stringify(data)}];
  const history=data.messages||data.recent;
  while(messageTokens(messages)+maxTokens+160>limit&&history?.length>1){history.shift();messages[1].content=JSON.stringify(data);}
  if(messageTokens(messages)+maxTokens+160>limit)throw new Error('Описание и последнее сообщение не помещаются в контекст модели. Увеличьте контекст в настройках локальной модели.');
  const local=connection.id==='sas-local';
  let format=local?{type:'json_object',schema:samplerSchema(schema)}:{type:'json_schema',json_schema:{name,strict:true,schema}};
  let last;
  for(let attempt=0;attempt<2;attempt++){
    let raw,finishReason='';
    const call=()=>complete({...connection,maxTokens,temperature:attempt?Math.min(.2,temperature):temperature},getSecret(connection.id),messages,{signal,responseFormat:format,disableThinking:true,adaptInstruction,onFinish:reason=>{finishReason=reason;}});
    try{raw=await call();}catch(error){
      if(local&&error.status===400&&/parse grammar|initialize samplers/i.test(error.message)&&format?.schema){format={type:'json_object'};raw=await call();}
      else if(format&&!local&&[400,415,422].includes(error.status)){format=undefined;raw=await call();}else throw error;
    }
    try{return parse(raw);}catch(error){
      last=error;
      const shorten=finishReason==='length'||/слишком длин|too long|maxLength/iu.test(error.message);
      messages[0].content=instructions+'\nFORMAT CORRECTION: The previous response did not match the requested output. Follow the task instructions and requested fields. Do not continue the roleplay. Return the specified JSON only. '+error.message+(shorten?' Regenerate a much shorter COMPLETE JSON object, not a continuation. On this retry each non-enum string must be ONE concise sentence, at most 300 characters. Keep only essential facts and close every string, array and object within the budget.':'');
    }
  }
  throw new Error('Модель дважды нарушила формат: '+last.message);
}

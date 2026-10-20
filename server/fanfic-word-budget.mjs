import {countCompletionTokens} from './llm.mjs';
const russian='Лира остановилась у закрытой двери. В её ладони лежал медный ключ. Она вспомнила старое обещание и назвала точный пароль. Торк внимательно слушал её рассказ, но ещё не знал тайны. За окном начинался дождь, и герои решили закончить разговор прежде, чем отправляться дальше.';
const english='Lyra stopped beside the closed door. A copper key rested in her hand. She remembered her old promise and spoke the exact password. Tork listened carefully, but he did not know the secret yet. Rain began outside, and they decided to finish talking before leaving.';
export function fanficSceneWordLimit(maxTokens,tokensPerWord=6){return Math.max(8,Math.floor(Math.max(32,Number(maxTokens)||128)*.72/Math.max(2,Math.min(24,Number(tokensPerWord)||6))));}
// This measures tokenization, never asks the LLM to generate a calibration text.
// There is no global cache or access to histories; measure once per writing task.
export async function measureFanficWordBudget(connection,secret,source,{signal,countTokens=countCompletionTokens}={}){
 const isRussian=/[А-Яа-яЁё]/u.test(String(source||'')),sample=isRussian?russian:english,fallback=isRussian?8:5;
 if(connection.id!=='sas-local')return {tokensPerWord:fallback,tokenizer:'estimate'};
 const messages=value=>[{role:'system',content:'SAS tokenization measurement.'},{role:'user',content:JSON.stringify({sample:value})}];
 try{
  signal?.throwIfAborted();const base=await countTokens(connection,secret,messages(''),{signal,adaptInstruction:true,disableThinking:true});
  const actual=await countTokens(connection,secret,messages(sample),{signal,adaptInstruction:true,disableThinking:true});
  const words=sample.match(/[\p{L}\p{N}]+/gu).length,delta=actual-base;
  if(Number.isInteger(base)&&Number.isInteger(actual)&&delta>=words&&delta<=words*24)return {tokensPerWord:Math.max(2,delta/words),tokenizer:'model',sampleTokens:delta,sampleWords:words};
 }catch(error){if(signal?.aborted)signal.throwIfAborted();}
 return {tokensPerWord:fallback,tokenizer:'estimate'};
}

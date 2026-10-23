import {roleplaySampling,roleplayStops,createRoleplayOutputFilter,repeatedReply} from './roleplay.mjs';
import crypto from 'node:crypto';
import { getConnection, streamCompletion } from './llm.mjs';
import { inferScene } from './language.mjs';
import {fitNarrationPrompt} from './room-narration.mjs';
import {createTextContinuationJoiner} from './text-continuation.mjs';
export const chatResumeInstruction='ДОПИСЫВАНИЕ ОБОРВАННОГО ОТВЕТА ПЕРСОНАЖА. Продолжи ровно с места обрыва: сначала закончи последнее слово или предложение. Выдай только недостающий текст на том же языке, без повторения и пересказа, без нового хода. Не пиши действия, решения, мысли и реплики игрока.';

export function createGeneration({getState,saveState,getSecret,tasks,preparePrompt,translationService,memory,memoryDue,stream=streamCompletion,fit=fitNarrationPrompt}) {
  function start({chatId,content='',regenerate=false,continue:continuation=false,resumeMessageId} = {}) {
    tasks.assertIdle();
    content = String(content).trim();
    const state=getState(), chat=state.chats.find(c=>c.id===chatId);
    if (!chat) throw new Error('История не найдена.');
    const resume=resumeMessageId?chat.messages.find(m=>m.id===resumeMessageId):undefined;
    if(resumeMessageId&&(!resume||resume!==chat.messages.at(-1)||resume.role!=='assistant'||!resume.interrupted))throw new Error('Можно дописать только последний незавершённый ответ персонажа.');
    if(resume?.interruptionReason==='repetition')throw new Error('Ответ содержит повторяющийся фрагмент. Перегенерируйте его или исправьте текст вручную.');
    if(resumeMessageId&&(content||regenerate||continuation))throw new Error('Дописать ответ нужно отдельным запросом.');
    if (!content && !regenerate && !continuation && !resume) throw new Error('Введите сообщение или нажмите «Продолжить».');
    if (content.length>200000) throw new Error('Слишком длинное сообщение.');
    const connection=getConnection(state,chat);
    if (!connection.model) throw new Error('Выберите модель в подключениях.');
    return tasks.run({kind:'chat',chatId,continuation,regenerate,resumeMessageId,text:resume?.content||'',userContent:content,inputSaved:false},async(signal,job)=>{
      let previous, saved=false, persisted=false;
      const assistantId=resume?.id||crypto.randomUUID();
      const putAssistant=(interrupted,reason)=>{
        if (!job.text) return;
        const current=getState(), target=current.chats.find(c=>c.id===chatId); if(!target)return;
        const swipes=previous?[...(previous.swipes||[previous.content]),job.text]:undefined;
        const existing=target.messages.find(m=>m.id===assistantId);
        const swipeStates=previous?[...(previous.swipeStates||((previous.swipes||[previous.content]).map((_s,i)=>({interrupted:i===(previous.swipeIndex||0)&&!!previous.interrupted,reason:i===(previous.swipeIndex||0)?previous.interruptionReason:undefined})))),{interrupted:!!interrupted,reason:interrupted?reason:undefined}]:existing?.swipeStates?.map((s,i)=>i===(existing.swipeIndex||0)?{interrupted:!!interrupted,reason:interrupted?reason:undefined}:s);
        const message={...(existing||{id:assistantId,role:'assistant',createdAt:new Date().toISOString()}),content:job.text,interrupted:!!interrupted,...(swipes?{swipes,swipeIndex:swipes.length-1}:{}),...(swipeStates?{swipeStates}:{})};
        delete message.translatedContent;delete message.translationLanguage;
        if(interrupted)message.interruptionReason=reason||'network';else delete message.interruptionReason;
        if(existing?.swipes){message.swipes=[...existing.swipes];message.swipes[existing.swipeIndex||0]=job.text;}
        if(existing)Object.assign(existing,message);else target.messages.push(message);
        if(existing){delete existing.translatedContent;delete existing.translationLanguage;if(!interrupted)delete existing.interruptionReason;}
        saveState(current); persisted=true;
      };
      try {
        if(regenerate){if(chat.messages.at(-1)?.role==='assistant')previous=chat.messages.pop();}
        const config=state.settings.translation;
        let modelContent=content;
        if(content && config.enabled && config.outgoing){job.stage='Перевод сообщения'; modelContent=(await translationService.translate(content,config.sourceLanguage,config.modelLanguage,config.provider,{fallback:config.translationFallback,signal})).translation;}
        const prompt=await preparePrompt(state,chatId,regenerate||continuation||resume?'':modelContent,{signal,roleplay:true,tailInstructions:'ТЕКУЩЕЕ ЗАДАНИЕ: ответь именно на последнее сообщение игрока за выбранного персонажа. Сохраняй подтверждённые числа, имена, пароли и условия из памяти и исходных событий. Если в последнем сообщении несколько вопросов, ответь на каждый, сохраняя роль персонажа. Не повторяй последнюю строку старой истории; не пиши за игрока.',...(resume?{compact:true,historyMessages:chat.messages.slice(0,-1)}:{}),...(continuation?{compact:true,tailInstructions:'Продолжи сцену за персонажа: новые действия или реплики. Не пиши реплики, действия, мысли и решения за игрока. Не повторяй прошлый ответ.'}:{})});
        job.warnings.push(...(prompt.warnings||[]));
        if(!regenerate&&!continuation&&!resume)chat.messages.push({id:crypto.randomUUID(),role:'user',content:modelContent,...(modelContent!==content?{originalContent:content}:{}),personaId:chat.personaId,createdAt:new Date().toISOString()});
        const current=getState(),target=current.chats.find(c=>c.id===chatId);
        if(!target)throw new Error('История удалена до начала генерации.');
        target.messages=chat.messages;
        saveState(current); saved=true; job.inputSaved=true;job.stage='Персонаж пишет';
        let finishReason='',automaticContinuations=0;
        const preset=state.presets.find(p=>p.id===(chat.presetId||state.activePresetId)),samplingOverrides=roleplaySampling(connection,state.settings);
        for(let attempt=0;attempt<3;attempt++){
          signal.throwIfAborted();const completing=!!resume||attempt>0;
          job.stage=completing?'Дописать ответ персонажа':'Персонаж пишет';
          const fitted=completing?await fit(connection,getSecret(connection.id),prompt.messages,{text:job.text,maxTokens:prompt.budget.maxTokens,signal,adaptInstruction:true,instruction:chatResumeInstruction,priorityMessages:[{role:'system',content:'Ты играешь только выбранного персонажа. Не управляй игроком. Сохраняй исходные факты этой истории.'}]}):{messages:prompt.messages,maxTokens:prompt.budget.maxTokens};
          const before=job.text.length,joiner=completing?createTextContinuationJoiner(job.text,{capitalBoundary:true}):undefined;finishReason='';
          const append=chunk=>{if(chunk){job.text+=chunk;if(repeatedReply(job.text))throw Object.assign(new Error('Модель начала повторять один фрагмент. Черновик сохранён; измените запрос или параметры и нажмите «Перегенерировать».'),{code:'RESPONSE_REPETITION'});if(job.text.length>2000000)throw new Error('Ответ превысил допустимый размер.');}};
          const stop=roleplayStops(connection,state.settings),outputFilter=stop?createRoleplayOutputFilter({lineStart:!completing||/\n$/u.test(job.text)}):undefined,appendOutput=chunk=>append(joiner?joiner.push(chunk):chunk);
          try{for await(const chunk of stream(connection,getSecret(connection.id),fitted.messages,{signal,adaptInstruction:true,guardRepetition:true,samplingOverrides,stop,onFinish:reason=>{finishReason=reason;},preset:{...preset,maxTokens:fitted.maxTokens}})){appendOutput(outputFilter?outputFilter.push(chunk):chunk);if(outputFilter?.stopped){finishReason='stop';break;}}}
          finally{if(outputFilter)appendOutput(outputFilter.flush());append(joiner?.flush());}
          if(outputFilter?.stopped)job.text=job.text.trimEnd();
          if(job.text.length===before)throw new Error('Модель не дописала ответ. Черновик сохранён; попробуйте ещё раз.');
          if(finishReason!=='length')break;
          putAssistant(true,'length');automaticContinuations=attempt;
        }
        if(!job.text.trim())throw new Error('Модель вернула пустой ответ.');
        if(finishReason==='length'){
          putAssistant(true,'length');job.warnings.push('Ответ достиг лимита токенов и сохранён как незавершённый. Нажмите «Дописать» или отредактируйте сообщение.');
          return {messageId:assistantId,incomplete:true,automaticContinuations};
        }
        putAssistant(false);
        if(config.enabled&&config.incoming&&!signal.aborted){
          job.stage='Перевод ответа';
          try{
            const translatedContent=(await translationService.translate(job.text,config.modelLanguage,config.displayLanguage,config.provider,{fallback:config.translationFallback,signal})).translation;
            const current=getState(), message=current.chats.find(c=>c.id===chatId)?.messages.find(m=>m.id===assistantId);
            if(message){message.translatedContent=translatedContent;message.translationLanguage=config.displayLanguage;saveState(current);}
          }catch(error){job.warnings.push('Ответ сохранён. Перевод: '+error.message);}
        }
        if(!signal.aborted){
          job.stage='Обновляем сцену';
          try{const current=getState(), target=current.chats.find(c=>c.id===chatId);const patch=await inferScene(current,target,getSecret,signal);if(patch){const fresh=getState();Object.assign(fresh.chats.find(c=>c.id===chatId).scene,patch);saveState(fresh);}}
          catch(error){job.warnings.push('Ответ сохранён. Сцену можно поправить вручную: '+error.message);}
        }
        if(!signal.aborted&&memory&&memoryDue?.(getState().chats.find(c=>c.id===chatId))){try{await memory.summarize(chatId,{signal,onProgress:stage=>{job.stage=stage;}});}catch(error){job.warnings.push('Ответ сохранён. Память: '+error.message);}}
        return {messageId:assistantId,incomplete:false};
      }catch(error){
        if(saved){if(job.text)putAssistant(true,signal.aborted?'stopped':error.code==='RESPONSE_REPETITION'?'repetition':'network');else if(previous&&!persisted){const current=getState();current.chats.find(c=>c.id===chatId)?.messages.push(previous);saveState(current);}}
        throw error;
      }
    });
  }
  return {start};
}

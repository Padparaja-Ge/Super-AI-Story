import {createHash} from 'node:crypto';
import {structuredCompletion,parseObject} from './services/structuredCompletion.js';
import {streamCompletion,countCompletionTokens} from './llm.mjs';
import {messageTokens} from './prompt.mjs';
import {normalizeFanficProfiles,resolveFanficStageProfile,FANFIC_PROFILE_STAGES} from '../shared/fanfic-profiles.mjs';

const SOURCE='Лира ждёт у ворот архива. Она держит медный ключ. Пароль: ЛУНА-731. Торк не знает пароль. Дверь ещё закрыта.';
const SELECTED='Лира сказала: «Пароль ЛУНА-731».';
const BEFORE='Перед воротами лежал снег.\n';
const AFTER='\nТорк ждал у стены.';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string={type:'string'};
const list=items=>({type:'array',items,maxItems:8});
const shapes={
  planning:object({scenes:list(object({title:string,summary:string}))}),
  memory:object({summary:string,password:string,keyHolder:string,keyMaterial:string,doorState:string,torkKnowsPassword:{type:'boolean'}}),
  review:object({issues:list(object({code:string,description:string}))}),
  rewrite:object({replacement:string}),
};
const texts={
  writing:'Напиши завершённую художественную сцену по контрольным фактам, 60–100 слов на русском. Включи точный пароль, медный ключ у Лиры и закрытую дверь. Торк может спросить о пароле, но не узнаёт его. Не добавляй персонажей, предметы, травмы, места или последующие события. Верни только прозу, без плана и пояснений.',
  planning:'Это проверка плана литературной сцены. Верни JSON {"scenes":[{"title":"","summary":""}]} ровно с двумя короткими связанными сценами по фактам. План заканчивается у закрытых ворот; Торк не узнаёт пароль. Включи пароль ЛУНА-731 точно хотя бы в одной summary. Не добавляй новые факты.',
  memory:'Извлеки только явно заданные факты. Верни JSON с summary, password, keyHolder, keyMaterial, doorState, torkKnowsPassword. Используй русские значения: password="ЛУНА-731", keyHolder="Лира", keyMaterial="медь", doorState="закрыта", torkKnowsPassword=false. Summary краткая, без новых событий.',
  review:'Сравни candidate с исходными контрольными фактами SOURCE. Ничего не исправляй. Верни JSON {"issues":[{"code":"","description":""}]}. code выбирается из password, keyMaterial, keyHolder, doorState, knowledge. Отметь все неподтверждённые изменения: неверный пароль, материал/владелец ключа, состояние двери, знание Торка. Description объясняет конкретное противоречие на русском.',
  rewrite:'Отредактируй ТОЛЬКО selected: сделай реплику чуть естественнее. Сохрани имя Лира и точный пароль ЛУНА-731. Не меняй before/after и не включай их в replacement. Не продолжай события и не добавляй новых персонажей. Верни JSON {"replacement":""}, одна короткая русская реплика.',
};
const contexts={
  writing:{facts:SOURCE},planning:{facts:SOURCE},memory:{prose:SOURCE},
  review:{source:SOURCE,candidate:'Торк назвал пароль ЛУНА-000, поднял свой серебряный ключ и открыл дверь.'},
  rewrite:{before:BEFORE,selected:SELECTED,after:AFTER},
};
const badFormat=message=>Object.assign(new Error(message),{code:'CALIBRATION_FORMAT'});
const valueOf=raw=>typeof raw==='string'?parseObject(raw):raw;
const abortable=(promise,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  const aborted=()=>reject(signal.reason);
  signal.addEventListener('abort',aborted,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
});

function parseStage(stage,raw){
  const value=valueOf(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw badFormat('Модель не вернула объект контрольного задания.');
  if(stage==='planning'&&(!Array.isArray(value.scenes)||!value.scenes.length||value.scenes.some(scene=>!scene||typeof scene.title!=='string'||typeof scene.summary!=='string'||!scene.summary.trim())))throw badFormat('План должен содержать непустые title/summary.');
  if(stage==='memory'&&(['summary','password','keyHolder','keyMaterial','doorState'].some(key=>typeof value[key]!=='string'||!value[key].trim())||typeof value.torkKnowsPassword!=='boolean'))throw badFormat('Память должна содержать все контрольные поля и логическое значение знания.');
  if(stage==='review'&&(!Array.isArray(value.issues)||value.issues.some(issue=>!issue||typeof issue.code!=='string'||typeof issue.description!=='string'||!issue.description.trim())))throw badFormat('Проверка должна вернуть список issues.');
  if(stage==='rewrite'&&(typeof value.replacement!=='string'||!value.replacement.trim()||value.replacement.length>600))throw badFormat('Нужна короткая непустая replacement.');
  return value;
}
const contains=(text,value)=>String(text||'').includes(value);
function checksFor(stage,output,finishReason){
  if(stage==='writing')return {format:typeof output==='string'&&!!output.trim(),password:contains(output,'ЛУНА-731'),hero:contains(output,'Лира'),keyMaterial:/медн/iu.test(output||''),closedDoor:/закрыт/iu.test(output||''),noWrongPassword:!contains(output,'ЛУНА-000'),complete:finishReason!=='length'&&/[.!?…»]$/u.test(String(output||'').trim())};
  if(stage==='planning')return {format:true,twoScenes:output.scenes.length===2,password:output.scenes.some(scene=>contains(scene.summary,'ЛУНА-731')),noWrongPassword:!contains(JSON.stringify(output),'ЛУНА-000')};
  if(stage==='memory')return {format:true,password:output.password==='ЛУНА-731',keyHolder:output.keyHolder==='Лира',keyMaterial:output.keyMaterial==='медь',doorState:output.doorState==='закрыта',knowledge:output.torkKnowsPassword===false};
  if(stage==='review'){const codes=new Set(output.issues.map(issue=>issue.code));return {format:true,password:codes.has('password'),keyMaterial:codes.has('keyMaterial'),keyHolder:codes.has('keyHolder'),doorState:codes.has('doorState'),knowledge:codes.has('knowledge'),knownCodes:output.issues.every(issue=>['password','keyMaterial','keyHolder','doorState','knowledge'].includes(issue.code))};}
  const combined=BEFORE+output.replacement+AFTER;
  return {format:true,password:contains(output.replacement,'ЛУНА-731'),hero:contains(output.replacement,'Лира'),onlySelection:!contains(output.replacement,BEFORE.trim())&&!contains(output.replacement,AFTER.trim()),outsideUnchanged:combined.startsWith(BEFORE)&&combined.endsWith(AFTER),noWrongPassword:!contains(output.replacement,'ЛУНА-000')};
}
function recommendation(settings,stages){
  const generationProfiles=normalizeFanficProfiles(settings.generationProfiles),failed=stages.filter(stage=>stage.status==='failed').map(stage=>stage.stage);
  for(const stage of failed){
    const current=resolveFanficStageProfile(settings,stage);
    const ceiling=stage==='writing'?.65:stage==='planning'?.15:stage==='rewrite'?.1:.05;
    generationProfiles.stages[stage]={...generationProfiles.stages[stage],temperature:Math.min(current.temperature,ceiling)};
  }
  const errors=stages.filter(stage=>stage.status==='error');
  return {generationProfiles,reason:failed.length?`В короткой проверке не пройдены: ${failed.map(stage=>({writing:'проза',planning:'план',memory:'память',review:'связность',rewrite:'редактура'})[stage]).join(', ')}. Предлагается снизить вариативность этих этапов; это не гарантирует правильность и не заменяет проверку длинного произведения.`:errors.length?'Часть запросов завершилась технической ошибкой. Сначала проверьте доступность/контекст модели; параметры произведения не изменены.':'Короткие контрольные задания пройдены. Текущие параметры сохранены; длительная связность и художественное качество этой проверкой не гарантируются.',automatic:false};
}

// No project prose, cast or memory is transmitted. The probes use only these
// public neutral fixtures; recommendation requires explicit application by UI.
export async function calibrateFanficModel({state,project,connection,getSecret,signal,structured=structuredCompletion,stream=streamCompletion,countTokens=countCompletionTokens,onProgress,stageTimeoutMs=90000,totalTimeoutMs=300000}){
  const settings=structuredClone(project?.settings||{}),stages=[];
  const report={model:String(connection?.model||''),connectionId:String(connection?.id||''),contextWindow:Number(connection?.contextWindow)||8192,
    speedBasis:'Символы/с за весь запрос: токенизация, ожидание и генерация.',
    profileFingerprint:createHash('sha256').update(JSON.stringify({model:connection?.model,connectionId:connection?.id,contextWindow:connection?.contextWindow,promptFormat:connection?.promptFormat,sampling:connection?.sampling,profiles:normalizeFanficProfiles(settings.generationProfiles),maxTokens:settings.maxTokens,temperature:settings.temperature})).digest('hex'),stages,recommendation:null,createdAt:new Date().toISOString()};
  const totalController=new AbortController(),totalTimer=setTimeout(()=>totalController.abort(Object.assign(new Error('Истекло общее время проверки модели.'),{name:'TimeoutError'})),Math.min(300000,Math.max(1,totalTimeoutMs)));
  try{
    for(const stage of FANFIC_PROFILE_STAGES){
      if(signal?.aborted||totalController.signal.aborted){report.interrupted=true;break;}
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Object.assign(new Error('Модель не завершила контрольное задание вовремя.'),{name:'TimeoutError'})),Math.min(90000,Math.max(1,stageTimeoutMs)));
      const combined=AbortSignal.any([...(signal?[signal]:[]),totalController.signal,controller.signal]),started=performance.now();
      let output,finishReason;
      const result={stage,status:'error',elapsedMs:0,checks:{},outputPreview:''};
      try{
        const profile=resolveFanficStageProfile(settings,stage,{contextWindow:report.contextWindow}),maxTokens=Math.min(profile.maxTokens,stage==='writing'?500:500,Math.floor(report.contextWindow/3));
        const messages=[{role:'system',content:texts[stage]},{role:'user',content:JSON.stringify(contexts[stage])}];
        const actual=await abortable(countTokens(connection,getSecret(connection.id),messages,{signal:combined,adaptInstruction:true,disableThinking:true}),combined);
        combined.throwIfAborted();
        if((actual??messageTokens(messages)*1.6)+maxTokens+200>report.contextWindow)throw Object.assign(new Error('Контрольное задание не помещается в окно модели.'),{code:'CALIBRATION_CONTEXT'});
        if(stage==='writing'){
          output='';
          const iterator=stream(connection,getSecret(connection.id),messages,{signal:combined,adaptInstruction:true,disableThinking:true,preset:{maxTokens,temperature:profile.temperature},onFinish:reason=>{finishReason=reason;}})[Symbol.asyncIterator]();
          try{
            for(;;){
              const next=await abortable(iterator.next(),combined);if(next.done)break;
              combined.throwIfAborted();output+=String(next.value||'');if(output.length>12000)throw badFormat('Контрольная проза превысила допустимый объём.');
            }
          }finally{if(combined.aborted)Promise.resolve(iterator.return?.()).catch(()=>{});}
        }else{
          const raw=await abortable(structured({state,chat:{connectionId:connection.id},getSecret,signal:combined,name:'fanfic_calibration_'+stage,instructions:texts[stage],context:structuredClone(contexts[stage]),schema:shapes[stage],maxTokens,temperature:profile.temperature,adaptInstruction:true,parse:raw=>parseStage(stage,raw)}),combined);
          combined.throwIfAborted();output=parseStage(stage,raw);
        }
        result.checks=checksFor(stage,output,finishReason);result.status=Object.values(result.checks).every(check=>check===true)?'passed':'failed';
        const rendered=typeof output==='string'?output:JSON.stringify(output);result.outputCharacters=rendered.length;result.outputPreview=rendered.slice(0,1600);
        result.request={maxTokens,temperature:profile.temperature};
      }catch(error){
        result.status=error.code==='CALIBRATION_FORMAT'||/Модель дважды нарушила формат|Нужен JSON/iu.test(error.message)?'failed':'error';
        result.checks={format:false};result.error=String(combined.aborted?combined.reason?.message||'Проверка остановлена.':error.message||error).slice(0,500);
      }finally{clearTimeout(timer);result.elapsedMs=Math.max(0,Math.round(performance.now()-started));}
      if(result.outputPreview)result.charactersPerSecond=Math.round(result.outputCharacters/Math.max(.001,result.elapsedMs/1000)*10)/10;
      stages.push(result);report.recommendation=recommendation(settings,stages);onProgress?.(structuredClone(report));
      if(signal?.aborted||totalController.signal.aborted){report.interrupted=true;break;}
    }
    report.recommendation=recommendation(settings,stages);
    if(report.interrupted)report.recommendation.reason='Проверка прервана. Частичные результаты сохранены; рекомендации не следует считать полной оценкой модели.';
    return report;
  }finally{clearTimeout(totalTimer);}
}

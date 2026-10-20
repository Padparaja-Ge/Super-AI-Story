import express from 'express';
import {randomUUID} from 'node:crypto';
import {structuredCompletion,parseObject} from './services/structuredCompletion.js';
import {wizardDefaults} from '../shared/wizard.mjs';
import {convertCharacter,convertLorebook,exportCharacter,exportLorebook} from './formats.mjs';
import {importPersona} from './personas.mjs';
import {validateStorybook} from './storybooks.mjs';

const str={type:'string'}, list={type:'array',items:str};
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const sectionFields={
  identity:{name:str,subtitle:str,description:str},
  personality:{personality:str},
  appearance:{appearance:str,scenario:str},
  dialogue:{firstMessage:str,exampleDialogue:str},
  instructions:{systemPrompt:str,postHistoryInstructions:str,creatorNotes:str,alternateGreetings:list},
  design:{avatar:str,color:{type:'string',enum:['violet','rose','amber','teal','blue']},tags:list},
  persona:{name:str,avatar:str,description:str},
  personaDetails:{appearance:str,personality:str},
  storyIdentity:{name:str,playerCount:{type:'string',enum:['2','2-4','4-8','8-12']}},
  storyWorld:{world:{type:'string',maxLength:8000}},
  storyStart:{start:{type:'string',maxLength:8000}},
  storyGoal:{goal:{type:'string',maxLength:8000}},
  storyDetails:{details:{type:'string',maxLength:8000}},
};
const fieldLabels={name:'Имя',subtitle:'Краткое описание',description:'Описание',personality:'Характер',appearance:'Внешность',scenario:'Сценарий',firstMessage:'Первое сообщение',exampleDialogue:'Примеры диалога',systemPrompt:'Системные инструкции',postHistoryInstructions:'Инструкции после истории',creatorNotes:'Заметки автора',alternateGreetings:'Альтернативные приветствия',avatar:'Символ аватара',color:'Акцент',tags:'Теги',playerCount:'Количество игроков',world:'Описание мира',start:'Стартовая локация',goal:'Цель героев',details:'Дополнительное описание'};
const characterSections=['identity','personality','appearance','dialogue','instructions','design'];
const personaSections=['persona','personaDetails'];
const storySections=['storyIdentity','storyWorld','storyStart','storyGoal','storyDetails'];
const sectionsFor=kind=>kind==='storybook'?storySections:kind==='persona'?personaSections:characterSections;
const allFields=[...new Set(Object.values(sectionFields).flatMap(f=>Object.keys(f)))];
const planSchema=obj({kind:{type:'string',enum:['character','persona','storybook']},name:str,summary:str,lorebooks:{type:'array',maxItems:3,items:str}});
const bookChange=obj({name:str,target:{type:'integer',minimum:-1},instruction:str});
const editPlanSchema=kind=>obj({summary:str,fields:{type:'array',items:{type:'string',enum:sectionsFor(kind).flatMap(k=>Object.keys(sectionFields[k]))}},lorebooks:{type:'array',maxItems:3,items:bookChange}});
const outlineSchema=obj({description:{type:'string',maxLength:500},entries:{type:'array',minItems:1,maxItems:4,items:obj({target:{type:'integer',minimum:-1},name:str,keys:{type:'array',maxItems:8,items:str},brief:{type:'string',maxLength:300}})}});
const preserveLore=text=>/(?:лор\s*бук|lore\s*book|world\s*info)[^.!?;\n]{0,60}(?:без изменений|не меня|не изменя|не трога|unchanged|as is)|(?:не меня|не изменя|не трога|не добавля)[^.!?;\n]{0,35}лор\s*бук/iu.test(text);
const requestsLoreChange=text=>/(?:добав|созда|сдела|напиш|разработ|доработ|переработ|обнов|измени|пополни|расшир|перепиши|отредактируй|add|create|update|edit)[^.!?;\n]{0,45}(?:лор\s*бук|lore\s*book|world\s*info)/iu.test(text);
export function loreOnlyRequest(text){
  if(!requestsLoreChange(text)||preserveLore(text))return false;
  // "для подробного описания взаимодействия" is a book topic, not an edit to description.
  return !/(?:измени|перепиши|замени|сократи|расширь|отредактируй|обнови|переделай|удали|убери)[^.!?;\n]{0,35}(?:внешност|характер|личност|описани|поле|имя|приветств|сценарий|инструкци)|(?:change|rewrite|replace|edit)\s+(?:the\s+)?(?:appearance|personality|description|name|scenario|greeting)/iu.test(text);
}
const fieldCaps={name:100,subtitle:180,description:3200,personality:2000,appearance:1800,scenario:1800,firstMessage:2200,exampleDialogue:2000,systemPrompt:1200,postHistoryInstructions:800,creatorNotes:1000,avatar:16,world:3200,start:2400,goal:1600,details:4000};
const compactData=data=>Object.fromEntries(Object.entries(data||{}).filter(([k,v])=>allFields.includes(k)&&typeof v==='string').map(([k,v])=>[k,v.slice(0,350)]));


// Validate even with providers that ignore response_format. Only declared fields reach storage.
export function validateWizardObject(value,schema,at='result'){
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(at+': нужен объект');
    return Object.fromEntries(Object.entries(schema.properties).map(([key,shape])=>[key,validateWizardObject(value[key],shape,at+'.'+key)]));
  }
  if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems||0)||value.length>(schema.maxItems??20))throw new Error(at+': неверный список');
    return value.map(v=>validateWizardObject(v,schema.items,at));
  }
  if((schema.type==='integer'?!Number.isInteger(value):typeof value!==schema.type)||schema.minimum!==undefined&&value<schema.minimum||schema.enum&&!schema.enum.includes(value))throw new Error(at+': неверное значение');
  if(typeof value==='string'&&value.length>(schema.maxLength??16000))throw new Error(at+': слишком длинный текст');
  return value;
}
export function wizardExport(artifact){
  if(artifact.kind==='storybook')return {spec:'sas_storybook_v1',storybook:validateStorybook(artifact.data)};
  if(artifact.kind==='persona')return {spec:'sas_persona_v1',persona:artifact.data};
  const books=artifact.lorebooks||[],card=exportCharacter({...artifact.data,characterBook:books.length?{name:artifact.data.name,entries:books.flatMap(b=>b.entries)}:undefined});
  card.data.extensions.sas.lorebooks=books.map(b=>exportLorebook(b));
  return card;
}
export function installWizardArtifact(state,artifact){
  if(artifact.kind==='storybook'){const book=validateStorybook({...artifact.data,id:randomUUID()});state.storybooks||=[];state.storybooks.push(book);return {kind:'storybook',id:book.id,name:book.name};}
  if(artifact.kind==='persona'){const p=importPersona(artifact.data);state.personas.push(p);return {kind:'persona',id:p.id,name:p.name};}
  const character=convertCharacter(artifact.data),books=(artifact.lorebooks||[]).map(convertLorebook);
  character.lorebookIds=books.map(b=>b.id);state.lorebooks.push(...books.map(b=>({...b,enabled:false})));state.characters.push(character);
  return {kind:'character',id:character.id,name:character.name};
}

export function createWizard({getState,saveState,getSecret,tasks,complete=structuredCompletion}){
  const read=id=>{const session=getState().wizardSessions.find(s=>s.id===id);if(!session)throw Object.assign(new Error('Диалог мастера не найден.'),{status:404});return session;};
  const patch=(id,fn)=>{const state=getState(),session=state.wizardSessions.find(s=>s.id===id);if(!session)throw new Error('Диалог удалён.');fn(session);session.updatedAt=new Date().toISOString();saveState(state);return session;};
  async function generate(id,text,resume=false){
    tasks.assertIdle();let session=read(id);
    if(!resume&&(typeof text!=='string'||!text.trim()||text.length>8000))throw Object.assign(new Error('Опишите персонажа или правку: от 1 до 8000 символов.'),{status:400});
    if(resume&&(!session.draft||!session.plan))throw new Error('Нет незавершённых разделов. Отправьте запрос мастеру.');
    const state=getState(),settings={...wizardDefaults,...state.settings.wizard},chat={connectionId:settings.connectionId||state.activeConnectionId};
    if(!state.connections.some(c=>c.id===chat.connectionId&&c.model))throw new Error('Выберите и запустите модель в «Модели и API» или в настройках мастера.');
    if(!resume)session=patch(id,s=>{s.messages.push({id:randomUUID(),role:'user',content:text.trim(),createdAt:new Date().toISOString()});s.messages=s.messages.slice(-80);s.plan=null;s.steps=[];s.draft=structuredClone(s.artifact||s.draft);s.completed=[];s.error='';});
    // Old unfinished plans may contain unrestricted whole-card edits. Re-plan from the last request.
    if(resume&&session.plan.version!==2)session=patch(id,s=>{s.plan=null;s.steps=[];s.completed=[];s.draft=structuredClone(s.artifact||s.draft);});
    const task=tasks.run({kind:'wizard',wizardSessionId:id,stage:'AI-мастер: подготовка'},async(signal,job)=>{
      const advance=stage=>{job.stage=stage;patch(id,s=>{s.status='running';s.stage=stage;s.error='';});};
      const request=session.messages.filter(m=>m.role==='user').at(-1)?.content||'';
      const messages=session.messages.slice(-5,-1).map(m=>({role:m.role,content:m.content.slice(0,300)}));
      const budget=Math.max(768,Math.min(3072,Number(settings.maxTokens)||1536));
      const call=async(name,schema,current,extra={})=>complete({
        state,chat,getSecret,signal,name:'wizard_'+name,schema,maxTokens:budget,adaptInstruction:true,
        temperature:name.includes('plan')||name==='outline'?0.15:Math.max(0,Math.min(1.2,Number.isFinite(Number(settings.temperature))?Number(settings.temperature):0.65)),
        instructions:`You are SAS Studio, an editor of characters, player personas and Story books for tabletop campaigns. Return ONLY JSON matching: ${JSON.stringify(schema)}. Write in the user's language (Russian by default). The latest request is the ONLY operation to execute; older messages are context, not pending instructions. Existing JSON is canonical. For edits return replacement values, never append another version or repeat existing paragraphs. Preserve unchanged facts. For character/persona cards never add [lorebook] text; extra world facts belong in REAL lorebook entries. Story book fields: world=world and factions, start=playable initial location and urgent situation, goal=achievable shared objective, details=NPC motivations, branching hooks, consequences and alternatives if NPC die or players change course. Never decide player actions or predetermine victory. Story books are narrative foundations, NOT rulebooks; do not invent mechanical rules. Never create custom blocks. Keep text concise and specific, with no filler. Designer instructions must not enter the card. Complete valid JSON within ${budget} tokens. ${String(settings.instructions||'').slice(0,1500)}`,
        context:{request,messages,current,...extra},parse:raw=>validateWizardObject(parseObject(raw),schema)
      });
      try{
        if(!session.plan){
          const old=session.artifact||session.draft,isEdit=!!old?.data?.name;
          advance(isEdit?'AI-мастер: план точечных изменений':'AI-мастер: замысел и сводка');
          let plan;
          if(isEdit){
            const source={kind:old.kind,fields:compactData(old.data),lorebooks:(old.lorebooks||[]).map((book,index)=>({index,name:book.name,description:book.description?.slice(0,200)}))};
            const result=await call('edit_plan',editPlanSchema(old.kind),source,{instruction:'Return only names of fields EXPLICITLY requested to change. Empty fields means ZERO character edits, not all fields. A request to add a lorebook requires fields:[] and a lorebooks item with target:-1. For an existing book use its zero-based index. Never fill in missing fields or improve unrelated sections. summary: one short sentence about the requested changes.'});
            plan={...result,kind:old.kind,name:old.data.name,edit:true,version:2};
            if(old.kind!=='storybook'&&loreOnlyRequest(request))plan.fields=[];
            if(old.kind!=='storybook'&&requestsLoreChange(request)&&!plan.lorebooks.length)plan.lorebooks=[{name:'Взаимодействие · '+old.data.name,target:-1,instruction:request}];
            if(old.kind==='storybook'){
              plan.lorebooks=[];
              if(/только|лишь|only/iu.test(request)){
                const labels={name:/назван|имя книги/iu,world:/мир/iu,start:/старт|начал/iu,goal:/цел/iu,details:/дополнительн|подробност/iu,playerCount:/количеств.{0,15}игрок/iu};
                const scope=request.split(/[:\n]/,1)[0];
                const explicit=Object.entries(labels).filter(([,rx])=>rx.test(scope)).map(([key])=>key);
                if(explicit.length)plan.fields=explicit;
              }
            }
            if(preserveLore(request))plan.lorebooks=[];
            plan.fields=[...new Set(plan.fields)];
            plan.lorebooks=plan.lorebooks.map(book=>({...book,target:book.target>=0&&old.lorebooks?.[book.target]?book.target:(old.lorebooks||[]).findIndex(b=>b.name.trim().toLowerCase()===book.name.trim().toLowerCase())}));
          }else{
            const hint=session.kindHint||(/story\s*book|стори\s*бук|сюжет.*(?:днд|d&d|нри)|(?:кампани|приключени).*для.*(?:днд|d&d|нри)/iu.test(request)?'storybook':''),schema=structuredClone(planSchema);
            if(hint)schema.properties.kind.enum=[hint];
            const result=await call('plan',schema,null,{instruction:'Choose character (NPC), persona (player) or storybook (D&D/NRI adventure). name and summary are the creative brief. A Story book always has lorebooks:[]; its extra narrative information belongs in details. For cards lorebooks: ONE name if requested, otherwise []. Do not generate sections yet.'});
            plan={...result,edit:false,version:2,fields:sectionsFor(result.kind).flatMap(k=>Object.keys(sectionFields[k])),lorebooks:result.kind==='storybook'?[]:result.lorebooks.map(name=>({name,target:-1,instruction:request}))};
          }
          const draft=isEdit?structuredClone(old):{kind:plan.kind,data:plan.kind==='character'?{blocks:[]}: {},lorebooks:[],summary:plan.summary};
          draft.lorebooks||=[];
          let groups=plan.edit?plan.fields.map(field=>[field]):sectionsFor(plan.kind).map(k=>Object.keys(sectionFields[k]));
          if(!plan.edit&&!settings.detailed)groups=groups.reduce((out,keys,i)=>{if(i%2===0)out.push([]);out.at(-1).push(...keys);return out;},[]);
          // On revisions every response changes exactly one named field. Empty fields never regenerate anything.
          const steps=groups.filter(keys=>keys.length).map((keys,i)=>({id:'fields_'+i,type:'fields',keys}));
          for(const [i,book] of plan.lorebooks.entries())steps.push({id:'book_'+i,type:'outline',book});
          session=patch(id,s=>{s.plan=plan;s.steps=steps;s.draft=draft;s.completed=[];s.title=draft.data.name||plan.name;});
        }
        const plan=session.plan,draft=structuredClone(session.draft),steps=structuredClone(session.steps||[]);
        for(let i=0;i<steps.length;i++){
          signal.throwIfAborted();const step=steps[i];if(session.completed?.includes(step.id))continue;
          advance(`${plan.edit?'Точечная правка':'Детальная генерация'} · ${i+1}/${steps.length} · ${step.type==='fields'?step.keys.map(key=>fieldLabels[key]||key).join(', '):step.type==='outline'?'План лорбука':step.entry.name}`);
          const character=compactData(draft.data);
          if(step.type==='fields'){
            const properties={},current={};
            for(const key of step.keys){
              const shape=Object.values(sectionFields).find(fields=>key in fields)?.[key];if(!shape)throw new Error('Неизвестное поле карточки.');
              properties[key]=structuredClone(shape);
              if(key in draft.data)current[key]=draft.data[key];
              if(shape.type==='string'&&!shape.enum){
                const oldLength=String(current[key]||'').length,expand=/расшир|подробн|детальн|expand|detail/iu.test(request);
                properties[key].maxLength=Math.min(shape.maxLength||16000,plan.edit&&oldLength&&!expand?Math.max(300,oldLength+180):(fieldCaps[key]||2400));
              }
              if(key==='name'&&!plan.edit)properties[key]={type:'string',enum:[plan.name]};
              if(key==='alternateGreetings')properties[key]={type:'array',maxItems:2,items:{type:'string',maxLength:800}};
            }
            const output=await call(step.id,obj(properties),current,{character,kind:plan.kind,designBrief:plan.edit?undefined:plan.summary,instruction:plan.kind==='storybook'?'Заполни только текущие JSON-поля '+step.keys.join(', ')+'. Сейчас не пиши остальные разделы! '+step.keys.map(key=>({world:'world: только география, культура, фракции и особенности мира; 2 коротких абзаца. Не включай цели, старт и план приключения.',start:'start: только начальная локация и наблюдаемая проблема для входа в игру; один абзац. Не описывай решения игроков и всю кампанию.',goal:'goal: только общая достижимая цель героев и критерий её выполнения; 1–2 предложения.',details:'details: мотивы NPC, 2–3 альтернативные зацепки, запасной путь при гибели NPC и последствия; короткий список. Не повторяй мир, старт и цель.',name:'name: только название приключения.',playerCount:'playerCount: диапазон числа игроков из запроса.'})[key]||'').join(' ')+' Сохрани неизменённые факты. Это заготовка для игры, не законченный рассказ. Ответ только JSON.':'Replace ONLY the requested JSON field(s) completely; do not concatenate text. Integrate changes into the existing text and remove redundant wording. Keep unrelated text exactly as it was. description=history/role, personality=habits/values/speech, appearance=physical traits, scenario=starting situation. First greeting and dialogue are playable; use {{char}}/{{user}}, do not control the player. systemPrompt/postHistoryInstructions instruct the FUTURE MODEL to roleplay this character; never copy designer instructions. Extra facts go into lorebooks, never custom blocks.'});
            for(const key of step.keys)if(['name','description','personality','appearance','scenario','firstMessage'].includes(key)&&!output[key].trim())throw new Error('Модель оставила пустое поле: '+key+'. Повторите этап.');
            Object.assign(draft.data,output);
          }else if(step.type==='outline'){
            const existing=step.book.target>=0?draft.lorebooks[step.book.target]:null;
            const outline=await call('outline',outlineSchema,existing?{description:existing.description,entries:existing.entries.map((e,index)=>({index,name:e.name,keys:e.keys}))}:null,{character,bookName:step.book.name,instruction:step.book.instruction+' Plan 2-4 short entries for a NEW book. For an existing book list ONLY entries requested to add/edit (target=-1 for new, otherwise existing entry index). Preserve every unlisted entry. Output outline only; content will be generated separately. Keywords must be meaningful scene triggers, not literal macros.'});
            const bookIndex=existing?step.book.target:draft.lorebooks.length;
            if(!existing)draft.lorebooks.push({name:step.book.name,description:outline.description,entries:[]});
            const entries=outline.entries.map((entry,j)=>({id:step.id+'_entry_'+j,type:'entry',bookIndex,entry:{...entry,target:entry.target>=0&&existing?.entries[entry.target]?entry.target:(existing?.entries||[]).findIndex(e=>e.name.trim().toLowerCase()===entry.name.trim().toLowerCase())},instruction:step.book.instruction}));
            steps.splice(i+1,0,...entries);
          }else{
            const book=draft.lorebooks[step.bookIndex],prior=step.entry.target>=0?book.entries[step.entry.target]:null;
            const output=await call('entry',obj({content:{type:'string',maxLength:1600}}),prior?.content||null,{character,bookName:book.name,entry:step.entry,instruction:step.instruction+' Write ONLY this entry, 80-180 words or fewer if sufficient. Replace rather than append. Concrete playable facts and interaction rules; do not narrate a scene or repeat the entire character card.'});
            if(!output.content.trim())throw new Error('Пустая запись лорбука. Повторите этап.');
            const entry={...(prior||{}),name:step.entry.name,keys:step.entry.keys.map(k=>k.trim()).filter(Boolean),content:output.content,constant:prior?.constant||false};
            if(!entry.keys.length)entry.keys=[draft.data.name];
            if(prior)book.entries[step.entry.target]=entry;else book.entries.push(entry);
          }
          session=patch(id,s=>{s.draft=structuredClone(draft);s.steps=structuredClone(steps);s.completed=[...(s.completed||[]),step.id];});
        }
        signal.throwIfAborted();
        if(draft.kind==='storybook')validateStorybook(draft.data);
        patch(id,s=>{s.artifact={...structuredClone(draft),version:randomUUID()};s.title=draft.data.name||s.title;s.applied=null;s.status='done';s.stage='Готово';s.error='';s.messages.push({id:randomUUID(),role:'assistant',content:plan.summary,createdAt:new Date().toISOString()});});
        return {sessionId:id};
      }catch(error){patch(id,s=>{s.status=signal.aborted?'stopped':'error';s.error=signal.aborted?'Генерация остановлена. Готовые разделы сохранены.':error.message;});throw error;}
    });
    return task.job;
  }
  const router=express.Router();
  router.put('/:id/artifact',(req,res)=>{
    tasks.assertIdle();const session=read(req.params.id),source=session.artifact||session.draft;
    if(!source)throw new Error('Сначала создайте хотя бы один раздел.');
    if(req.body.version!==source.version)throw Object.assign(new Error('Карточка изменилась. Обновите редактор.'),{status:409});
    const next=structuredClone(source),{field,value,bookIndex,entryIndex}=req.body;
    let target=next.data,shape;
    if(bookIndex!==undefined){
      if(!Number.isInteger(bookIndex)||!next.lorebooks?.[bookIndex])throw new Error('Лорбук не найден.');
      target=next.lorebooks[bookIndex];
      if(entryIndex!==undefined){if(!Number.isInteger(entryIndex)||!target.entries?.[entryIndex])throw new Error('Запись не найдена.');target=target.entries[entryIndex];shape={name:str,content:str,keys:list}[field];}
      else shape={name:str,description:str}[field];
    }else shape=sectionsFor(next.kind).map(key=>sectionFields[key]).find(fields=>Object.hasOwn(fields,field))?.[field];
    if(!shape||['__proto__','constructor','prototype'].includes(field))throw new Error('Неизвестное поле карточки.');
    target[field]=validateWizardObject(value,shape);
    if(next.kind==='storybook'&&bookIndex===undefined)validateStorybook(next.data);
    if(field==='name'&&!String(target[field]).trim())throw new Error('Имя не должно быть пустым.');
    next.version=randomUUID();
    const result=patch(session.id,s=>{if(s.artifact)s.artifact=next;s.draft=structuredClone(next);s.title=next.data.name||s.title;s.applied=null;});
    res.json(result);
  });
  router.post('/',(req,res)=>{tasks.assertIdle();const kind=req.body?.kind||'';if(kind&&!['character','persona','storybook'].includes(kind))throw new Error('Неизвестный тип результата мастера.');const state=getState(),now=new Date().toISOString(),session={id:randomUUID(),kindHint:kind,title:kind==='storybook'?'Новое приключение':'Новый диалог',messages:[],artifact:null,draft:null,status:'idle',createdAt:now,updatedAt:now};state.wizardSessions.unshift(session);saveState(state);res.status(201).json(session);});
  router.delete('/:id',(req,res)=>{tasks.assertIdle();read(req.params.id);const state=getState();state.wizardSessions=state.wizardSessions.filter(s=>s.id!==req.params.id);saveState(state);res.json({ok:true});});
  router.post('/:id/messages',async(req,res)=>res.status(202).json(await generate(req.params.id,req.body?.text)));
  router.post('/:id/resume',async(req,res)=>res.status(202).json(await generate(req.params.id,'',true)));
  router.get('/:id/export',(req,res)=>{const s=read(req.params.id);if(!s.artifact)throw new Error('Сначала завершите генерацию.');res.json(wizardExport(s.artifact));});
  router.post('/:id/apply',(req,res)=>{tasks.assertIdle();const s=read(req.params.id);if(!s.artifact)throw new Error('Сначала завершите генерацию.');if(s.applied)return res.json(s.applied);const state=getState(),result=installWizardArtifact(state,s.artifact);state.wizardSessions.find(x=>x.id===s.id).applied=result;saveState(state);res.json(result);});
  return {router,generate};
}

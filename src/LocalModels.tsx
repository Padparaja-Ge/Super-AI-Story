import {useEffect,useState} from 'react';
import {api} from './api';
import {type StudioProps} from './types';
import {Button,Field,Spinner,Toggle} from './UI';
import {runtimeFields,runtimeDefaults,samplingFields,samplingDefaults} from '../shared/local-options.mjs';
import './LocalModels.css';
import {ModelProfiles} from './ModelProfiles';
import {chatTemplateProblem} from '../shared/chat-template.mjs';
const memoryRuntimeKeys=new Set(['loadMode','contextShift','swaCache','flashAttention','cacheTypeK','cacheTypeV']);

function NumberOption({value,field,disabled,onChange}:{value:number;field:any;disabled:boolean;onChange:(n:number)=>void}){
  const [draft,setDraft]=useState(String(value));
  useEffect(()=>setDraft(String(value)),[value]);
  return <input type="number" min={field.min} max={field.max} step={field.step} value={draft} disabled={disabled} aria-label={field.label}
    onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}
    onBlur={()=>{if(disabled)return;let n=draft.trim()?Number(draft):value;if(!Number.isFinite(n))n=value;n=Math.max(field.min,Math.min(field.max,n));if(field.step>=1)n=Math.trunc(n);setDraft(String(n));if(n!==value)onChange(n);}}/>;
}
const bytes=(n:number)=>n>=1024**3?((n/1024**3).toFixed(2)+' ГБ'):((n/1024**2).toFixed(1)+' МБ');
export function LocalModels({state,update,flush,notify,local,directories,runtime,poll,task}:StudioProps & {local:any[];directories:any;runtime:any;poll:()=>Promise<void>}){
  const [hardware,setHardware]=useState<any>(null),[selected,setSelected]=useState(runtime.modelPath||''),[source,setSource]=useState('');
  const [downloadDir,setDownloadDir]=useState('');
  useEffect(()=>{if(runtime.modelPath&&(runtime.running||runtime.preparing||runtime.ready))setSelected(runtime.modelPath);},[runtime.modelPath,runtime.running,runtime.preparing,runtime.ready]);
  useEffect(()=>setDownloadDir(directories?.modelsDir||''),[directories?.modelsDir]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[measuring,setMeasuring]=useState(false),[metadata,setMetadata]=useState<any>(null),[infoError,setInfoError]=useState('');
  const loadHardware=()=>api('/runtime/hardware?refresh=1').then(setHardware).catch(e=>setError(e.message));
  useEffect(()=>{void loadHardware();},[runtime.ready]);
  const locked=busy||runtime.running||runtime.preparing||runtime.embedding?.pending||runtime.embedding?.running||runtime.embedding?.preparing;
  const editingLocked=busy||measuring||runtime.preparing||runtime.embedding?.pending||runtime.embedding?.preparing||task?.status==='running';
  const chosen=state.settings.localDevice||'auto',launch={...runtimeDefaults,...state.settings.localRuntime},sampling={...samplingDefaults,...state.settings.localSampling};
  const optionSignature=JSON.stringify(launch);
  useEffect(()=>{
    let cancelled=false;setInfoError('');setMetadata(null);
    if(!selected)return;
    const timer=setTimeout(async()=>{try{if(!locked)await flush();const result=await api('/local/models/info?'+new URLSearchParams({path:selected}));if(!cancelled)setMetadata(result);}catch(e:any){if(!cancelled)setInfoError(e.message);}},400);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[selected,chosen,state.settings.contextSize,optionSignature,runtime.ready]);
  const recommendation=hardware?.devices.find((d:any)=>d.id===hardware.recommendedId),info=metadata?.info||((runtime.modelPath===selected)?runtime.modelInfo:null);
  const profile=runtime.ready&&runtime.modelPath===selected?runtime.recommendation:metadata?.recommendation;
  const benchmark=runtime.modelPath===selected&&runtime.benchmark?runtime.benchmark:metadata?.benchmark;
  const templateProblem=chatTemplateProblem(info,launch.chatTemplate);
  const activeTemplateProblem=runtime.ready?chatTemplateProblem(runtime.modelInfo,runtime.effectiveOptions?.chatTemplate):'';
  const templateName=(value:string)=>value==='gguf'?'Из GGUF':value||'Неизвестен';
  const restoreGeneration=(withTemplate:boolean)=>{update(s=>{
    s.settings.localSampling={...samplingDefaults};
    if(withTemplate)s.settings.localRuntime={...runtimeDefaults,...s.settings.localRuntime,chatTemplate:'gguf'};
    const c=s.connections.find(c=>c.id==='sas-local');if(c){c.temperature=samplingDefaults.temperature;c.maxTokens=samplingDefaults.maxTokens;}
  });notify(withTemplate?'Шаблон и сэмплеры восстановлены. Остановите модель и запустите её снова.':'Сэмплеры сброшены. Шаблон диалога не изменён.');};
  const patchLaunch=(key:string,value:any)=>update(s=>{s.settings.localRuntime={...runtimeDefaults,...s.settings.localRuntime,[key]:value};if(key==='cpuMoeLayers')s.settings.moeAuto=false;});
  const patchSampling=(key:string,value:any)=>update(s=>{s.settings.localSampling={...samplingDefaults,...s.settings.localSampling,[key]:value};const c=s.connections.find(c=>c.id==='sas-local');if(c&&(key==='temperature'||key==='maxTokens'))c[key]=Number(value);});
  const controls=(fields:any[],values:any,patch:(k:string,v:any)=>void,isLaunch:boolean)=><div className="form-grid local-options-grid">{fields.map(f=>{
    const automatic=f.key==='cpuMoeLayers'&&state.settings.moeAuto!==false&&info?.isMoe;
    const notMoe=['expertUsedCount','cpuMoeLayers'].includes(f.key)&&info&&!info.isMoe;
    const disabled=task?.status==='running'||measuring||(isLaunch&&(editingLocked||(['expertUsedCount','cpuMoeLayers'].includes(f.key)&&info&&!info.isMoe)));
    const field={...f,...(f.key==='expertUsedCount'&&info?.experts?{max:info.experts}:['cpuMoeLayers','cpuFfnLayers'].includes(f.key)&&info?.layers?{max:info.layers}:{})};
    return <Field key={f.key} label={f.label} hint={notMoe?'Не применяется к Dense-модели. Сохранённые MoE-параметры остаются для следующего выбора MoE.':automatic?'Авто выбирает значение при запуске. Введите своё число, чтобы перейти к ручному размещению.':f.hint}>
      {f.options?<select disabled={disabled} value={values[f.key]} onChange={e=>patch(f.key,e.target.value)}>{f.options.map((v:string)=><option key={v} value={v}>{v==='on'?'Включено':v==='off'?'Выключено':v==='auto'?'Автоматически':v==='compact'?'Компактный':v==='full'?'Полный':v==='model'||v==='gguf'?'Из GGUF':v==='disabled'?'Выключено':v==='llama3'?'Llama 3':v==='chatml'?'ChatML':v==='command-r'?'Command R':v}</option>)}</select>
      :<NumberOption field={field} disabled={disabled} value={automatic&&profile?profile.cpuMoeLayers:values[f.key]} onChange={n=>patch(f.key,n)}/>}
    </Field>;
  })}</div>;
  return <div className="local-model-settings"><ModelProfiles settings={state.settings} model={selected} disabled={locked||editingLocked} onApply={(settings:any)=>{update(s=>{s.settings=settings;const c=s.connections.find(c=>c.id==='sas-local');if(c){c.temperature=settings.localSampling.temperature;c.maxTokens=settings.localSampling.maxTokens;}});notify('Профиль применён. Параметры можно изменить перед запуском.');}}/><section className="panel">
    <h3>{runtime.ready?'Модель готова':runtime.preparing?'Подготовка локальных моделей':runtime.running?'Модель загружается…':'Локальная модель'}</h3>
    {runtime.device&&<p>Устройство: <strong>{runtime.device.name}</strong> · {runtime.device.backend.toUpperCase()}</p>}
    {runtime.ready&&<p className="success-text">Подключена к студии. Можно открыть историю и отправить сообщение.</p>}
    {(templateProblem||activeTemplateProblem)&&<div className="error-box" role="alert"><p>{templateProblem||activeTemplateProblem}</p><Button disabled={editingLocked} onClick={()=>{patchLaunch('chatTemplate','gguf');notify('Выбран штатный шаблон. Остановите модель и запустите её снова.');}}>Использовать шаблон из GGUF</Button></div>}
    {runtime.ready&&<p className="local-runtime-active">Работающий шаблон: <strong>{templateName(runtime.effectiveOptions?.chatTemplate)}</strong>{runtime.effectiveOptions?.chatTemplate!==launch.chatTemplate&&<> · После перезапуска: <strong>{templateName(launch.chatTemplate)}</strong></>}</p>}
    {runtime.progress&&<><p>{runtime.progress.stage||'Загрузка компонентов'}</p><progress max={runtime.progress.total||1} value={runtime.progress.downloaded||0}/></>}
    {(error||runtime.error)&&<p className="error-box" role="alert">{error||runtime.error}</p>}
    <Field label="Аппаратное устройство" hint="Автоматический режим выбирает доступный GPU. NVIDIA использует CUDA; совместимые AMD и Intel — Vulkan. Можно выбрать процессор.">
      <select value={chosen} disabled={locked||!hardware} onChange={e=>update(s=>{s.settings.localDevice=e.target.value;})}>
        <option value="auto">Автоматически{recommendation?' — '+recommendation.name+' · '+recommendation.backend.toUpperCase():''}</option>
        {hardware?.devices.map((d:any)=><option key={d.id} value={d.id}>{d.name} · {d.backend.toUpperCase()} · {(d.memoryMiB/1024).toFixed(1)} ГБ</option>)}
        {chosen!=='auto'&&hardware&&!hardware.devices.some((d:any)=>d.id===chosen)&&<option value={chosen}>Ранее выбранное устройство недоступно</option>}
      </select>
    </Field>
    {!hardware&&<p className="loading-row"><Spinner/>Определяем оборудование…</p>}
    {hardware?.warnings?.length>0&&<details><summary>Диагностика устройств</summary>{hardware.warnings.map((w:string)=><p className="muted" key={w}>{w}</p>)}</details>}
    <div className="input-action"><Field label="Модель GGUF"><select value={selected} onChange={e=>setSelected(e.target.value)} disabled={locked}><option value="">Выберите модель</option>{selected&&!local.some(m=>m.path===selected)&&<option value={selected}>{selected.split(/[\\/]/).at(-1)} · текущая модель</option>}{local.map(m=><option key={m.path} value={m.path}>{m.name} · {bytes(m.size)}</option>)}</select></Field>
      {runtime.running||runtime.preparing||runtime.embedding?.running||runtime.embedding?.preparing?<Button disabled={busy||measuring} onClick={async()=>{setBusy(true);try{await api('/runtime/stop',{});await poll();}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Остановить модель</Button>
      :<Button primary disabled={!selected||busy||hardware?.supported===false} onClick={async()=>{setBusy(true);setError('');try{await flush();await api('/runtime/start',{modelPath:selected});await poll();notify('Модель загружается. После загрузки она будет выбрана автоматически.');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Запустить модель</Button>}
    </div>
    {infoError&&<p className="error-box">Метаданные: {infoError}</p>}
    {info&&<section className="local-model-info" aria-label="Сведения о GGUF">
      <div className="row"><strong>{info.isMoe?'MoE':'Dense'} · {info.architecture}</strong><span className="muted">{(info.parameterCount/1e9).toFixed(2)} млрд параметров · {info.layers} слоёв</span></div>
      {info.isMoe&&<><p>Экспертов: <strong>{info.experts}</strong> · Активных из GGUF: <strong>{info.activeExperts}</strong> · Активных параметров: <strong>{(info.activeParameters/1e9).toFixed(2)} млрд</strong></p>
        <div className="setting-toggle"><span>Автонастройка размещения экспертов MoE</span><Toggle label="Автонастройка MoE" disabled={editingLocked} checked={state.settings.moeAuto!==false} onChange={v=>update(s=>{s.settings.moeAuto=v;})}/></div>
        {profile?.applicable&&<><p>{profile.reason} Рекомендуется слоёв с экспертами в RAM: <strong>{profile.cpuMoeLayers}</strong>.</p><p className="muted small">Оценка весов и KV-кэша на GPU: {bytes(profile.estimatedGpuBytes)} · Веса в RAM: {bytes(profile.estimatedRamBytes)}. Расчёт уточняется при запуске по свободной VRAM.</p>{!profile.fits&&<p className="error-box">Даже после переноса экспертов оставшиеся веса и KV-кэш могут не поместиться в VRAM. Уменьшите контекст или число слоёв на GPU.</p>}</>}
        {profile&&!profile.applicable&&<p className="muted small">{profile.reason}</p>}
        {runtime.ready&&runtime.effectiveOptions&&<p className="local-runtime-active" role="status">Сейчас работает: эксперты в RAM — {runtime.effectiveOptions.cpuMoeLayers} слоёв; активных экспертов — {runtime.effectiveOptions.expertUsedCount||info.activeExperts}.</p>}
      </>}
      <p className="muted small">Контекст из GGUF: {info.contextLength.toLocaleString()} токенов · Файл: {bytes(info.size)}</p>
    </section>}
    <div className="local-performance"><div>{benchmark?<><strong>{benchmark.tokensPerSecond.toFixed(1)} токенов/с</strong><p className="muted small">Последний замер: {benchmark.tokens} токенов · {benchmark.device} · контекст {benchmark.context} · {new Date(benchmark.measuredAt).toLocaleString()}. Скорость длинного диалога может отличаться.</p></>:<p className="muted small">Скорость появится после короткого замера на вашем оборудовании.</p>}</div>
      <Button disabled={!runtime.ready||busy||measuring} onClick={async()=>{setMeasuring(true);setError('');try{await flush();const result=await api('/runtime/benchmark',{});setMetadata((m:any)=>({...m,benchmark:result}));await poll();notify('Замер скорости завершён.');}catch(e:any){setError(e.message);}finally{setMeasuring(false);}}}>{measuring?<Spinner/>:null}{measuring?'Измеряем…':'Замерить скорость'}</Button>
    </div>
    <Field label="Папка или файл модели" hint="Полный локальный путь к папке с GGUF или отдельному файлу. Файлы остаются на месте."><div className="input-action"><input value={source} onChange={e=>setSource(e.target.value)} placeholder="C:\Models"/><Button disabled={!source.trim()||busy} onClick={async()=>{setBusy(true);setError('');try{const result=await api('/local/import',{path:source});await poll();if(result.added?.length)setSelected(result.added[0]);setSource('');notify('Модели добавлены.');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Добавить</Button></div></Field>
    {directories&&<div className="local-directories"><Field label="Папка загрузки с Hugging Face"><div className="input-action"><input value={downloadDir} onChange={e=>setDownloadDir(e.target.value)}/><Button disabled={busy||!downloadDir.trim()||downloadDir===directories.modelsDir} onClick={async()=>{setBusy(true);setError('');try{await api('/local/directory',{path:downloadDir});await poll();notify('Папка загрузки изменена. Существующие файлы сохранены.');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Применить</Button></div></Field><small>Конфигурация: {directories.storageConfigPath}</small>{directories.importedDirectories?.length>0&&<><strong>Подключённые папки</strong>{directories.importedDirectories.map((folder:string)=><div className="input-action" key={folder}><code>{folder}</code><Button disabled={busy} onClick={async()=>{setBusy(true);try{await api('/local/folders/remove',{path:folder});await poll();notify('Папка отключена. Файлы остались на месте.');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Отключить</Button></div>)}</>}</div>}
    <div className="form-grid"><Field label="Контекст модели"><NumberOption field={{min:512,max:131072,step:512}} disabled={locked} value={state.settings.contextSize} onChange={n=>update(s=>{s.settings.contextSize=n;})}/></Field>
      <Field label="Слоёв на GPU" hint="Авто подбирает число слоёв по доступной памяти. 0 — CPU, -1 — все слои на GPU."><div className="gpu-layer-controls"><select aria-label="Режим слоёв GPU" disabled={locked} value={state.settings.gpuLayers==='auto'?'auto':'manual'} onChange={e=>update(s=>{s.settings.gpuLayers=e.target.value==='auto'?'auto':-1;})}><option value="auto">Автоматически</option><option value="manual">Указать число</option></select>{state.settings.gpuLayers!=='auto'&&<NumberOption field={{min:-1,max:999,step:1}} disabled={locked} value={Number(state.settings.gpuLayers)} onChange={n=>update(s=>{s.settings.gpuLayers=n;})}/>}</div></Field>
    </div>
    <section className="panel"><div className="row"><Toggle label="Векторизация локальной моделью" checked={!!state.settings.localEmbeddings} disabled={locked} onChange={v=>update(s=>{s.settings.localEmbeddings=v;})}/><strong>Векторизация</strong></div>
      {state.settings.localEmbeddings&&<><Field label="Embedding-модель GGUF"><select disabled={locked} value={state.settings.embeddingModelPath||''} onChange={e=>update(s=>{s.settings.embeddingModelPath=e.target.value;})}><option value="">Выберите отдельную embedding-модель</option>{local.map(m=><option key={m.path} value={m.path}>{m.name}</option>)}</select></Field>
      <div className="form-grid"><Field label="Устройство embedding-модели"><select disabled={locked} value={state.settings.embeddingDevice||'cpu'} onChange={e=>update(s=>{s.settings.embeddingDevice=e.target.value;})}><option value="cpu">Процессор</option><option value="auto">Автоматически</option>{hardware?.devices.filter((d:any)=>d.id!=='cpu').map((d:any)=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Контекст векторизации" hint="128–8192 токенов, с учётом лимита GGUF. Физическая пачка настроена для encoder-моделей автоматически."><NumberOption field={{min:128,max:8192,step:128}} disabled={locked} value={state.settings.embeddingContext||2048} onChange={n=>update(s=>{s.settings.embeddingContext=n;})}/></Field></div>
      <p className="muted small">Запускается вместе с чат-моделью. Использование памяти включается отдельно во вкладке «Память».</p></>}
      {runtime.embedding?.ready&&<p className="success-text">Векторизация готова · контекст {runtime.embedding.context}</p>}{(runtime.embedding?.pending||runtime.embedding?.preparing)&&<p>Загрузка embedding-модели…</p>}{runtime.embedding?.error&&<p className="error-box">{runtime.embedding.error}</p>}
    </section>
    <section className="local-runtime-core" aria-label="Память и контекст локальной модели"><h3>Память и контекст</h3><p className="muted small">Параметры загрузки применяются при следующем запуске модели.</p>{controls(runtimeFields.filter(f=>memoryRuntimeKeys.has(f.key)),launch,patchLaunch,true)}{runtime.ready&&runtime.effectiveOptions&&<details><summary>Параметры работающей модели</summary><p className="muted small">MMAP: {runtime.effectiveOptions.loadMode} · Flash Attention: {runtime.effectiveOptions.flashAttention} · KV-кэш: K {runtime.effectiveOptions.cacheTypeK}, V {runtime.effectiveOptions.cacheTypeV} · Context Shift: {runtime.effectiveOptions.contextShift==='on'?'включён':'выключен'} · SWA-кэш: {runtime.effectiveOptions.swaCache==='full'?'полный':'компактный'}</p></details>}</section>
    <details className="local-advanced"><summary>Дополнительные параметры запуска · CPU и MoE</summary><p className="muted small">Сохраняются для следующего запуска. Работающая модель сохраняет свои параметры. Изменение числа слоёв с экспертами включает ручное размещение; число активных экспертов задаётся отдельно.</p>{runtime.running&&<p className="local-runtime-notice">После правок остановите модель и запустите её снова для применения.</p>}{task?.status==='running'&&<p className="muted small">Изменения доступны после текущей генерации.</p>}{controls(runtimeFields.filter(f=>!memoryRuntimeKeys.has(f.key)),launch,patchLaunch,true)}<Button disabled={editingLocked} onClick={()=>update(s=>{s.settings.localRuntime={...runtimeDefaults};s.settings.moeAuto=true;})}>Сбросить параметры запуска</Button></details>
    <details className="local-advanced"><summary>Параметры генерации · сэмплеры, nsigma и Adaptive P</summary><p className="muted small">Для встроенной чат-модели. Пресеты студии и специальные режимы могут задавать свою температуру, Top P и длину ответа.</p><Field label="Адаптация Alpaca для РП" hint="Для старых шаблонов Alpaca: отдельная инструкция роли и подавление повторов. Ручные значения сэмплеров сохраняют приоритет."><select disabled={task?.status==='running'} value={state.settings.localRpAdaptive===false?'off':'auto'} onChange={e=>update(s=>{s.settings.localRpAdaptive=e.target.value!=='off';})}><option value="auto">Автоматически</option><option value="off">Выключено</option></select></Field>{controls(samplingFields,sampling,patchSampling,false)}<p className="muted small">Сброс сэмплеров действует со следующего запроса; шаблон и параметры загрузки сохраняются. Если после сброса ответы остаются бессвязными, проверьте работающий шаблон выше.</p><div className="row"><Button disabled={task?.status==='running'||measuring} onClick={()=>restoreGeneration(false)}>Сбросить параметры генерации</Button><Button disabled={editingLocked} onClick={()=>restoreGeneration(true)}>Восстановить шаблон и сэмплеры</Button></div></details>
    <Button disabled={locked} onClick={loadHardware}>Обновить список устройств</Button>
    {hardware?.supported===false&&<p className="muted">Встроенный запуск доступен в Windows x64. На этой системе используйте вкладку «Подключения».</p>}
  </section>{runtime.logs?.length>0&&<details className="panel runtime-logs"><summary>Журнал загрузки модели</summary><pre>{runtime.logs.join('\n')}</pre></details>}</div>;
}

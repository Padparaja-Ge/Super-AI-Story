import {importPersona} from './personas.mjs';
import express from 'express';
import {createLocalRuntime} from './local-runtime.mjs';
import {readGguf} from './gguf.mjs';
import {moeRecommendation} from './moe.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import {validateStorybook} from './storybooks.mjs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { convertCharacter, convertLorebook, convertPreset, convertPlugin, convertRegexRules, exportCharacter, exportLorebook, parseImportData } from './formats.mjs';
export { applyRegex } from './formats.mjs';

export function validateRepo(repo) {
  if (typeof repo !== 'string' || repo.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || repo.includes('..')) throw new Error('Некорректное имя репозитория Hugging Face. Формат: автор/модель.');
  return repo;
}

export function validateModelFile(file) {
  if (typeof file !== 'string' || file.length > 500 || !file.toLowerCase().endsWith('.gguf')) throw new Error('Можно загружать только файлы .gguf.');
  const segments = file.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\:%\x00-\x1f<>"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) throw new Error('Небезопасное имя файла модели.');
  return file;
}

export function modelDestination(modelsDir, repo, file) {
  validateRepo(repo);
  validateModelFile(file);
  const root = path.resolve(modelsDir);
  const destination = path.resolve(root, ...repo.split('/'), ...file.split('/'));
  if (!destination.startsWith(root + path.sep)) throw new Error('Путь модели выходит за каталог загрузок.');
  return destination;
}

async function checkNoLinks(root, destination) {
  const relative = path.relative(path.resolve(root), path.resolve(destination));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Недопустимый путь модели.');
  let current = path.resolve(root);
  for (const piece of ['.', ...relative.split(path.sep)]) {
    current = path.resolve(current, piece);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Ссылки в каталоге моделей не поддерживаются.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function assertGguf(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size < 8) throw new Error('Файл модели пуст или недоступен.');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    await handle.read(bytes, 0, 4, 0);
    if (bytes.toString('ascii') !== 'GGUF') throw new Error('Файл не содержит модель GGUF.');
  } finally { await handle.close(); }
  return stat;
}

async function hfJson(url, token = '') {
  const response = await fetch(url, {headers:token ? {Authorization:`Bearer ${token}`} : {}, signal:AbortSignal.timeout(30_000)});
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'Модель закрыта или требует принятия условий на Hugging Face.' : response.status === 429 ? 'Hugging Face ограничил частоту запросов. Повторите позже.' : `Hugging Face ответил HTTP ${response.status}.`;
    throw new Error(message);
  }
  return response.json();
}

export function createIntegrationRouter({getState, saveState, getSecret = () => '', setSecret = () => {}, tasks, dataDir = path.resolve('data')}) {
  const router = express.Router();
  let sessionHfToken = '';
  router.post('/hf/token', (req, res) => {
    if (typeof req.body?.token !== 'string' || req.body.token.length > 8192) return res.status(400).json({error:'Укажите токен Hugging Face.'});
    sessionHfToken = req.body.token.trim();
    res.json({ok:true, hasToken:!!sessionHfToken, stored:'session'});
  });
  let modelsDir = path.join(dataDir, 'models');
  const storageConfigPath=path.join(dataDir,'model-storage.json');
  const storageReady=fs.readFile(storageConfigPath,'utf8').then(raw=>{const config=JSON.parse(raw);if(typeof config.modelsDir==='string'&&path.isAbsolute(config.modelsDir))modelsDir=path.resolve(config.modelsDir);}).catch(e=>{if(e.code!=='ENOENT')throw new Error('Не удалось прочитать model-storage.json.');});
  void storageReady.catch(()=>{});
  const importedModelsPath = path.join(dataDir, 'local-models.json');
  const downloads = new Map();
  const localRuntime=createLocalRuntime({dataDir,getState,saveState,setSecret}),embeddingRuntime=createLocalRuntime({dataDir,getState,saveState,setSecret,embedding:true});
  let embeddingPending=false,embeddingError='',runtimeEpoch=0;
  const runtimeStatus=()=>({...localRuntime.status(),embedding:{...embeddingRuntime.status(),pending:embeddingPending,error:embeddingError||embeddingRuntime.status().error}});
  router.runtimeLocked=()=>localRuntime.status().running||localRuntime.status().preparing||embeddingPending||embeddingRuntime.status().running||embeddingRuntime.status().preparing;
  const hfToken = () => sessionHfToken || getSecret('huggingface') || '';
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (res.headersSent) return next(error);
      res.status(error.status || 400).json({error:error.message || 'Ошибка интеграции.', ...(error.supported === false ? {supported:false} : {})});
    }
  };

  router.post('/import', route(async (req, res) => {
    const {kind, data, fileName = ''} = req.body || {};
    const input = parseImportData(data, fileName);
    const state = getState();
    let imported;
    const warnings = [];
    switch (kind) {
      case 'persona': imported=importPersona(input);state.personas.push(imported);break;
      case 'character': {
        imported = convertCharacter(input);
        if (typeof data === 'string' && (/\.png$/i.test(fileName) || data.startsWith('data:image/png;base64,'))) {
          const portrait = data.replace(/^data:image\/png;base64,/, '');
          if (portrait.length <= 2_800_000) imported.avatar = `data:image/png;base64,${portrait}`;
          else warnings.push('Карточка импортирована. Портрет больше 2 МБ: добавьте уменьшенное изображение отдельно.');
        }
        state.characters = [...(state.characters || []), imported];
        const embedded=input.data?.extensions?.sas?.lorebooks;
        const books=Array.isArray(embedded)&&embedded.length?embedded.slice(0,20).map(convertLorebook):imported.characterBook?[imported.characterBook]:[];
        if(books.length){
          state.lorebooks.push(...books.map(b=>({...b,enabled:false})));
          imported.lorebookIds=books.map(b=>b.id);
          warnings.push('Встроенные лорбуки привязаны к этому персонажу.');
        }
        if (imported.extensions?.regex_scripts?.length) warnings.push('Встроенные Regex-скрипты сохранены в карточке, но не включены. Их можно импортировать отдельно.');
        if (input.spec === 'chara_card_v3') warnings.push('Карточка v3 прочитана как совместимое подмножество v2. Дополнительные поля сохранены, но не исполняются.');
        break;
      }
      case 'lorebook':
        imported = convertLorebook(input);
        state.lorebooks = [...(state.lorebooks || []), imported];
        warnings.push('Поддерживаются ключи, постоянные записи, приоритет и регистр. Расширенные условия SillyTavern сохраняются для экспорта; их применение зависит от возможностей SAS.');
        break;
      case 'preset':
        imported = convertPreset(input, fileName);
        state.presets = [...(state.presets || []), imported];
        warnings.push('Импортированы сообщения промпта и основные параметры. STscript, нестандартные макросы и специфичные для провайдера параметры не исполняются.');
        break;
      case 'regex':
        imported = convertRegexRules(input);
        if ((state.regexRules?.length || 0) + imported.length > 100) throw new Error('Всего поддерживается до 100 глобальных Regex-правил. Удалите лишние правила.');
        state.regexRules = [...(state.regexRules || []), ...imported];
        warnings.push('Правила добавлены. Включите Regex-обработку в плагинах. Slash Commands, STscript, HTML-виджеты и скрытые reasoning-поля не поддерживаются.');
        if (imported.some(rule => rule.substituteRegex)) warnings.push('Подстановка в поиске поддерживает только {{user}} и {{char}} при передаче их контекста.');
        break;
      case 'storybook':
        imported=validateStorybook(input.storybook||input);imported.id=randomUUID();state.storybooks||=[];state.storybooks.push(imported);break;
      case 'plugin':
        imported = convertPlugin(input);
        state.plugins = [...(state.plugins || []), imported];
        warnings.push('Плагин установлен и выключен. Его возможности ограничены текстовым промптом и Regex-правилами.');
        break;
      default: throw new Error('Неизвестный тип импорта.');
    }
    await saveState(state);
    res.json({state:getState(), imported, warnings});
  }));

  router.get('/export/character/:id', route(async (req, res) => {
    const character = getState().characters.find(character => character.id === req.params.id);
    if (!character) return res.status(404).json({error:'Персонаж не найден.'});
    res.attachment('character.json').json(exportCharacter(character));
  }));
  router.get('/export/lorebook/:id', route(async (req, res) => {
    const lorebook = getState().lorebooks.find(lorebook => lorebook.id === req.params.id);
    if (!lorebook) return res.status(404).json({error:'Лорбук не найден.'});
    res.attachment('lorebook.json').json(exportLorebook(lorebook));
  }));

  router.get('/hf/search', route(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const url = new URL('https://huggingface.co/api/models');
    url.search = new URLSearchParams({search:q, filter:'gguf', sort:'downloads', direction:'-1', limit:'30', full:'true'}).toString();
    const result = await hfJson(url, hfToken());
    if (!Array.isArray(result)) throw new Error('Неожиданный ответ каталога Hugging Face.');
    res.json({models:result.map(model => ({id:model.id || model.modelId, downloads:model.downloads || 0, likes:model.likes || 0, tags:Array.isArray(model.tags) ? model.tags : []}))});
  }));
  router.get('/hf/files', route(async (req, res) => {
    const repo = validateRepo(req.query.repo);
    const info = await hfJson(`https://huggingface.co/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?blobs=true`, hfToken());
    const files = (info.siblings || []).filter(file => typeof file.rfilename === 'string' && /\.gguf$/i.test(file.rfilename)).map(file => ({name:file.rfilename, size:file.size || file.lfs?.size || 0}));
    res.json({files, gated:!!info.gated});
  }));

  const publicDownload = download => {
    const {controller, promise, ...result} = download;
    return result;
  };
  async function runDownload(download, destination, root) {
    const partPath = destination + '.part';
    try {
      download.status = 'downloading';
      await fs.mkdir(root, {recursive:true});
      await checkNoLinks(root, destination);
      await fs.mkdir(path.dirname(destination), {recursive:true});
      const connectionTimeout = setTimeout(() => download.controller.abort(new Error('Hugging Face не ответил за 45 секунд.')), 45_000);
      let response;
      try {
        response = await fetch(`https://huggingface.co/${download.repo.split('/').map(encodeURIComponent).join('/')}/resolve/main/${download.file.split('/').map(encodeURIComponent).join('/')}?download=true`, {
          headers:hfToken() ? {Authorization:`Bearer ${hfToken()}`} : {}, signal:download.controller.signal,
        });
      } finally { clearTimeout(connectionTimeout); }
      if (!response.ok || !response.body) throw new Error(response.status === 401 || response.status === 403 ? 'Доступ к модели ограничен. Примите условия на Hugging Face и используйте доступную модель.' : `Загрузка не удалась: HTTP ${response.status}.`);
      download.total = Number(response.headers.get('content-length')) || 0;
      let lastProgress = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - lastProgress > 90_000) download.controller.abort(new Error('Нет данных от Hugging Face дольше 90 секунд.')); }, 10_000);
      try {
        await pipeline(Readable.fromWeb(response.body), new Transform({transform(chunk, encoding, callback) {
          download.downloaded += chunk.length;
          lastProgress = Date.now();
          callback(null, chunk);
        }}), createWriteStream(partPath, {flags:'wx'}), {signal:download.controller.signal});
      } finally { clearInterval(watchdog); }
      if (download.controller.signal.aborted) throw download.controller.signal.reason;
      await assertGguf(partPath);
      await fs.rename(partPath, destination);
      download.status = 'completed';
      download.path = destination;
      download.total = download.downloaded;
    } catch (error) {
      download.status = download.status === 'cancelled' ? 'cancelled' : 'error';
      if (download.status === 'error') download.error = error.message || 'Загрузка остановлена.';
      // This path is derived from validated repository/file segments within modelsDir.
      await fs.unlink(partPath).catch(() => {});
    }
  }
  router.post('/hf/download', route(async (req, res) => {
    await storageReady;
    const {repo, file} = req.body || {};
    const destination = modelDestination(modelsDir, repo, file);
    if ([...downloads.values()].some(download => download.repo === repo && download.file === file && ['queued','downloading'].includes(download.status))) throw new Error('Эта модель уже загружается.');
    if ([...downloads.values()].filter(download => ['queued','downloading'].includes(download.status)).length >= 2) throw new Error('Одновременно можно загружать до двух моделей.');
    const download = {id:randomUUID(), repo, file, status:'queued', downloaded:0, total:0, controller:new AbortController()};
    downloads.set(download.id, download);
    try {
      if (await fs.stat(destination).catch(() => null)) throw new Error('Этот файл уже скачан. Он доступен в локальных моделях.');
      await fs.mkdir(modelsDir, {recursive:true});
      await checkNoLinks(modelsDir, destination);
      // Remove an interrupted previous transfer; completed models are never overwritten.
      await fs.unlink(destination + '.part').catch(error => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) { downloads.delete(download.id); throw error; }
    download.promise = runDownload(download, destination, modelsDir);
    res.status(202).json({id:download.id});
  }));
  router.get('/hf/downloads', (req, res) => res.json({downloads:[...downloads.values()].map(publicDownload)}));
  router.post('/hf/downloads/:id/cancel', route(async (req, res) => {
    const download = downloads.get(req.params.id);
    if (!download) return res.status(404).json({error:'Загрузка не найдена.'});
    if (['queued','downloading'].includes(download.status)) {
      download.status = 'cancelled';
      download.controller.abort();
      await download.promise;
    }
    res.json({download:publicDownload(download)});
  }));

  async function localModels() {
    await storageReady;
    const models = [];
    async function scan(directory, depth = 0) {
      if (depth > 12 || models.length > 2000) return;
      const entries = await fs.readdir(directory, {withFileTypes:true}).catch(() => []);
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await scan(absolute, depth + 1);
        else if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
          const stat = await fs.stat(absolute).catch(() => null);
          if (stat) models.push({name:path.relative(modelsDir, absolute).split(path.sep).join('/'), path:absolute, size:stat.size});
        }
      }
    }
    await scan(modelsDir);
    const imported = JSON.parse(await fs.readFile(importedModelsPath, 'utf8').catch(() => '[]'));
    for (const file of Array.isArray(imported) ? imported.slice(0, 1000) : []) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || models.some(model => model.path === file)) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isFile()) models.push({name:path.basename(file), path:file, size:stat.size, imported:true});
    }
    return models;
  }
  router.get('/local/models', route(async (req, res) => {const models=await localModels(),imported=JSON.parse(await fs.readFile(importedModelsPath,'utf8').catch(()=>'[]'));res.json({models,modelsDir,dataDir,storageConfigPath,importedDirectories:[...new Set(imported.filter(p=>typeof p==='string').map(p=>path.dirname(p)))]});}));
  router.post('/local/directory',route(async(req,res)=>{
    await storageReady;const requested=req.body?.path;
    if(typeof requested!=='string'||!path.isAbsolute(requested)||requested.startsWith('//')||requested.startsWith(String.fromCharCode(92,92)))throw new Error('Укажите абсолютный локальный путь к папке загрузки.');
    if([...downloads.values()].some(d=>['queued','downloading'].includes(d.status)))throw new Error('Дождитесь завершения загрузок.');
    const next=path.resolve(requested);await fs.mkdir(next,{recursive:true});await checkNoLinks(next,next);const real=await fs.realpath(next);
    const previous=await localModels(),imported=JSON.parse(await fs.readFile(importedModelsPath,'utf8').catch(()=>'[]'));
    await fs.writeFile(importedModelsPath,JSON.stringify([...new Set([...imported,...previous.filter(m=>!m.imported).map(m=>m.path)])],null,2));
    await fs.writeFile(storageConfigPath,JSON.stringify({modelsDir:real},null,2));modelsDir=real;res.json({modelsDir,models:await localModels()});
  }));
  router.post('/local/folders/remove',route(async(req,res)=>{
    const folder=req.body?.path;if(typeof folder!=='string'||!path.isAbsolute(folder))throw new Error('Укажите подключённую папку.');
    const root=await fs.realpath(path.resolve(folder)).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return path.resolve(folder);throw error;}),inside=file=>{const rel=path.relative(root,path.resolve(file));return !rel||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
    const imported=JSON.parse(await fs.readFile(importedModelsPath,'utf8').catch(()=>'[]'));
    const canonical=await Promise.all(imported.map(file=>fs.realpath(file).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return path.resolve(file);throw error;})));
    if(!canonical.some(file=>inside(file)))throw new Error('Эта папка не подключена.');
    const files=imported.filter((_,index)=>!inside(canonical[index]));await fs.writeFile(importedModelsPath,JSON.stringify(files,null,2));res.json({ok:true,models:await localModels()});
  }));
  router.get('/local/models/info',route(async(req,res)=>{
    const requested=req.query.path;if(typeof requested!=='string'||!path.isAbsolute(requested))throw new Error('Выберите добавленную модель.');
    const canonical=await fs.realpath(requested).catch(()=>null),model=(await localModels()).find(m=>m.path===requested||m.path===canonical);if(!model)throw new Error('Выберите добавленную модель.');
    const info=await readGguf(model.path),inventory=await localRuntime.hardware(),settings=getState().settings;
    const wanted=settings.localDevice||'auto',device=inventory.devices.find(d=>d.id===(wanted==='auto'?inventory.recommendedId:wanted));
    const recommendation=info.isMoe?moeRecommendation(info,device,Number(settings.contextSize)||8192,settings.localRuntime):null;
    let measurements=[];try{measurements=JSON.parse(await fs.readFile(path.join(dataDir,'local-performance.json'),'utf8'));}catch{}
    res.json({info,recommendation,device,benchmark:Array.isArray(measurements)?measurements.find(m=>m.modelPath===model.path):null});
  }));
  router.post('/local/import', route(async (req, res) => {
    const file = req.body?.path;
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('//') || file.startsWith(String.fromCharCode(92,92))) throw new Error('Укажите абсолютный локальный путь к папке или файлу GGUF.');
    const real = await fs.realpath(file),added=[];
    const scan=async(dir,depth=0)=>{
      if(depth>4||added.length>=1000)return;
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(added.length>=1000)break;
        if(entry.isSymbolicLink())continue;
        const target=path.join(dir,entry.name);
        if(entry.isDirectory())await scan(target,depth+1);
        else if(entry.isFile()&&/\.gguf$/i.test(entry.name)&&(!/-\d{5}-of-\d{5}\.gguf$/i.test(entry.name)||/-00001-of-\d{5}\.gguf$/i.test(entry.name))){await assertGguf(target);added.push(target);}
      }
    };
    if((await fs.stat(real)).isDirectory())await scan(real);else {if(!/\.gguf$/i.test(real))throw new Error('Выберите файл GGUF.');await assertGguf(real);added.push(real);}
    if(!added.length)throw new Error('В папке нет моделей GGUF.');
    const imported = JSON.parse(await fs.readFile(importedModelsPath, 'utf8').catch(() => '[]'));
    const files = [...new Set([...(Array.isArray(imported) ? imported : []), ...added])];
    await fs.mkdir(dataDir, {recursive:true});
    await fs.writeFile(importedModelsPath, JSON.stringify(files, null, 2));
    res.json({models:await localModels(),added});
  }));

  router.get('/runtime/status', (req,res)=>res.json(runtimeStatus()));
  router.get('/runtime/hardware',route(async(req,res)=>res.json(await localRuntime.hardware(req.query.refresh==='1'))));
  router.post('/runtime/benchmark',route(async(req,res)=>{
    const work=signal=>localRuntime.benchmark(signal);
    const result=tasks?await tasks.run({kind:'benchmark',stage:'Замер скорости локальной модели'},work).promise:await work();res.json(result);
  }));
  router.post('/runtime/start',route(async(req,res)=>{
    const selected=(await localModels()).find(model=>model.path===req.body?.modelPath);
    if(!selected)throw new Error('Выберите добавленную локальную модель.');
    if(router.runtimeLocked())throw new Error('Сначала остановите модели.');
    const settings=getState().settings;let emb;
    if(settings.localEmbeddings){emb=(await localModels()).find(m=>m.path===settings.embeddingModelPath);if(!emb)throw new Error('Выберите отдельную GGUF-модель для embeddings.');await assertGguf(emb.path);}
    await assertGguf(selected.path);const epoch=++runtimeEpoch;embeddingError='';embeddingPending=!!emb;localRuntime.start(selected.path);
    if(emb)void localRuntime.whenReady().then(()=>{if(epoch===runtimeEpoch)embeddingRuntime.start(emb.path);}).catch(e=>{if(epoch===runtimeEpoch)embeddingError=e.message;}).finally(()=>{if(epoch===runtimeEpoch)embeddingPending=false;});
    res.status(202).json(runtimeStatus());
  }));
  router.post('/runtime/stop',route(async(req,res)=>{runtimeEpoch++;embeddingPending=false;await Promise.all([localRuntime.stop(),embeddingRuntime.stop()]);res.json(runtimeStatus());}));
  router.close = async () => {
    for (const download of downloads.values()) if (['queued','downloading'].includes(download.status)) { download.status = 'cancelled'; download.controller.abort(); }
    await Promise.all([...downloads.values()].map(download => download.promise));
    runtimeEpoch++;embeddingPending=false;await Promise.all([localRuntime.stop(),embeddingRuntime.stop()]);
  };
  router.modelsDirectory=async()=>{await storageReady;return modelsDir;};
  return router;
}

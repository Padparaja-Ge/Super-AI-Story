import {createSpeechService,validateSpeech} from './tts/service.mjs';
import {focusedRoleplay,roleplayMessages,uniqueSentences} from './roleplay.mjs';
import {mapPNG} from './battlemap.mjs';
import express from 'express';
import {createMemory,memoryDue} from './memory.mjs';
import {createEmbeddings} from './embeddings.mjs';
import {createWizard} from './wizard.mjs';
import {createFanfic} from './fanfic.mjs';
import {createFanficImages} from './fanfic-images.mjs';
import {createNetworkPolicy} from './network.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createStore, projectRoot, defaultDataDir } from './store.mjs';
import { buildPrompt, messageTokens } from './prompt.mjs';
import { getConnection, listModels, streamCompletion, complete, countCompletionTokens } from './llm.mjs';
import { lockCore,coreVersion } from './shared-core.mjs';
import { createTasks } from './tasks.mjs';
import { createGeneration } from './generation.mjs';
import { createLanguageRouter } from './language.mjs';
import { createTranslationService } from './services/translationService.js';
import { createTranslationRouter } from './routes/translation.js';
import { createComfyRouter } from './comfy.mjs';
import { createMultiplayer } from './multiplayer.mjs';
import { createMultiplayerClient } from './multiplayer-client.mjs';
import { rewriteRoomDraft } from './room-rewrite.mjs';
import { createIntegrationRouter, applyRegex } from './integrations.mjs';
import {createExtensions} from './extensions.mjs';
import {createDiagnostics} from './diagnostics.mjs';
import {createRoomNetwork} from './room-network.mjs';
import {createRoomDiscovery} from './room-discovery.mjs';

const isLoopback = address => address === '::1' || /^127\./.test(address || '') || /^::ffff:127\./.test(address || '');

export function localGuard(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ error: 'Личные данные SAS доступны только на этом компьютере.' });
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return res.status(403).json({ error: 'Недопустимый адрес запроса.' }); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(403).json({ error: 'Недопустимый Host.' });
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return res.status(403).json({ error: 'Недопустимый источник запроса.' }); }
    const ownPort = String(req.socket.localPort);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || ![ownPort, '5173'].includes(parsed.port)) {
      return res.status(403).json({ error: 'Запрос с другого сайта отклонён.' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SAS-Client');
    return res.sendStatus(204);
  }
  if (!['GET', 'HEAD'].includes(req.method) && !req.headers['x-sas-client']) return res.status(403).json({ error: 'Для изменения данных нужен заголовок X-SAS-Client.' });
  next();
}

export function createApp({ dataDir = defaultDataDir, store: suppliedStore, translationService: suppliedTranslationService } = {}) {
  const app = express();
  const store = suppliedStore || createStore(dataDir);
  const { getState, saveState } = store;
  const secrets = new Map();
  const active = new Map();
  const diagnostics=createDiagnostics({dataDir:store.dataDir||dataDir});
  const tasks = createTasks({ flush:()=>store.autoCheckpoint?store.autoCheckpoint('task'):store.flush?.(),record:diagnostics.record });
  const leases = new Map(); let lastLease = Date.now();
  const getSecret = id => secrets.get(id) || '';
  const translationService = suppliedTranslationService || createTranslationService({ getLegacyEndpoint: () => String(getState().settings.translation.baseUrl || '').replace(/\/$/, '') + '/translate' });
  const memory=createMemory({getState,saveState,getSecret});
  const embeddings=createEmbeddings({dataDir:store.dataDir||dataDir,getSecret});
  const extensions=createExtensions({dataDir:store.dataDir||dataDir,getState,saveState,tasks});
  const canAutoSave=()=>store.autosaveStatus?.().enabled!==false;
  const multiplayer = createMultiplayer({ getState, saveState, getSecret, dataDir:store.dataDir || dataDir,preparePrompt,tasks,embeddings,translationService,diagnostics,canAutoSave });
  const multiplayerClient=createMultiplayerClient({getState,saveState,dataDir:store.dataDir||dataDir,canAutoSave});
  const roomNetwork=createRoomNetwork({dataDir:store.dataDir||dataDir,getRoom:()=>multiplayer.status(),diagnostics:event=>diagnostics.record('network_'+event.event,{code:event.code,version:event.version})});
  const discovery=createRoomDiscovery({getRoom:()=>multiplayer.status()});
  app.disable('x-powered-by');
  app.use(localGuard);
  app.use('/api', (req, res, next) => {
    // Do not acknowledge optimistic in-memory revisions until their atomic save
    // completes. Error responses bypass the barrier to report persistent failures.
    const sendJSON = res.json.bind(res);
    res.json = body => {
      if (!store.flush || res.statusCode >= 400) return sendJSON(body);
      void store.flush().then(() => {
        if (!res.destroyed && !res.writableEnded) sendJSON(body);
      }, next);
      return res;
    };
    next();
  });
  app.use('/api/translate', createTranslationRouter({ translationService, getSettings: () => getState().settings.translation }));
  app.use('/api/multiplayer/restore',express.json({limit:'65mb'}));
  app.use(express.json({ limit: '24mb' }));
  app.use((req,res,next)=>{const started=Date.now();res.once('finish',()=>{if(res.statusCode>=400)diagnostics.record('http_failed',{method:req.method,route:req.route?.path||'unmatched',status:res.statusCode,durationMs:Date.now()-started});});next();});
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Super AI Story', version: coreVersion }));
  app.post('/api/internal/lease', (req,res)=>{
    const id=String(req.body?.id||'');if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Неверный идентификатор оболочки.');
    for(const [key,expires] of leases)if(expires<Date.now())leases.delete(key);
    if(req.body.release)leases.delete(id);else leases.set(id,Date.now()+20000);
    lastLease=Date.now();res.json({ok:true});
  });
  app.use((req,res,next)=>{
    if(!req.path.startsWith('/api/speech/sessions')&&tasks.busy()&&!['GET','HEAD','OPTIONS'].includes(req.method)){
      const allowed=/^\/api\/(tasks\/stop|diagnostics\/frontend|chats\/[^/]+\/(stop|render)|prompt|grammar|translate|multiplayer\/(message|stop|media|voice|lobby|players\/[^/]+|client\/(message|dice|leave|voice|lobby-ready))|images\/[^/]+\/cancel)$/.test(req.path);
      if(!allowed)return res.status(409).json({error:'Идёт генерация. Дождитесь ответа или остановите её перед изменением настроек.'});
    }
    next();
  });
  createNetworkPolicy().routes(app);
  app.use('/api/diagnostics',diagnostics.router);
  app.get('/api/autosave',(_req,res)=>res.json(store.autosaveStatus?.()||{enabled:true,dirty:false}));
  app.put('/api/autosave',async(req,res)=>{tasks.assertIdle();if(!store.setAutosave)throw new Error('Хранилище не поддерживает настройки сохранения.');const status=await store.setAutosave(req.body);multiplayer.notify();res.json(status);});
  app.post('/api/autosave/save',async(_req,res)=>{tasks.assertIdle();if(!store.persist)throw new Error('Хранилище не поддерживает ручное сохранение.');const status=await store.persist();if(multiplayer.status().room?.id)await multiplayer.backup();const guest=multiplayerClient.status();if(guest.room?.id&&guest.admission!=='pending')await multiplayerClient.backup();res.json(status);});
  app.get('/api/autosave/export',(_req,res)=>res.set({'Content-Disposition':'attachment; filename="SAS-session.json"'}).json(getState()));
  app.use('/api/extensions',extensions.router);
  app.use('/api/wizard',createWizard({getState,saveState,getSecret,tasks}).router);
  app.use('/api/fanfic',createFanfic({getState,saveState,getSecret,tasks,embeddings,extensions}).router);
  app.get('/api/state', (req, res) => res.json(getState()));
  app.put('/api/state', (req, res) => {
    const next = req.body;
    if (!next || typeof next !== 'object' || Array.isArray(next)) return res.status(400).json({ error: 'Ожидается объект состояния.' });
    tasks.assertIdle();
    if(next.settings?.speech)next.settings.speech=validateSpeech(next.settings.speech);
    const current = getState();
    // Advanced flags are desired settings for the next launch; the running process keeps its snapshot.
    if(integrationRouter.runtimeLocked?.()&&['localEmbeddings','embeddingModelPath','embeddingDevice','embeddingContext','localDevice','gpuLayers','contextSize'].some(k=>JSON.stringify(next.settings?.[k])!==JSON.stringify(current.settings[k])))return res.status(409).json({error:'Сначала остановите локальные модели, чтобы изменить устройство, контекст или векторизацию.'});
    if (next.revision !== undefined && next.revision !== current.revision) return res.status(409).json({error:'Данные обновились в другом окне. Изменения не записаны: обновите страницу и повторите правку.'});
    if (current.multiplayer) next.multiplayer = current.multiplayer;
    next.multiplayerHistories=current.multiplayerHistories||[];
    for (const chatId of active.keys()) {
      const existing = current.chats.find(chat => chat.id === chatId);
      const incoming = next.chats?.find(chat => chat.id === chatId);
      if (existing && incoming) incoming.messages = existing.messages;
      else if (existing) return res.status(409).json({ error: 'Сначала остановите генерацию, чтобы удалить чат.' });
    }
    next.images = current.images;
    next.wizardSessions=current.wizardSessions;
    next.fanficProjects=current.fanficProjects;
    res.json(saveState(next));
  });
  app.put('/api/keys', (req, res) => {
    tasks.assertIdle();
    const { connectionId, apiKey } = req.body || {};
    if (typeof connectionId !== 'string' || typeof apiKey !== 'string' || apiKey.length > 8192) return res.status(400).json({ error: 'Укажите подключение и строковый ключ API.' });
    if (!getState().connections.some(connection => connection.id === connectionId)) return res.status(404).json({ error: 'Подключение не найдено.' });
    if (apiKey.trim()) secrets.set(connectionId, apiKey.trim()); else secrets.delete(connectionId);
    res.json({ ok: true, stored: 'session', hasKey: secrets.has(connectionId) });
  });
  app.get('/api/connections/:id/models', async (req, res) => {
    const connection = getState().connections.find(item => item.id === req.params.id);
    if (!connection) return res.status(404).json({ error: 'Подключение не найдено.' });
    res.json({ models: await listModels(connection, getSecret(connection.id)) });
  });
  app.delete('/api/connections/:id', (req,res) => {
    tasks.assertIdle(); const state=getState();
    if(['ollama','lmstudio','llamacpp','openrouter','sas-local','sas-embedding'].includes(req.params.id)) throw new Error('Встроенное подключение нельзя удалить.');
    state.connections=state.connections.filter(c=>c.id!==req.params.id);
    for(const chat of state.chats) if(chat.connectionId===req.params.id) delete chat.connectionId;
    if(state.activeConnectionId===req.params.id) state.activeConnectionId=state.connections[0]?.id || '';
    secrets.delete(req.params.id); saveState(state); res.json({ok:true});
  });
  app.post('/api/connections/:id/test', async (req, res) => {
    const connection = getState().connections.find(item => item.id === req.params.id);
    if (!connection) return res.status(404).json({ error: 'Подключение не найдено.' });
    try { res.json({ ok: true, models: await listModels(connection, getSecret(connection.id)) }); }
    catch (error) { res.json({ ok: false, models: [], error: error.message }); }
  });

  async function preparePrompt(state, chatId, content = '', options = {}) {
    const extra=await extensions.prompt(options.extensionMode||'roleplay',{chatId,content});
    if(extra)options={...options,extraInstructions:[options.extraInstructions,extra].filter(Boolean).join('\n\n')};
    const chat=state.chats.find(c=>c.id===chatId);let retrieval={},warnings=[];
    if(options.retrieval)retrieval=options.retrieval;
    else try{retrieval=await embeddings.retrieve(state,chat,content,options.signal,{includeSources:true});}catch(e){if(options.signal?.aborted)throw e;warnings.push('Векторный поиск: '+e.message+' Использованы ключевые слова и недавние воспоминания.');}
    const connection=getConnection(state,chat);
    const focused=options.roleplay&&focusedRoleplay(connection,state.settings),character=state.characters.find(c=>c.id===chat?.characterId),persona=state.personas.find(p=>p.id===(chat?.personaId||character?.personaId));
    const input=focused?uniqueSentences(content):content;
    const rules=enabledRegex(state);
    const build=async extra=>{const result=buildPrompt(state,chatId,input,{...options,...retrieval,...extra});if(focused){if(rules.length)for(let i=0;i<result.messages.length;i++){const m=result.messages[i];if(m.role==='user'||m.role==='assistant')m.content=await applyRegex(m.content,rules,m.role==='user'?'input':'output',{mode:'prompt',depth:result.messages.length-i-1,macros:{char:character?.name||'',user:state.settings.userName}});}result.messages=roleplayMessages(result.messages,{characterName:character?.name,playerName:persona?.name||state.settings.userName,maxTokens:result.budget.maxTokens,sourceExcerpts:retrieval.sourceExcerpts,archive:chat?.messages});result.estimatedTokens=messageTokens(result.messages);result.roleplayAdapter='focused-alpaca';}result.warnings=warnings;return result;};
    let prompt=await build({allowOverflow:connection.id==='sas-local'});
    if(connection.id==='sas-local'){
      const limit=prompt.budget.contextWindow-prompt.budget.maxTokens-32;
      for(let attempt=0;attempt<12;attempt++){
        const actual=await countCompletionTokens(connection,getSecret(connection.id),prompt.messages,{signal:options.signal,adaptInstruction:true});
        prompt.actualTokens=actual;
        if(actual===null){if(prompt.estimatedTokens>prompt.budget.available)throw new Error('Промпт превышает контекст модели. Сократите сообщение или увеличьте контекст.');break;}
        if(actual<=limit)break;
        if(attempt===11)throw new Error('Инструкции и сообщение не помещаются в контекст модели. Увеличьте окно контекста.');
        const inputBudget=Math.max(100,Math.floor(prompt.budget.available*Math.max(.25,Math.min(.85,limit/actual*.9))));
        prompt=await build({inputBudget,allowOverflow:true});
      }
    }
    prompt.sourceExcerpts=retrieval.sourceExcerpts||[];
    if (rules.length&&!focused) {
      const chat = state.chats.find(item => item.id === chatId);
      const character = state.characters.find(item => item.id === chat?.characterId);
      for (let index = 0; index < prompt.messages.length; index++) {
        const message = prompt.messages[index];
        if (message.role === 'user' || message.role === 'assistant') message.content = await applyRegex(message.content, rules, message.role === 'user' ? 'input' : 'output', { mode: 'prompt', depth: prompt.messages.length - index - 1, macros:{char:character?.name||'', user:state.settings.userName} });
      }
      prompt.estimatedTokens = messageTokens(prompt.messages);
      const actual=await countCompletionTokens(connection,getSecret(connection.id),prompt.messages,{signal:options.signal,adaptInstruction:true});prompt.actualTokens=actual;
      if ((actual??prompt.estimatedTokens) > prompt.budget.contextWindow-prompt.budget.maxTokens-32) throw new Error('После Regex-обработки промпт превышает контекст модели. Сократите правила или увеличьте контекст.');
    }
    return prompt;
  }
  function enabledRegex(state) {
    return [
      ...(state.plugins?.some(plugin => plugin.id === 'regex' && plugin.enabled) ? state.regexRules || [] : []),
      ...(state.plugins || []).filter(plugin => plugin.enabled && !plugin.builtin).flatMap(plugin => plugin.regexRules || []),
    ];
  }
  app.post('/api/chats/:id/render', async (req, res) => {
    const state = getState(), chat = state.chats.find(item => item.id === req.params.id);
    if (!chat) return res.status(404).json({error:'История не найдена.'});
    const character = state.characters.find(item => item.id === chat.characterId), rules = enabledRegex(state);
    const rendered = [];
    for (let index = 0; index < chat.messages.length; index++) {
      const message = chat.messages[index];
      const content = rules.length ? await applyRegex(message.content, rules, message.role === 'user' ? 'input' : 'output', {mode:'display', depth:chat.messages.length-index-1, macros:{char:character?.name||'',user:state.settings.userName}}) : message.content;
      rendered.push({id:message.id,content});
    }
    res.json({messages:rendered});
  });
  app.post('/api/prompt', async (req, res) => res.json(await preparePrompt(getState(), req.body?.chatId, req.body?.content || '',{roleplay:true})));

  const generation = createGeneration({getState,saveState,getSecret,tasks,preparePrompt,translationService,memory,memoryDue});
  app.get('/api/tasks/current', (req,res) => res.json({task:tasks.publicTask(),revision:getState().revision}));
  app.post('/api/generations', (req,res) => {const task=generation.start(req.body);res.status(202).json(task.job);});
  app.post('/api/tasks/stop',async(req,res)=>{await tasks.stop();res.json({ok:true});});
  app.post('/api/chats/:id/stop',async(req,res)=>{await tasks.stop(req.params.id);res.json({ok:true});});
  app.post('/api/chat', async (req,res) => {
    const task=generation.start(req.body);
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();
    let offset=0;
    const send=data=>{if(!res.destroyed&&!res.writableEnded)res.write(`data: ${JSON.stringify(data)}\n\n`);};
    const pump=()=>{const text=task.job.text.slice(offset);offset=task.job.text.length;if(text)send({type:'delta',text});};
    const timer=setInterval(pump,40);
    try{await task.promise;pump();send({type:'done'});}catch(error){pump();send({type:'error',error:error.message});}
    finally{clearInterval(timer);if(!res.destroyed)res.end();}
  });
  app.post('/api/chats/:id/summarize',async(req,res)=>{
    const task=tasks.run({kind:'summary',chatId:req.params.id,stage:'Сводка по частям'},(signal,job)=>memory.summarize(req.params.id,{signal,onProgress:stage=>{job.stage=stage;}}));
    if(req.body?.background)return res.status(202).json(task.job);
    res.json(await task.promise);
  });
  app.post('/api/embeddings/test',async(req,res)=>{const vectors=await embeddings.vectors(getState(),['Путешественник вспоминает встречу у башни.',...Array.from({length:3},(_,i)=>`Запись ${i}: `+'В старой башне хранится карта. Герои встретили хранителя, получили ключ и обещали вернуться после похода. '.repeat(20))]);res.json({dimensions:vectors[0].length,documents:vectors.length});});

  app.delete('/api/multiplayer/histories/:id',(req,res)=>{tasks.assertIdle();res.json(multiplayer.removeHistory(req.params.id));});
  app.get('/api/multiplayer/status', (req, res) => res.json(multiplayer.status()));
  app.post('/api/multiplayer/start', async (req, res) => {tasks.assertIdle();const result=await tasks.run({kind:'multiplayer',stage:'Подготовка приключения'},signal=>multiplayer.start(req.body || {},signal)).promise;if(req.body?.discovery===true)await discovery.listen().catch(error=>diagnostics.record('discovery_failed',{code:error.code||'UDP_UNAVAILABLE'}));res.json({...result,discovery:discovery.status()});});
  app.post('/api/multiplayer/stop', async (req, res) => {await roomNetwork.stop();await discovery.close();res.json(await multiplayer.stop());});
  app.get('/api/multiplayer/local-rooms',async(_req,res)=>res.json({rooms:await discovery.scan(),...discovery.status()}));
  app.get('/api/multiplayer/network',async(_req,res)=>{await roomNetwork.ready;res.json({...roomNetwork.status(),discovery:discovery.status()});});
  app.post('/api/multiplayer/network/install',async(_req,res)=>res.json(await roomNetwork.install()));
  app.post('/api/multiplayer/network/start',async(_req,res)=>res.json(await roomNetwork.start()));
  app.post('/api/multiplayer/network/stop',async(_req,res)=>res.json(await roomNetwork.stop()));
  app.post('/api/multiplayer/diagnose',async(req,res)=>res.json(await roomNetwork.diagnose(req.body?.url)));
  app.post('/api/multiplayer/lobby',async(req,res)=>res.json(await multiplayer.lobby(req.body)));
  app.post('/api/multiplayer/correct',(req,res)=>res.json(multiplayer.correct(req.body)));
  app.get('/api/multiplayer/backups',async(_req,res)=>res.json(await multiplayer.backups()));
  app.get('/api/multiplayer/backup',async(req,res)=>res.json(await multiplayer.backup(req.query.id)));
  app.post('/api/multiplayer/restore',async(req,res)=>{tasks.assertIdle();res.json(await multiplayer.restoreBackup(req.body));});
  app.post('/api/multiplayer/media',async(req,res)=>res.json(await multiplayer.mediaCommand(req.body)));
  app.post('/api/multiplayer/voice',async(req,res)=>res.json(await multiplayer.voiceCommand(req.body)));
  app.get('/api/multiplayer/audio/:id',async(req,res)=>multiplayer.audio(req,res,new URL('http://localhost/api/multiplayer/audio/'+encodeURIComponent(req.params.id))));
  app.post('/api/multiplayer/generate', async (req, res) => {const task=tasks.run({kind:'multiplayer',stage:'Ведущий пишет ответ'},signal=>multiplayer.generate({...req.body,signal}));res.json(await task.promise);});
  app.post('/api/multiplayer/message', (req, res) => res.json(multiplayer.hostMessage(req.body?.content)));
  app.use('/api', createLanguageRouter({getState,saveState,getSecret,secrets,tasks}));
  const comfyRouter = createComfyRouter({getState,saveState,getSecret,tasks,dataDir:store.dataDir || dataDir,onRoomImage:image=>multiplayer.publishImage(image)});
  app.use('/api',comfyRouter);
  app.use('/api/fanfic',createFanficImages({getState,saveState,getSecret,tasks,comfyRouter}));
  app.post('/api/multiplayer/map-texture',async(req,res)=>{if(!multiplayer.status().running)throw new Error('Откройте комнату.');res.status(202).json(await comfyRouter.queueMap(getState().multiplayer));});
  app.put('/api/multiplayer/settings',(req,res)=>res.json(multiplayer.configure(req.body)));
  app.post('/api/multiplayer/summarize',async(req,res)=>{const task=tasks.run({kind:'room-summary',stage:'Память комнаты'},(signal,job)=>multiplayer.summarizeMemory({signal,onProgress:stage=>{job.stage=stage;}}));if(req.body?.background)return res.status(202).json(task.job);res.json(await task.promise);});
  app.put('/api/multiplayer/messages/:id',(req,res)=>res.json(multiplayer.editMessage(req.params.id,req.body?.content)));
  app.post('/api/multiplayer/players/:id',(req,res)=>res.json(multiplayer.moderate(req.params.id,req.body?.action)));
  app.post('/api/multiplayer/game',(req,res)=>res.json(multiplayer.act(req.body)));
  app.post('/api/multiplayer/client/game',async(req,res)=>res.json(await multiplayerClient.command('game',req.body)));
  app.post('/api/multiplayer/map',async(req,res)=>{const task=tasks.run({kind:'battlemap',stage:'Создаём карту'},(signal,job)=>multiplayer.makeMap({...req.body,signal,onProgress:stage=>{job.stage=stage;}}));res.status(202).json(task.job);});
  app.get('/api/multiplayer/map/:layer',(req,res)=>{const map=getState().multiplayer?.tactical?.map;if(!map)return res.sendStatus(404);res.type('png').send(mapPNG(map,req.params.layer));});
  app.post('/api/multiplayer/dice',(req,res)=>res.json(multiplayer.dice(req.body?.sides)));
  app.post('/api/multiplayer/image-prompt',async(req,res)=>{
    if(!multiplayer.status().running)throw new Error('Откройте комнату.');
    const {state,chat}=multiplayer.context();res.json(await comfyRouter.makeImagePrompt(state,chat,req.body?.instructions));
  });
  app.post('/api/multiplayer/images',async(req,res)=>{
    if(!multiplayer.status().running)throw new Error('Откройте комнату.');
    const {roomId}=multiplayer.context();res.status(202).json(await comfyRouter.queueImage({roomId,prompt:req.body?.prompt}));
  });
  app.get('/api/multiplayer/client/status',(req,res)=>res.json(multiplayerClient.status()));
  app.get('/api/multiplayer/client/export',(req,res)=>res.json(multiplayerClient.exportChat()));
  app.post('/api/multiplayer/client/join',async(req,res)=>{
    if(multiplayer.status().running)throw new Error('Закройте свою комнату перед подключением к другой.');
    res.json(await multiplayerClient.join(req.body));
  });
  app.post('/api/multiplayer/client/leave',async(req,res)=>res.json(await multiplayerClient.leaveAsync()));
  app.post('/api/multiplayer/client/lobby-ready',async(req,res)=>res.json(await multiplayerClient.command('lobby-ready',req.body)));
  app.post('/api/multiplayer/client/voice',async(req,res)=>res.json(await multiplayerClient.command('voice',req.body)));
  app.get('/api/multiplayer/client/audio/:id',async(req,res)=>multiplayerClient.audio(req.params.id,req,res));
  app.get('/api/multiplayer/client/backups',async(_req,res)=>res.json(await multiplayerClient.recoveries()));
  app.get('/api/multiplayer/client/backup',async(req,res)=>res.json(req.query.id?await multiplayerClient.recovery(req.query.id):await multiplayerClient.backup()));
  app.post('/api/multiplayer/client/message',async(req,res)=>res.json(await multiplayerClient.command('message',{content:req.body?.content})));
  app.post('/api/multiplayer/client/dice',async(req,res)=>res.json(await multiplayerClient.command('dice',{sides:req.body?.sides})));
  app.get('/api/multiplayer/client/media/:id/:index',async(req,res)=>multiplayerClient.media(req.params.id,req.params.index,res));
  app.post('/api/multiplayer/client/rewrite',async(req,res)=>{
    const payload=multiplayerClient.rewritePayload(req.body?.text,req.body?.connectionId);
    const task=tasks.run({kind:'rewrite',stage:'Ваша модель улучшает черновик'},signal=>rewriteRoomDraft(getState(),payload,getSecret,signal));
    res.json({text:await task.promise});
  });
  app.post('/api/multiplayer/rewrite-draft',async(req,res)=>{
    const task=tasks.run({kind:'rewrite',stage:'Ваша модель улучшает черновик'},signal=>rewriteRoomDraft(getState(),req.body||{},getSecret,signal));
    res.json({text:await task.promise});
  });
  const integrationRouter = createIntegrationRouter({ getState, saveState, getSecret, tasks, setSecret:(id,key)=>secrets.set(id,key), dataDir: store.dataDir || dataDir });
  const speech=createSpeechService({dataDir:store.dataDir||dataDir,getState,saveState,getModelsDir:integrationRouter.modelsDirectory});
  app.use('/api/speech',speech.router);
  app.use('/api', integrationRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Метод API не найден.' }));
  const dist = path.join(projectRoot, 'dist');
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (req, res) => {
    if (fs.existsSync(path.join(dist, 'index.html'))) res.sendFile('index.html', {root:dist});
    else res.status(503).type('text/plain').send('SAS: интерфейс ещё не собран. Выполните npm run build или используйте npm run dev.');
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 400).json({ error: error.type === 'entity.too.large' ? 'Файл или запрос слишком большой.' : error.message || 'Не удалось выполнить запрос.' });
  });
  app.locals.runtime = { store, multiplayer, diagnostics,roomNetwork,discovery,secrets, active, tasks, speech, extensions, leases, lastLease:()=>{for(const [id,expires] of leases)if(expires<Date.now())leases.delete(id);return lastLease;}, close: async () => { try { translationService.close(); await speech.close(); await tasks.stop(); await extensions.close(); await comfyRouter.close(); for (const controller of active.values()) controller.abort(); await roomNetwork.close();await discovery.close();await multiplayer.stop(); await multiplayerClient.close(); if (integrationRouter.close) await integrationRouter.close(); secrets.clear(); } finally { try{if(store.close)await store.close();await store.flush?.();}finally{await diagnostics.close();} } } };
  return app;
}

export async function startServer({ port = Number(process.env.SAS_PORT || 3210), dataDir = defaultDataDir, host = '127.0.0.1', translationService } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Личный сервер SAS можно запускать только на loopback. Для сети используйте режим мультиплеера.');
  const lock = lockCore(dataDir);
  let app;try { app = createApp({ dataDir, translationService }); } catch(error) {lock.release();throw error;}
  const server = http.createServer(app);
  try { await app.locals.runtime.extensions.ready;await app.locals.runtime.diagnostics.ready;await app.locals.runtime.roomNetwork.ready; await app.locals.runtime.store.flush?.(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { try { await app.locals.runtime.close(); } finally { lock.release(); } throw error; }
  const actualPort = server.address().port;
  lock.publish(actualPort);
  let closing;
  const close = () => closing ||= (async () => { try { await app.locals.runtime.close(); } finally { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); lock.release(); } })();
  return { app, server, port: actualPort, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().then(runtime => {
    console.log(`SAS готов: http://127.0.0.1:${runtime.port}`);
    const shutdown = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    process.on('message', message => { if (message?.type === 'sas:shutdown') void shutdown(); });
  }).catch(error => { console.error(`SAS: ${error.message}`); process.exitCode = 1; });
}

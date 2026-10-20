import {autosaveDefaults,validateAutosave} from './autosave.mjs';
import {speechSettings} from '../shared/speech.mjs';
import {wizardDefaults} from '../shared/wizard.mjs';
import {fanficDefaults} from '../shared/fanfic.mjs';
import {safeAvatar} from '../shared/avatar.mjs';
import {memoryDefaults} from './memory.mjs';
import {embeddingDefaults} from './embeddings.mjs';
import {normalizeOptions,samplingFields} from '../shared/local-options.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import './config/env.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyScene, translationDefaults, grammarDefaults, comfyDefaults } from '../shared/defaults.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultDataDir = path.resolve(process.env.SAS_DATA_DIR || (process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Super AI Story', 'data') : path.join(projectRoot, 'data')));
const seed = JSON.parse(fs.readFileSync(path.join(projectRoot, 'shared', 'seed.json'), 'utf8'));
const secretNames = /^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|secrets)$/i;

function clean(value, depth = 0) {
  if (depth > 45) throw new Error('Слишком глубокая структура данных.');
  if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (secretNames.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = clean(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ожидается объект состояния.');
  const state = clean(input);
  for (const key of ['characters', 'chats', 'lorebooks', 'connections', 'plugins', 'presets', 'regexRules']) {
    if (!Array.isArray(state[key])) state[key] = structuredClone(seed[key] || []);
  }
  const migrating = Number(state.version || 1) < 2;
  state.version = 2;
  state.settings ||= {};state.settings.localEmbeddings??=false;state.settings.embeddingModelPath??='';state.settings.embeddingDevice??='cpu';if(!Array.isArray(state.storybooks))state.storybooks=[];
  if(!state.settings.localDevice){state.settings.localDevice='auto';state.settings.gpuLayers='auto';}
  state.revision = Number(state.revision) || 0;
  state.settings = { ...structuredClone(seed.settings), ...state.settings, narrative: { ...seed.settings.narrative, ...state.settings?.narrative } };
  state.settings.speech=speechSettings(state.settings.speech);
  state.settings.translation = { ...translationDefaults, ...state.settings.translation };
  state.settings.wizard={...wizardDefaults,...state.settings.wizard};
  state.settings.embeddings={...embeddingDefaults,...state.settings.embeddings};
  state.settings.localRuntime=normalizeOptions(state.settings.localRuntime);
  const localConnection=state.connections.find(c=>c.id==='sas-local');
  state.settings.localSampling=normalizeOptions(state.settings.localSampling||{temperature:localConnection?.temperature??.8,maxTokens:localConnection?.maxTokens??1024},samplingFields);
  if(localConnection)Object.assign(localConnection,{temperature:state.settings.localSampling.temperature,maxTokens:state.settings.localSampling.maxTokens});
  state.settings.moeAuto??=true;
  state.settings.localRpAdaptive??=true;
  state.settings.embeddingContext??=2048;
  if(!Array.isArray(state.wizardSessions))state.wizardSessions=[];
  if(!Array.isArray(state.fanficProjects))state.fanficProjects=[];
  for(const project of state.fanficProjects)project.settings={...fanficDefaults,...project.settings};
  state.settings.grammar = { ...grammarDefaults, ...state.settings.grammar };
  const oldComfy=state.settings.comfy||{};
  state.settings.comfy = { ...comfyDefaults, ...oldComfy };
  state.settings.comfy.mapBaseUrl=oldComfy.mapBaseUrl??oldComfy.baseUrl??comfyDefaults.mapBaseUrl;
  if(!oldComfy.mapPromptVersion){
    if(oldComfy.mapPositivePrefix==='Battlemap, orthographic top-down tactical floor plan, clear walkable paths, readable terrain, consistent room boundaries, detailed medieval fantasy environment')state.settings.comfy.mapPositivePrefix=comfyDefaults.mapPositivePrefix;
    if(oldComfy.mapNegative==='people, characters, tokens, figures, text, labels, numbers, watermark, grid, perspective, isometric, tilted camera, blocked corridors, blurry, low quality')state.settings.comfy.mapNegative=comfyDefaults.mapNegative;
  }
  state.settings.comfy.mapPromptVersion=2;
  if(!Object.keys(oldComfy.mapWorkflow||{}).length){state.settings.comfy.mapWorkflow=structuredClone(comfyDefaults.mapWorkflow);state.settings.comfy.mapWorkflowName=comfyDefaults.mapWorkflowName;state.settings.comfy.mapModel=oldComfy.mapModel||comfyDefaults.mapModel;}
  if(oldComfy.mapModel===undefined&&oldComfy.mapWorkflowName&&Object.keys(oldComfy.mapWorkflow||{}).length)state.settings.comfy.mapModel=oldComfy.model||'';
  if(!oldComfy.promptVersion&&!oldComfy.negative)state.settings.comfy.negative=comfyDefaults.negative;
  state.settings.comfy.promptVersion=2;
  state.settings.appearance = { fontScale: 1, colors: {}, ...state.settings.appearance };
  if (!Array.isArray(state.personas)) state.personas = [{id:'persona-default',name:state.settings.userName || 'Игрок',description:'',appearance:'',personality:'',avatar:'✧'}];
  for(const persona of state.personas)persona.avatar=safeAvatar(persona.avatar);
  if (!Array.isArray(state.images)) state.images = [];
  state.rpg = { ...structuredClone(seed.rpg), ...state.rpg };
  state.activeConnectionId ||= state.connections[0]?.id || '';
  state.activePresetId ||= '';
  for (const connection of state.connections) {
    if (!connection || typeof connection.id !== 'string') throw new Error('У подключения должен быть идентификатор.');
    if (connection.baseUrl) {
      let url;
      try { url = new URL(connection.baseUrl); } catch { throw new Error('Некорректный адрес API подключения.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Адрес API должен быть HTTP(S), без ключей, логина и параметров. Ключ вводится в отдельном поле.');
      }
      connection.baseUrl = url.toString().replace(/\/$/, '');
    }
  }
  for (const chat of state.chats) {
    if (!chat || typeof chat.id !== 'string') throw new Error('У чата должен быть идентификатор.');
    if (!Array.isArray(chat.messages)) chat.messages = [];
    if (!Array.isArray(chat.memory)) chat.memory = [];
    chat.summary = String(chat.summary || '');
    chat.personaId ??= state.characters.find(c => c.id === chat.characterId)?.personaId || state.personas[0]?.id || '';
    chat.memorySettings = {...memoryDefaults,memoryMode:state.settings.memoryMode,historyLimit:state.settings.historyLimit,loreBudget:state.settings.loreBudget,scanDepth:state.settings.scanDepth,...chat.memorySettings};
    chat.scene = { ...emptyScene(), ...(migrating && chat.id === state.chats[0]?.id ? state.rpg : {}), ...chat.scene };
  }
  for (const character of state.characters) {
    character.personaId ??= state.personas[0]?.id || '';
    if (!Array.isArray(character.lorebookIds)) character.lorebookIds = [];
  }
  return state;
}

export function createStore(dataDir = defaultDataDir, { io = fs, retryDelays = [25, 75, 150, 300, 600] } = {}) {
  io.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'state.json');
  const policyFile=path.join(dataDir,'autosave-policy.json');
  let policy={...autosaveDefaults};if(io.existsSync(policyFile)){try{policy=validateAutosave(JSON.parse(io.readFileSync(policyFile,'utf8')));}catch{throw new Error('Не удалось прочитать autosave-policy.json. Исправьте настройки автосохранения.');}}
  let autoTimer,lastSavedAt=io.existsSync(filename)?io.statSync(filename).mtime.toISOString():null,savedRevision=0,closed=false;
  let state;
  if (io.existsSync(filename)) {
    try { state = sanitizeState(JSON.parse(io.readFileSync(filename, 'utf8'))); }
    catch (error) { throw new Error(`Не удалось прочитать сохранение ${filename}: ${error.message}. Исходный файл сохранён.`); }
  } else state = sanitizeState(structuredClone(seed));
  for(const session of state.wizardSessions)if(session.status==='running'){session.status='stopped';session.error='Приложение было закрыто. Готовые разделы сохранены — нажмите «Продолжить».';}
  for(const project of state.fanficProjects)for(const episode of project.episodes||[])if(episode.status==='running'){episode.status='stopped';episode.error='Приложение было закрыто. Текст сохранён; генерацию можно продолжить.';}
  savedRevision=io.existsSync(filename)?state.revision:-1;
  // Most saves retain the synchronous contract. A Windows reader or antivirus can
  // briefly prevent atomic replacement; only that case enters this single writer.
  let pending = null, writer = null, writeError = null;
  const temporaryName = () => `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const transient = error => ['EPERM', 'EBUSY'].includes(error?.code);
  const failure = (error, recoverable = false) => Object.assign(new Error(`Не удалось сохранить данные: ${error.message}. Последний сохранённый файл не заменён.${recoverable ? ' Новые данные остаются в памяти; временная копия сохранена для восстановления.' : ''}`, { cause: error }), { code: 'STATE_SAVE_FAILED', status: 500 });
  const discard = async record => { if (record?.temporary) await io.promises.unlink(record.temporary).catch(() => {}); };
  const prepare = async record => {
    if (!record.temporary) {
      const temporary = temporaryName();
      try { await io.promises.writeFile(temporary, JSON.stringify(record.state, null, 2), { encoding: 'utf8', mode: 0o600 }); }
      catch (error) { await io.promises.unlink(temporary).catch(() => {}); throw error; }
      record.temporary = temporary;
    }
  };
  async function persistPending() {
    while (pending) {
      const record = pending; pending = null;
      try {
        await prepare(record);
        for (let attempt = 0;; attempt++) {
          try { await io.promises.rename(record.temporary, filename);savedRevision=record.state.revision;lastSavedAt=new Date().toISOString(); break; }
          catch (error) {
            if (!transient(error) || attempt >= retryDelays.length) throw error;
            await delay(retryDelays[attempt]);
          }
        }
      } catch (error) {
        // Keep the latest revision recoverable even if more stream chunks arrived
        // while an older revision was waiting for the destination to be unlocked.
        const recovery = pending || record;
        pending = null; // The recovery copy belongs to this writer, not saveState.
        if (recovery !== record) {
          try { await prepare(recovery); await discard(record); }
          catch { /* The original complete temporary copy is still recoverable. */ }
        }
        // Preparing the recovery file yields: another streamed revision may have
        // arrived meanwhile. Capture it before rejecting further saves, and never
        // overwrite it with the older recovery snapshot after an await.
        const latest = pending || recovery;
        pending = latest;
        writeError = failure(error, Boolean(recovery.temporary || record.temporary));
        if (latest !== recovery) {
          try { await prepare(latest); await discard(recovery); }
          catch { /* Keep the prior complete recovery copy if the new write fails. */ }
        }
        throw writeError;
      }
    }
    writeError = null;
  }
  function startWriter() {
    if (!writer) {
      writer = persistPending().finally(() => { writer = null; });
      writer.catch(() => {}); // Failure is surfaced by flush / the next save.
    }
    return writer;
  }
  async function flush() {
    // An explicit flush also permits retry after the user fixes a persistent lock.
    if (pending && !writer) { writeError = null; startWriter(); }
    while (writer) await writer;
    if (writeError) throw writeError;
  }
  const saveState = next => {
    if (writeError&&policy.enabled) throw writeError;
    const sanitized = sanitizeState(next);
    sanitized.revision = (state?.revision || 0) + 1;
    if(!policy.enabled||policy.intervalSeconds>0){state=sanitized;schedule();return structuredClone(state);}
    if (writer || pending) {
      const superseded = pending;
      state = sanitized; pending = { state };
      void discard(superseded);
      startWriter();
      return structuredClone(state);
    }
    const temporary = temporaryName();
    let written = false;
    try {
      io.writeFileSync(temporary, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600 });
      written = true;
      io.renameSync(temporary, filename);savedRevision=sanitized.revision;lastSavedAt=new Date().toISOString();
    } catch (error) {
      if (transient(error) && written) {
        state = sanitized; pending = { state, temporary }; startWriter();
        return structuredClone(state);
      }
      try { io.unlinkSync(temporary); } catch { /* No temporary file remains after rename. */ }
      throw failure(error);
    }
    state = sanitized;
    return structuredClone(state);
  };
  function schedule(){if(closed||!policy.enabled||!policy.intervalSeconds||autoTimer)return;autoTimer=setTimeout(()=>{autoTimer=undefined;void persist({automatic:true}).catch(()=>{});},policy.intervalSeconds*1000);autoTimer.unref?.();}
  async function persist({automatic=false}={}){clearTimeout(autoTimer);autoTimer=undefined;await flush();if(automatic&&!policy.enabled)return autosaveStatus();if(savedRevision!==state.revision){pending={state:structuredClone(state)};writeError=null;startWriter();await flush();}return autosaveStatus();}
  const autosaveStatus=()=>({...policy,dirty:savedRevision!==state.revision,lastSavedAt,file:filename,error:writeError?.code||''});
  async function setAutosave(value){const next=validateAutosave({...policy,...value}),previous=policy;clearTimeout(autoTimer);autoTimer=undefined;policy=next;try{await flush();const temporary=policyFile+'.'+crypto.randomUUID()+'.tmp';try{io.writeFileSync(temporary,JSON.stringify(next,null,2),{mode:0o600});io.renameSync(temporary,policyFile);}catch(e){try{io.unlinkSync(temporary);}catch{}throw failure(e);}}catch(error){policy=previous;schedule();throw error;}if(policy.enabled){if(policy.intervalSeconds)schedule();else await persist({automatic:true});}return autosaveStatus();}
  async function autoCheckpoint(reason){if(policy.enabled&&((reason==='task'&&policy.onTaskComplete)||(reason==='close'&&policy.onClose)))await persist({automatic:true});else await flush();}
  async function close(){closed=true;clearTimeout(autoTimer);autoTimer=undefined;await autoCheckpoint('close');}
  if (!io.existsSync(filename)&&policy.enabled) saveState(state);
  return { dataDir, getState: () => structuredClone(state), saveState, flush,persist,autosaveStatus,setAutosave,autoCheckpoint,close };
}

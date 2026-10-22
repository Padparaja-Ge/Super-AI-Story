import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { fanficDefaults, fanficEpisodeOrder, fanficEpisodeLabel } from '../shared/fanfic.mjs';
import { getConnection, streamCompletion, countCompletionTokens } from './llm.mjs';
import { structuredCompletion, parseObject } from './services/structuredCompletion.js';
import { messageTokens } from './prompt.mjs';
import {selectFanficLore,fanficCast,resolveFanficContext,packReference} from './fanfic-context.mjs';
import {measureFanficWordBudget,fanficSceneWordLimit} from './fanfic-word-budget.mjs';
import {createTextContinuationJoiner} from './text-continuation.mjs';
import {finishFanficScene} from './fanfic-scene-ending.mjs';
import {cleanFanficProse,fanficStops} from './fanfic-prose.mjs';
import {fanficFactSchema,fanficFactInstructions} from '../shared/fanfic-canon.mjs';
import {validateCanonExtraction,validateCanonManualFacts,eligibleCanonFacts,canonFactReference,fanficEvidenceBlocks} from './fanfic-canon.mjs';
import {normalizeFanficProfiles,resolveFanficStageProfile} from '../shared/fanfic-profiles.mjs';
import {reviewFanficProse} from './fanfic-review.mjs';
import {calibrateFanficModel} from './fanfic-calibration.mjs';
import {normalizeFanficFramePassport} from './fanfic-images.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const has = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const text = (value, limit = 8000) => typeof value === 'string' ? value.slice(0, limit) : '';
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const join = (a, b) => a && b ? a.replace(/\s+$/, '') + '\n\n' + b.replace(/^\s+/, '') : a || b || '';
export const contentHash = content => createHash('sha256').update(String(content || '')).digest('hex');
const stringShape = { type: 'string' };
const objectShape = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const stringsShape = { type: 'array', items: stringShape, maxItems:20 };
const evidenceIndex={type:'integer',minimum:0};
const evidenceIndices={type:'array',items:evidenceIndex,maxItems:20};
export const fanficOutlineSchema = objectShape({ scenes: { type: 'array', items: objectShape({ title: stringShape, summary: stringShape }) } });
export const fanficMemorySchema = objectShape({ summary: stringShape, location: stringShape, relationships: stringsShape, openThreads: stringsShape,
  summaryEvidence:{...evidenceIndices,minItems:1,maxItems:8},locationEvidence:evidenceIndex,relationshipEvidence:evidenceIndices,openThreadEvidence:evidenceIndices, facts:fanficFactSchema });

function settingsOf(value = {}) {
  const settings = { ...fanficDefaults };
  for (const key of ['connectionId', 'style', 'perspective', 'tense', 'genre', 'audience', 'instructions']) settings[key] = text(value[key] ?? settings[key], key === 'instructions' ? 4000 : key === 'style' ? 2000 : 300);
  settings.sceneCount = Math.round(bounded(value.sceneCount, 3, 1, 8));
  settings.maxTokens = Math.round(bounded(value.maxTokens, 1200, 256, 4096));
  settings.temperature = bounded(value.temperature, 0.8, 0, 1.5);
  settings.vectorMemory = value.vectorMemory === true;
  settings.memoryTopK = Math.round(bounded(value.memoryTopK, 8, 1, 30));
  settings.memoryThreshold = bounded(value.memoryThreshold, .3, 0, 1);
  settings.memoryRecentEpisodes = Math.round(bounded(value.memoryRecentEpisodes, 2, 1, 10));
  settings.generationProfiles = normalizeFanficProfiles(value.generationProfiles);
  settings.continuityCheck = value.continuityCheck !== false;
  return settings;
}

function snapshotCard(card = {}) {
  const result = { id: text(card.id, 100) || randomUUID(), sourceId: text(card.sourceId || card.id, 100) };
  for (const key of ['name', 'subtitle', 'description', 'personality', 'appearance', 'scenario', 'firstMessage', 'exampleDialogue', 'systemPrompt', 'postHistoryInstructions', 'avatar', 'color']) result[key] = text(card[key], key === 'avatar' ? 500000 : 8000);
  result.blocks = (Array.isArray(card.blocks) ? card.blocks : []).slice(0, 30).filter(b => b && b.enabled !== false).map(b => ({ name: text(b.name, 120), content: text(b.content), enabled: true }));
  return result;
}

function snapshotLore(book = {}) {
  return { id: text(book.id, 100) || randomUUID(), sourceId: text(book.sourceId || book.id, 100), name: text(book.name, 200), description: text(book.description),
    entries: (Array.isArray(book.entries) ? book.entries : []).slice(0, 300).filter(e => e && typeof e === 'object').map(e => ({ id: text(e.id, 100) || randomUUID(), name: text(e.name, 200), content: text(e.content), keys: (Array.isArray(e.keys) ? e.keys : []).slice(0, 30).map(k => text(k, 120)), secondaryKeys: (Array.isArray(e.secondaryKeys) ? e.secondaryKeys : []).slice(0,30).map(k=>text(k,120)), selective:e.selective===true, caseSensitive:e.caseSensitive===true, enabled: e.enabled !== false, constant: e.constant === true, vectorized: e.vectorized === true, priority: bounded(e.priority, 0, -100, 100) })) };
}

function selectedSnapshots(input, field, state, importing) {
  const key = field === 'characters' ? 'characterIds' : field === 'personas' ? 'personaIds' : 'lorebookIds';
  const mapper = field === 'lorebooks' ? snapshotLore : snapshotCard;
  if (importing) return (Array.isArray(input[field]) ? input[field] : []).slice(0, 20).filter(v => v && typeof v === 'object').map(mapper);
  const ids = input[key] || [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw fail('Выберите не более 20 карточек или лорбуков.');
  return [...new Set(ids)].map(id => {
    const item = (state[field] || []).find(item => item.id === id);
    if (!item) throw fail('Выбранная карточка или лорбук больше не существует. Обновите список.');
    return mapper(item);
  });
}

function updateSnapshots(input, field, state, existing) {
  const key = field === 'characters' ? 'characterIds' : field === 'personas' ? 'personaIds' : 'lorebookIds';
  const ids = input[key];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw fail('Выберите не более 20 карточек или лорбуков.');
  return [...new Set(ids)].map(id => {
    const saved = existing.find(item => (item.sourceId || item.id) === id || item.id === id);
    if (saved && input.refreshSnapshots !== true) return saved;
    return selectedSnapshots({ [key]: [id] }, field, state, false)[0];
  });
}

function newEpisode(input = {}) {
  if (has(input, 'content') && (typeof input.content !== 'string' || input.content.length > 2000000)) throw fail('Текст эпизода должен быть короче 2 миллионов символов.');
  return { id: randomUUID(), season: Math.round(bounded(input.season, 1, 1, 999)), number: Math.round(bounded(input.number, 1, 1, 9999)),
    title: text(input.title, 200), brief: text(input.brief, 16000), content: text(input.content, 2000000), status: 'draft', revision: 1,
    outline: [], sceneIndex: 0, versions: [], editorMessages: [], memory: null, needsReview: false, generation: null, editProposal:null, continuityReview:null, framePassport:null, createdAt: now() };
}

export function normalizeFanficProject(input, state = {}, { importing = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Нужен объект проекта.');
  const project = { id: randomUUID(), title: text(input.title, 200).trim() || 'Новый фанфик', world: text(input.world, 12000), canon: text(input.canon, 12000), divergence: text(input.divergence, 8000),
    characters: selectedSnapshots(input, 'characters', state, importing), personas: selectedSnapshots(input, 'personas', state, importing), lorebooks: selectedSnapshots(input, 'lorebooks', state, importing),
    settings: settingsOf(input.settings), episodes: [], createdAt: now(), updatedAt: now() };
  if (importing) {
    project.settings.connectionId = '';
    if (input.episodes !== undefined && (!Array.isArray(input.episodes) || input.episodes.length > 500)) throw fail('В проекте должно быть не более 500 эпизодов.');
    project.episodes = (input.episodes || []).map(item => {
      if (!item || typeof item !== 'object') throw fail('Неверный формат эпизода.');
      // Imported prose is editable, but no imported summary receives canonical trust.
      const episode = newEpisode(item);
      episode.outline = (Array.isArray(item.outline) ? item.outline : []).slice(0, 8).map(s => ({ title: text(s?.title, 200), summary: text(s?.summary, 1200) }));
      episode.editorMessages = (Array.isArray(item.editorMessages) ? item.editorMessages : []).slice(-80).filter(m => ['user', 'assistant'].includes(m?.role)).map(m => ({ role: m.role, content: text(m.content, 16000) }));
      episode.versions = (Array.isArray(item.versions) ? item.versions : []).slice(-20).filter(v => typeof v?.content === 'string').map(v => ({ id: randomUUID(), content: text(v.content, 2000000), label: text(v.label, 120), createdAt: text(v.createdAt, 40) || now() }));
      return episode;
    });
    for(let i=0;i<project.episodes.length;i++){
      const episode=project.episodes[i];ensureEpisodeNumber(project,episode,episode.id);
      if(input.episodes[i]?.framePassport){try{episode.framePassport=normalizeFanficFramePassport(input.episodes[i].framePassport,{project,episode,rebind:true});}catch{episode.framePassport=null;}}
    }
  }
  return project;
}

export function approvedMemories(project, beforeEpisode) {
  let blocked=false;
  return [...(project.episodes || [])].sort(fanficEpisodeOrder).filter(e => {
    if(beforeEpisode&&fanficEpisodeOrder(e,beforeEpisode)>=0)return false;
    if(e.status!=='approved')return false;
    if(e.needsReview||e.memory?.sourceHash!==contentHash(e.content)||!String(e.memory?.summary||'').trim()){blocked=true;return false;}
    return !blocked;
  }).flatMap(e => {
      const parts = e.memory.chunks?.length ? e.memory.chunks : [e.memory];
      return parts.map((part, index) => ({ id: e.id + ':' + index, episodeId: e.id, title: fanficEpisodeLabel(e), summary: text(part.summary, 16000),
        location: text(part.location, 1000), relationships: (Array.isArray(part.relationships)?part.relationships:[]).filter(v=>typeof v==='string').slice(0, 20), openThreads: (Array.isArray(part.openThreads)?part.openThreads:[]).filter(v=>typeof v==='string').slice(0, 20),
        sourceEvidence:(Array.isArray(part.evidence?.summary)?part.evidence.summary:[]).filter(v=>typeof v==='string').slice(0,8).map(v=>text(v,700)) }));
    });
}

function invalidateDependentEpisode(episode){
  if(!episode.content&&!episode.generation)return;
  episode.needsReview=true;episode.contextReport=null;episode.continuityReview=null;episode.editProposal=null;
  if(episode.generation){
    episode.generation=null;episode.status='draft';episode.error='';episode.stage='Канон предыдущих серий изменён. Создайте новый план.';
    episode.revision=(episode.revision||0)+1;episode.updatedAt=now();
  }
}

function invalidateEpisode(project, episode) {
  const affected = episode.status === 'approved' || !!episode.memory;
  episode.memory = null; episode.editProposal=null;episode.continuityReview=null;episode.status = 'draft'; episode.needsReview = false; episode.generation = null; episode.error = '';
  if (affected) for (const later of project.episodes) if (fanficEpisodeOrder(later, episode) > 0) invalidateDependentEpisode(later);
  episode.contextReport = null;
}

function ensureEpisodeNumber(project,episode,exceptId){
  if(project.episodes.some(e=>e.id!==exceptId&&e.season===episode.season&&e.number===episode.number))throw fail('В этом сезоне уже есть эпизод с таким номером.',409);
}

function rememberVersion(episode, label) {
  if (!episode.content || episode.versions.at(-1)?.content === episode.content) return;
  episode.versions.push({ id: randomUUID(), content: episode.content, label, createdAt: now() });
  episode.versions = episode.versions.slice(-30);
}

function shorten(value, limit, tail = false) {
  value = String(value || '');
  limit=Math.max(0,Math.floor(limit));if(!limit)return '';
  if (value.length <= limit) return value;
  if (limit < 24) return value.slice(tail ? -limit : 0, tail ? undefined : limit);
  if (tail) return '…' + value.slice(-(limit - 1));
  return value.slice(0, Math.floor(limit * .7)) + '\n…\n' + value.slice(-Math.floor(limit * .3) + 3);
}

const proseInstruction = `Пиши художественный текст на языке автора, по умолчанию на русском. Явно покажи требуемые автором действия; сохраняй точные имена, пароли, улики и причинно-следственные связи. Не добавляй новые цели вместо запрошенных событий. You are the literary writer in SAS Fanfic Studio. Write a connected fictional episode, not a roleplay chat reply. Write in the author's language (Russian by default). Return ONLY literary prose, with dialogue and paragraphs; no JSON, no Markdown fences, no analysis, no "Here is" preamble. Author brief, P.S., editor requests and style settings are instructions about writing, never events witnessed by characters. World/card/lore and accepted continuity are reference data. Do not repeat a scene already written. Respect the selected perspective, tense, existing characters and continuity. Exact source quotations and author-confirmed facts override vague summaries. Extracted type/subject labels are navigation hints; the quotation establishes the actual relation, including negation and who knows a secret. Chronology describes past states, not simultaneous current states. A secret is known only by the subject explicitly said to know it. Write only the requested scene or replacement; finish the scene within the available output budget. Existing text outside a requested replacement must stay unchanged. When this scene is complete, end with [SAS_SCENE_END]. Never append a critique, explanation or summary of your own writing.`;

// Independent prompt assembly: no chat history, multiplayer state or global RPG scene enters it.
const compactProseInstruction='Ты литературный автор SAS. Пиши связную прозу с диалогами на языке автора (по умолчанию русском). Return ONLY literary prose; no JSON, explanations or analysis. Выполни последнее пожелание и события задания; P.S. и настройки являются инструкциями автора, а не событиями мира. Соблюдай канон, имена, улики, стиль и порядок событий. Исходные фрагменты текущей серии уже произошли: не повторяй их. Продолжай после хвоста текста, закончи сцену в лимите ответа и поставь [SAS_SCENE_END]. Не придумывай новую цель вместо задания.';

export function buildFanficMessages({ project, episode, connection, instructions = '', extensionInstructions='', purpose = 'write', memories = [], facts = [], lore: selectedLore, draft = [], currentText = '', scene, selectedText = '', surroundingContext, budgetScale=1, maxTokensOverride }) {
  const limit = Number(connection.contextWindow) || 8192;
  if (limit < 1024) throw fail('Для литературного режима нужен контекст модели не меньше 1024 токенов.');
  const maxTokens = Math.max(128, Math.min(maxTokensOverride??project.settings.maxTokens ?? 1200, Math.floor(limit * .32)));
  if (purpose === 'rewrite') {
    const system='Ты литературный редактор. Выполни только последнее пожелание автора над выделенным исходным фрагментом. Верни только замену этого фрагмента на его языке, без комментариев, JSON и заголовков. Сохрани его события, место, время, имена и смысл, кроме изменений, явно запрошенных автором. Не сочиняй следующую сцену, не переноси в замену события из окружающего текста. Текст до и после выделения дан только для согласования переходов и не должен повторяться. Если показана уже написанная часть замены, допиши её с места остановки, не повторяя начало.';
    const data={request:shorten(instructions,2500),source:selectedText,before:shorten(surroundingContext?.before||'',650,true),after:shorten(surroundingContext?.after||'',650),replacementSoFar:shorten(currentText,1400,true),style:shorten(project.settings.style||'',350),reference:JSON.parse(packReference({cast:fanficCast(project),lore:selectedLore||selectFanficLore(project,selectedText+' '+instructions),continuity:memories.slice(-2),facts:facts.map(canonFactReference)},1500).text)};
    const messages=[{role:'system',content:system+(extensionInstructions?'\n'+extensionInstructions:'')},{role:'user',content:JSON.stringify(data)}];
    for(const key of ['reference','before','after','style','replacementSoFar']) {
      if(messageTokens(messages)+maxTokens+100<=limit)break;
      if(key==='reference')data.reference={};else data[key]=shorten(data[key],key==='replacementSoFar'?250:80,true);messages[1].content=JSON.stringify(data);
    }
    if(messageTokens(messages)+maxTokens+100>limit)throw fail('Выделенный фрагмент и пожелание не помещаются в контекст. Сократите пожелание или выделите меньший фрагмент.');
    return {messages,maxTokens,included:{memory:(data.reference.continuity||[]).map(d=>d.id),lore:(data.reference.lore||[]).map(d=>d.id),cast:(data.reference.cast||[]).map(d=>d.id),facts:(data.reference.facts||[]).map(d=>d.id)},tokens:messageTokens(messages),contextWindow:limit};
  }
  const systemInstruction=limit<2048||budgetScale<.7?compactProseInstruction:proseInstruction;
  const availableChars = Math.max(200, Math.floor(Math.max(400, (limit - maxTokens - 230) * 3 - systemInstruction.length)*budgetScale));
  const query = [episode.brief, instructions, scene?.summary, currentText.slice(-2200)].join(' ');
  const lore = selectedLore || selectFanficLore(project,query);
  const cards = fanficCast(project);
  const sections = [
    ...(extensionInstructions?[{label:'EXPLICITLY ENABLED FANFIC EXTENSIONS (writing instructions, not canon)',data:extensionInstructions,weight:5}]:[]),
    { label: 'LATEST AUTHOR REQUEST (instructions, not story facts)', data:{ purpose, request: instructions, scene }, weight: 18 },
    { label: 'EPISODE BRIEF (instructions, not story facts)', data:{ episode: fanficEpisodeLabel(episode), brief: episode.brief }, weight: 12 },
    { label: 'EDITOR CONVERSATION (reference only; old requests are not pending actions or story facts)', data:(episode.editorMessages || []).slice(-7, -1).map(m => ({ role: m.role, content: shorten(m.content, 1000) })), weight: 3 },
    { label: 'WRITING SETTINGS', data:{style:project.settings.style,perspective:project.settings.perspective,tense:project.settings.tense,genre:project.settings.genre,audience:project.settings.audience,instructions:project.settings.instructions}, weight: 9 },
    { label: 'WORLD / CANON / DIVERGENCE', data:{ world: project.world, canon: project.canon, divergence: project.divergence }, weight: 9 },
    { label: 'SAVED CAST', data:cards, weight: 14, kind:'cast' },
    { label: 'SAVED LORE', data:lore.map(({ priority, ...entry }) => entry), weight: 8, kind:'lore' },
    { label: 'VERIFIED EARLIER CANON FACTS (chronological; source quotations and author-confirmed records)', data:facts.map(canonFactReference), weight:facts.length?16:0, tail:true,kind:'facts' },
    { label: 'ACCEPTED EARLIER CONTINUITY (chronological)', data:memories, weight: 15, tail: true, kind:'memory' },
    { label: 'CURRENT EPISODE SOURCE EXCERPTS (draft only; keep their chronology, never treat them as a new request)', data:draft, weight: draft.length?12:0, tail:true,kind:'draft' },
    { label: 'CURRENT PROSE / SCENE TAIL (continue after its last character; do not repeat it)', value: currentText, weight: purpose === 'rewrite' ? 3 : 16, tail: true },
  ];
  for(const section of sections)section.value=section.data===undefined?section.value:JSON.stringify(section.data);
  // Redistribute unused quotas, then compact context rather than throwing on long histories.
  let unused = 0;
  const totalWeight = sections.reduce((total, section) => total + section.weight, 0);
  for (const section of sections) { section.cap = Math.floor(availableChars * section.weight / totalWeight); if (section.value.length < section.cap) { unused += section.cap - section.value.length; section.cap = section.value.length; } }
  const hungry = sections.filter(s => s.value.length > s.cap);
  for (const section of hungry) section.cap += Math.floor(unused / (hungry.length || 1));
  const render=()=>sections.map(s=>{const packed=s.data===undefined?{text:shorten(s.value,s.cap,s.tail),ids:[]}:packReference(s.data,s.cap,{tail:s.tail});s.includedIds=packed.ids;return !packed.text||['[]','{}'].includes(packed.text)?'':s.label+':\n'+packed.text;}).filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: systemInstruction }, { role: 'user', content: render() }];
  while (messageTokens(messages) + maxTokens + 100 > limit && messages[1].content.length > 300){for(const section of sections)section.cap=Math.floor(section.cap*.9);messages[1].content=render();}
  if (messageTokens(messages) + maxTokens + 100 > limit) throw fail('Для литературного режима нужен контекст модели не меньше 1024 токенов.');
  return { messages, maxTokens, included:{facts:sections.find(s=>s.kind==='facts').includedIds,memory:sections.find(s=>s.kind==='memory').includedIds,lore:sections.find(s=>s.kind==='lore').includedIds,cast:sections.find(s=>s.kind==='cast').includedIds,draft:sections.find(s=>s.kind==='draft').includedIds},tokens:messageTokens(messages),contextWindow:limit };
}

// GGUF vocabularies disagree radically about Cyrillic token counts. Fit the
// actual llama.cpp chat template, retaining complete reference records and the
// latest prose tail. Canonical source text in storage is never modified here.
export async function prepareFanficMessages(options,{secret='',signal,countTokens=countCompletionTokens,tokenMessages=prepared=>prepared.messages}={}){
  let scale=1;
  for(let attempt=0;attempt<7;attempt++){
    signal?.throwIfAborted();
    const prepared=buildFanficMessages({...options,budgetScale:scale}),messages=tokenMessages(prepared);
    const actual=options.connection.id==='sas-local'?await countTokens(options.connection,secret,messages,{signal,adaptInstruction:true,disableThinking:true}):null;
    const measured=Number.isInteger(actual)&&actual>0?actual:messageTokens(messages)*(options.connection.id==='sas-local'?1.6:1);
    if(measured+prepared.maxTokens+260<=prepared.contextWindow)return {...prepared,actualTokens:Number.isInteger(actual)?actual:null,tokenizer:actual!==null?'model':'estimate'};
    scale*=Math.max(.2,Math.min(.82,(prepared.contextWindow-prepared.maxTokens-260)/Math.max(1,measured)*.92));
  }
  throw fail('Пожелание и необходимые материалы не помещаются в контекст этой модели. Сократите пожелание или увеличьте контекст; исходный текст сохранён.');
}

function validateOutline(raw, count) {
  const value = typeof raw === 'string' ? parseObject(raw) : raw;
  if (!Array.isArray(value?.scenes) || !value.scenes.length || value.scenes.length > 8 || value.scenes.some(s => typeof s?.title !== 'string' || typeof s?.summary !== 'string' || !s.summary.trim())) throw new Error('Нужен список scenes с title и summary.');
  return { scenes: value.scenes.slice(0, count).map(s => ({ title: text(s.title, 200), summary: text(s.summary, 1600) })) };
}

export function validateMemory(raw,prose,factContext) {
  const value = typeof raw === 'string' ? parseObject(raw) : raw;
  if (typeof value?.summary !== 'string' || !value.summary.trim() || typeof value.location !== 'string' || !Array.isArray(value.relationships) || !Array.isArray(value.openThreads) || [...value.relationships, ...value.openThreads].some(v => typeof v !== 'string')) throw new Error('Нужны summary, location, relationships и openThreads.');
  const memory={ summary: text(value.summary, 6000), location: text(value.location, 1000), relationships: value.relationships.slice(0, 20).map(v => text(v, 800)), openThreads: value.openThreads.slice(0, 20).map(v => text(v, 800)) };
  if(prose!==undefined){
    const blocks=evidenceBlocks(prose),supported=index=>Number.isInteger(index)&&index>0&&index<=blocks.length;
    const quote=index=>blocks[index-1].text.trim();
    if(!Array.isArray(value.summaryEvidence)||!value.summaryEvidence.length||value.summaryEvidence.length>8||value.summaryEvidence.some(index=>!supported(index)))throw new Error('summaryEvidence должна содержать от 1 до 8 номеров существующих предложений из prose. Выбери самые важные подтверждения, не перечисляй все предложения.');
    if(!supported(value.locationEvidence))memory.location='';
    const relationships=memory.relationships.map((fact,i)=>({fact,index:value.relationshipEvidence?.[i]})).filter(d=>supported(d.index));
    const openThreads=memory.openThreads.map((fact,i)=>({fact,index:value.openThreadEvidence?.[i]})).filter(d=>supported(d.index));
    memory.relationships=relationships.map(d=>d.fact);memory.openThreads=openThreads.map(d=>d.fact);
    memory.evidence={summary:value.summaryEvidence.map(quote),location:memory.location?quote(value.locationEvidence):'',relationships:relationships.map(d=>quote(d.index)),openThreads:openThreads.map(d=>quote(d.index))};
  }
  else if(value.evidence)memory.evidence=value.evidence;
  if(prose!==undefined&&factContext){const result=validateCanonExtraction(value.facts,{...factContext,prose});memory.facts=result.facts;memory.rejectedFacts=result.rejected;}
  else if(Array.isArray(value.facts))memory.facts=value.facts;
  if(Array.isArray(value.rejectedFacts))memory.rejectedFacts=value.rejectedFacts;
  return memory;
}

function evidenceBlocks(prose){
  return fanficEvidenceBlocks(prose).map(({id,text})=>({id,text}));
}

function breakProse(value, size) {
  const result = [];
  while (value.length > size) {
    let end = value.lastIndexOf('\n\n', size);
    if (end < size * .5) end = Math.max(value.lastIndexOf('. ', size), value.lastIndexOf('! ', size), value.lastIndexOf('? ', size)) + 1;
    if (end < size * .5) {const space=Math.max(value.lastIndexOf(' ',size),value.lastIndexOf('\n',size),value.lastIndexOf('\t',size));end=space>=size*.5?space+1:size;}
    result.push(value.slice(0, end)); value = value.slice(end);
  }
  if (value) result.push(value);
  return result;
}

export const fanficMemoryInstructions='Summarize ONLY facts explicitly present in the numbered prose sentences. Return ONLY JSON with nine fields: summary (compact chronological events, at most 100 words), location (string), relationships and openThreads (brief string arrays, prefer 0–4 items), summaryEvidence (1–8 key supporting sentence IDs, never every sentence), locationEvidence (supporting ID or 0), relationshipEvidence and openThreadEvidence (one supporting ID per array item). Preserve exact names, passwords, clues, promises and outcomes. No invented goals or inferred quests. Empty location and arrays are valid. Default language: Russian. IDs must exist in this excerpt.'+' '+fanficFactInstructions;

// JSON sentence IDs add overhead of their own; prose length alone is not a
// sufficient budget check, especially for local models with short contexts.
export function splitFanficMemory(prose,episode,contextWindow,maxTokens){
  const limit=Number(contextWindow)||8192,reserve=260;
  const context=part=>({episode:fanficEpisodeLabel(episode),part:5000,totalParts:5000,prose:evidenceBlocks(part)});
  const fits=part=>messageTokens([{role:'system',content:fanficMemoryInstructions},{role:'user',content:JSON.stringify(context(part))}])+maxTokens+reserve<=limit;
  const initial=breakProse(prose,Math.max(150,Math.floor((limit-maxTokens-550)*2.2))),result=[];
  const split=part=>{
    if(fits(part)){result.push(part);return;}
    if(part.length<2)throw fail('Контекст модели слишком мал для создания памяти. Увеличьте его до 1024 токенов или больше.');
    const halves=breakProse(part,Math.max(1,Math.floor(part.length/2)));
    for(const half of halves)split(half);
  };
  for(const part of initial)split(part);
  return result;
}

export async function splitFanficMemoryForModel(prose,episode,connection,maxTokens,{secret='',signal,countTokens=countCompletionTokens}={}){
  const initial=splitFanficMemory(prose,episode,connection.contextWindow,maxTokens);
  if(connection.id!=='sas-local')return initial;
  const result=[],limit=Number(connection.contextWindow)||8192;
  const split=async part=>{
    signal?.throwIfAborted();
    const messages=[{role:'system',content:fanficMemoryInstructions},{role:'user',content:JSON.stringify({episode:fanficEpisodeLabel(episode),part:5000,totalParts:5000,prose:evidenceBlocks(part)})}];
    const actual=await countTokens(connection,secret,messages,{signal,adaptInstruction:true,disableThinking:true});
    if((actual??messageTokens(messages)*1.6)+maxTokens+260<=limit){result.push(part);return;}
    if(part.length<2)throw fail('Пожелание и формат памяти не помещаются в контекст модели. Увеличьте контекст.');
    for(const half of breakProse(part,Math.max(1,Math.floor(part.length/2))))await split(half);
  };
  for(const part of initial)await split(part);
  return result;
}

function replacementAtSourceBoundary(source,replacement){
  const leading=source.match(/^\s*/u)?.[0]||'',trailing=source.match(/\s*$/u)?.[0]||'';
  return leading+replacement.trim()+trailing;
}

function compose(generation) {
  const output = generation.action==='rewrite'?(generation.completedText||'')+(generation.partial||''):join(generation.completedText,generation.partial);
  // Planning or a failed first token must not replace the previous draft with an empty page.
  if (!output) return generation.baseContent || '';
  if (generation.action === 'continue') return join(generation.baseContent, output);
  if (generation.action === 'rewrite') return generation.baseContent.slice(0, generation.selectionStart) + output + generation.baseContent.slice(generation.selectionEnd);
  return output;
}

export function createFanfic({ getState, saveState, getSecret, tasks, embeddings, extensions, structured = structuredCompletion, stream = streamCompletion, countTokens=countCompletionTokens }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (['POST', 'PATCH'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'Ожидается JSON-объект.' });
    next();
  });
  function read(projectId, episodeId) {
    const project = (getState().fanficProjects || []).find(p => p.id === projectId);
    if (!project) throw fail('Произведение не найдено.', 404);
    const episode = episodeId ? project.episodes.find(e => e.id === episodeId) : undefined;
    if (episodeId && !episode) throw fail('Эпизод не найден.', 404);
    return { project, episode };
  }
  function patch(projectId, episodeId, fn) {
    const state = getState(), project = (state.fanficProjects || []).find(p => p.id === projectId);
    if (!project) throw fail('Произведение удалено.', 404);
    const episode = episodeId ? project.episodes.find(e => e.id === episodeId) : undefined;
    if (episodeId && !episode) throw fail('Эпизод удалён.', 404);
    fn(project, episode); project.updatedAt = now();
    if (episode) { episode.revision = (episode.revision || 0) + 1; episode.updatedAt = now();
      for(const key of ['editProposal','continuityReview'])if(episode[key]?.sourceHash===contentHash(episode.content))episode[key].sourceRevision=episode.revision;
    }
    saveState(state);
    return episode || project;
  }
  function revision(episode, expected) {
    if (expected !== undefined && (!Number.isInteger(expected) || expected !== episode.revision)) throw fail('Эпизод уже изменился. Обновите страницу и повторите правку.', 409);
  }
  function addEditor(episode, role, content) {
    episode.editorMessages.push({ role, content: text(content, 16000) }); episode.editorMessages = episode.editorMessages.slice(-100);
  }
  async function contextFor(state,project,episode,signal,job,options={}){
    const context=await resolveFanficContext({state,project,episode,embeddings,signal,memories:approvedMemories(project,episode),...options});
    if(extensions)context.extensionInstructions=await extensions.prompt('fanfic',{projectId:project.id,episodeId:episode.id,request:options.instructions||''});
    for(const warning of context.report.warnings)if(job&&!job.warnings.includes(warning))job.warnings.push(warning);
    return context;
  }
  function reportFor(context,prepared){
    const included=prepared.included;
    return {...context.report,estimatedTokens:prepared.tokens,actualTokens:prepared.actualTokens??null,tokenizer:prepared.tokenizer||'estimate',contextWindow:prepared.contextWindow,maxTokens:prepared.maxTokens,
      ...(included?{selectedMemory:context.report.selectedMemory.map(d=>({...d,included:included.memory.includes(d.id)})),selectedLore:context.report.selectedLore.map(d=>({...d,included:included.lore.includes(d.id)})),selectedFacts:(context.report.selectedFacts||[]).map(d=>({...d,included:(included.facts||[]).includes(d.id)})),selectedDraft:(context.report.selectedDraft||[]).map(d=>({...d,included:(included.draft||[]).includes(d.id)})),includedCast:included.cast}:{}),createdAt:now()};
  }

  function generate(projectId, episodeId, input = {}) {
    tasks.assertIdle();
    let { project, episode } = read(projectId, episodeId);
    revision(episode, input.expectedRevision);
    const action = input.action || 'write';
    if (!['write', 'continue', 'rewrite', 'alternative', 'resume', 'approve', 'review'].includes(action)) throw fail('Неизвестное действие редактора.');
    if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 16000)) throw fail('Указания редактору должны быть текстом до 16000 символов.');
    const instructions = text(input.instructions, 16000).trim();
    if(input.preview!==undefined&&typeof input.preview!=='boolean')throw fail('Режим просмотра правки должен быть переключателем.');
    if (action === 'resume' && !episode.generation) throw fail('Нет незавершённой генерации.');
    if (['approve','review'].includes(action) && !episode.content.trim()) throw fail('Сначала напишите эпизод.');
    if (['continue', 'alternative', 'rewrite'].includes(action) && !episode.content.trim()) throw fail('Сначала напишите эпизод.');
    if (['write', 'alternative'].includes(action) && !episode.brief.trim() && !instructions) throw fail('Опишите события эпизода в задании автору.');
    if (action === 'rewrite') {
      if (!instructions) throw fail('Опишите, как изменить выделенный фрагмент.');
      if (!Number.isInteger(input.selectionStart) || !Number.isInteger(input.selectionEnd) || input.selectionStart < 0 || input.selectionEnd <= input.selectionStart || input.selectionEnd > episode.content.length) throw fail('Выделите фрагмент для изменения.');
    }
    const state = getState(), connection = getConnection(state, { connectionId: project.settings.connectionId });
    if (!connection.model) throw fail('Выберите и запустите модель в настройках подключения.');
    if (action !== 'resume') {
      episode = patch(projectId, episodeId, (p, e) => {
        const previousStatus=e.status,previousNeedsReview=e.needsReview,previousError=e.error||'',previousStage=e.stage||'';
        const pending=e.generation,readOnly=action==='review'||action==='rewrite'&&input.preview===true;
        const previousGeneration=readOnly&&pending?structuredClone(pending.action==='review'||pending.preview?pending.previousGeneration||null:pending):null;
        if (action !== 'approve'&&action!=='review'&&!(action==='rewrite'&&input.preview===true)) { rememberVersion(e, action === 'rewrite' ? 'До правки фрагмента' : action === 'continue' ? 'До продолжения' : 'Предыдущий вариант'); invalidateEpisode(p, e); }
        e.status = 'running'; e.error = ''; e.stage = action === 'approve' ? 'Создание памяти' : 'Планирование';
        e.generation = { action, instructions, preview:action==='rewrite'&&input.preview===true,previousStatus,previousNeedsReview,previousError,previousStage,previousGeneration,sourceHash:contentHash(e.content),baseContent: e.content, completedText: '', partial: '', sceneIndex: 0, outline: null,
          selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, memoryParts: [], memoryIndex: 0 };
        if (action === 'continue' || action === 'rewrite') e.generation.outline = [{ title: action === 'rewrite' ? 'Правка фрагмента' : 'Продолжение', summary: instructions || 'Продолжи события эпизода естественно, после последнего написанного предложения.' }];
        if(action==='rewrite'){
          const chunkSize=Math.max(350,Math.min(project.settings.maxTokens,Math.floor((Number(connection.contextWindow)||8192)*.32))*1.5);
          e.generation.editParts=breakProse(e.content.slice(input.selectionStart,input.selectionEnd),Math.floor(chunkSize));
          e.generation.outline=e.generation.editParts.map((_,index)=>({title:`Правка фрагмента ${index+1}`,summary:instructions}));
        }
        if (action !== 'approve'&&action!=='review'&&!(action==='rewrite'&&input.preview===true)) { e.outline = e.generation.outline || []; e.sceneIndex = 0; }
        addEditor(e, 'user', instructions || (action === 'approve' ? 'Утвердить эпизод и сохранить память.' : action === 'write' ? e.brief : action === 'alternative' ? 'Написать другой вариант эпизода.' : 'Продолжить эпизод.'));
      });
    } else episode = patch(projectId, episodeId, (p, e) => { e.status = 'running'; e.error = ''; });
    project = read(projectId).project;
    const generation = structuredClone(episode.generation);
    const task = tasks.run({ kind: 'fanfic', fanficProjectId: projectId, episodeId, stage: generation.action === 'approve' ? 'Фанфик: сохранение памяти' : 'Фанфик: планирование' }, async (signal, job) => {
      let lastSave = 0;
      const persist = (stage, force = false) => {
        job.stage = stage;
        if (!force && Date.now() - lastSave < 250) return;
        lastSave = Date.now();
        episode = patch(projectId, episodeId, (p, e) => {
          e.generation = structuredClone(generation); e.status = 'running'; e.stage = stage;
          if (!['approve','review'].includes(generation.action)&&!generation.preview) { e.sceneIndex = generation.sceneIndex; e.outline = generation.outline || e.outline; e.content = compose(generation); }
        });
      };
      try {
        signal.throwIfAborted();
        const profile=(stage,options={})=>resolveFanficStageProfile(project.settings,stage,{contextWindow:connection.contextWindow,...options});
        const writingProfile=profile('writing'),memoryProfile=profile('memory'),planningProfile=profile('planning'),rewriteProfile=profile('rewrite');
        const budget = Math.max(128, Math.min(memoryProfile.maxTokens, Math.floor((Number(connection.contextWindow) || 8192) / 5)));
        if(generation.action==='review'){
          persist('Проверка связности произведения',true);
          const context=await contextFor(state,project,episode,signal,job,{currentText:generation.baseContent,instructions:generation.instructions});
          const review=await reviewFanficProse({state,project,episode,connection,content:generation.baseContent,context,getSecret,signal,structured,countTokens,onProgress:stage=>persist(stage)});
          patch(projectId,episodeId,(_p,e)=>{e.continuityReview=review;e.generation=generation.previousGeneration||null;e.status=generation.previousStatus||'draft';e.needsReview=generation.previousNeedsReview===true;e.error=e.generation?generation.previousError||'':'';e.stage=e.generation?generation.previousStage||'Незавершённая генерация сохранена':'Проверка связности завершена';addEditor(e,'assistant',review.issues.length?`Проверка нашла ${review.issues.length} возможных противоречий. Текст не изменён.`:'Проверка не нашла явных противоречий в предоставленных источниках. Текст не изменён.');});
          return {projectId,episodeId,reviewed:true};
        }
        if (generation.action === 'approve') {
          const limit = Number(connection.contextWindow) || 8192;
          if(generation.memoryContextWindow!==undefined&&(generation.memoryContextWindow!==limit||generation.memoryBudget!==budget)){
            generation.memoryIndex=0;generation.memoryParts=[];
            job.warnings.push('Контекст модели изменился. Память текущей серии пересобирается из исходного текста целиком.');
          }
          generation.memoryContextWindow=limit;generation.memoryBudget=budget;
          const parts = await splitFanficMemoryForModel(generation.baseContent,episode,connection,budget,{secret:getSecret(connection.id),signal,countTokens});
          const cuts=[];let offset=0;for(const part of parts){offset+=part.length;cuts.push(offset);}
          if(generation.memoryCuts&&JSON.stringify(cuts)!==JSON.stringify(generation.memoryCuts)){generation.memoryParts=[];generation.memoryIndex=0;}
          generation.memoryCuts=cuts;
          for (let i = generation.memoryIndex; i < parts.length; i++) {
            signal.throwIfAborted(); persist(`Память эпизода: ${i + 1}/${parts.length}`, true);
            const memory = validateMemory(await structured({ state, chat: { connectionId: connection.id }, getSecret, signal, name: 'fanfic_memory', schema: fanficMemorySchema, maxTokens: budget, temperature: memoryProfile.temperature,adaptInstruction:true,
              instructions: fanficMemoryInstructions,
              context: { episode: fanficEpisodeLabel(episode), part: i + 1, totalParts: parts.length, prose: evidenceBlocks(parts[i]) }, parse: raw=>validateMemory(raw,parts[i],{projectId,episodeId,sourceHash:contentHash(generation.baseContent),chunkIndex:i,sourceOffset:i?cuts[i-1]:0}) }));
            if(memory.rejectedFacts?.length)job.warnings.push('Память: '+memory.rejectedFacts.length+' неподтверждённых фактов исключено. Проверьте цитаты и при необходимости добавьте факт вручную.');
            generation.memoryParts.push(memory); generation.memoryIndex = i + 1; persist(`Память эпизода: ${i + 1}/${parts.length}`, true);
          }
          signal.throwIfAborted();
          episode = patch(projectId, episodeId, (p, e) => {
            const last = generation.memoryParts.at(-1);
            e.memory = { summary: generation.memoryParts.map(m => m.summary).join('\n\n'), chunks: generation.memoryParts, sourceRanges:cuts.map((end,i)=>({start:i?cuts[i-1]:0,end})), sourceHash: contentHash(e.content), location: last?.location || '', relationships: last?.relationships || [], openThreads: last?.openThreads || [], createdAt: now() };
            e.status = 'approved'; e.needsReview = false; e.generation = null; e.stage = 'Утверждён';
            for (const later of p.episodes) if (fanficEpisodeOrder(later, e) > 0) invalidateDependentEpisode(later);
            addEditor(e, 'assistant', 'Эпизод утверждён. Его события добавлены в память этого произведения.');
          });
          return { projectId, episodeId, approved: true };
        }
        if (!generation.outline) {
          const context=await contextFor(state,project,episode,signal,job,{instructions:generation.instructions,currentText:generation.action==='continue'?generation.baseContent:''});
          const outlineInstructions=`You plan a literary episode, not a roleplay reply. Return ONLY JSON {"scenes":[{"title":"...","summary":"..."}]}. Make ${project.settings.sceneCount} connected scenes in chronological order. Each summary is at most three short sentences describing what must happen in that scene. Cover the author brief and P.S. as writing instructions; never turn them into in-world events. Respect accepted continuity. Write in the author's language, Russian by default.`;
          const outlineContext=prepared=>({request:prepared.messages[1].content});
          const prepared = await prepareFanficMessages({ project, episode, connection, instructions: generation.instructions, ...context, purpose: 'plan',maxTokensOverride:planningProfile.maxTokens },{secret:getSecret(connection.id),signal,countTokens,tokenMessages:prepared=>[{role:'system',content:outlineInstructions},{role:'user',content:JSON.stringify(outlineContext(prepared))}]});
          const outline = validateOutline(await structured({ state, chat: { connectionId: connection.id }, getSecret, signal, name: 'fanfic_outline', schema: fanficOutlineSchema, maxTokens:prepared.maxTokens, temperature:planningProfile.temperature,adaptInstruction:true,
            instructions:outlineInstructions,
            context:outlineContext(prepared), parse: raw => validateOutline(raw, project.settings.sceneCount) }), project.settings.sceneCount);
          generation.outline = outline.scenes; persist('План готов', true);
        }
        const wordBudget=generation.action==='rewrite'?null:await measureFanficWordBudget(connection,getSecret(connection.id),episode.brief+' '+generation.instructions,{signal,countTokens});
        for (let i = generation.sceneIndex; i < generation.outline.length; i++) {
          signal.throwIfAborted();
          const stage = generation.action === 'rewrite' ? 'Переписывание выделенного фрагмента' : `Детальная генерация: сцена ${i + 1}/${generation.outline.length}`;
          persist(stage, true);
          // Local RP fine-tunes can turn an unconstrained editing request into
          // a fresh adventure. A bounded structured replacement keeps this
          // operation separate from scene generation and never continues JSON.
          if(generation.action==='rewrite'&&connection.id==='sas-local'){
            const selected=generation.editParts?.[i]??generation.baseContent.slice(generation.selectionStart,generation.selectionEnd);
            const rewriteArgs={state,chat:{connectionId:connection.id},getSecret,signal,name:'fanfic_rewrite',schema:objectShape({replacement:stringShape}),
              maxTokens:Math.min(rewriteProfile.maxTokens,Math.floor((Number(connection.contextWindow)||8192)/3),Math.max(256,Math.ceil(selected.length/3)*2+160)),temperature:rewriteProfile.temperature,adaptInstruction:true,
              instructions:'Ты редактор, а не рассказчик. Измени ТОЛЬКО исходный фрагмент по пожеланию автора. Не продолжай сюжет, не добавляй персонажей, действий или следующую сцену. Сохрани факты и имена, кроме явно запрошенных изменений. Пиши replacement на языке исходного фрагмента. Не переводи текст. Объём примерно равен исходному. Верни JSON {"replacement":"отредактированный фрагмент"}. Никаких объяснений. Не копируй эти инструкции в replacement.',
              context:{request:generation.instructions,style:shorten(project.settings.style,350),source:selected},
              parse:raw=>{const value=typeof raw==='string'?parseObject(raw):raw;if(typeof value?.replacement!=='string'||!value.replacement.trim())throw new Error('Нужен непустой replacement.');if(value.replacement.length>Math.max(1200,selected.length*4))throw new Error('Замена слишком велика: отредактируй фрагмент без продолжения сюжета.');if((selected.match(/[А-Яа-яЁё]/g)||[]).length>(selected.match(/[A-Za-z]/g)||[]).length+20&&(value.replacement.match(/[А-Яа-яЁё]/g)||[]).length<(value.replacement.match(/[A-Za-z]/g)||[]).length)throw new Error('Исходный фрагмент на русском. replacement должен быть на русском языке, перевод недопустим.');return value.replacement;}};
            const rewriteMessages=[{role:'system',content:rewriteArgs.instructions},{role:'user',content:JSON.stringify(rewriteArgs.context)}];
            const actual=await countTokens(connection,getSecret(connection.id),rewriteMessages,{signal,adaptInstruction:true,disableThinking:true});
            if((actual??messageTokens(rewriteMessages)*1.6)+rewriteArgs.maxTokens+260>(Number(connection.contextWindow)||8192)){
              if(selected.length<2)throw fail('Пожелание редактору не помещается в контекст этой модели. Сократите его или увеличьте контекст; исходный текст сохранён.');
              const halves=breakProse(selected,Math.max(1,Math.floor(selected.length/2)));
              generation.editParts||=[selected];generation.editParts.splice(i,1,...halves);
              generation.outline=generation.editParts.map((_,index)=>({title:`Правка фрагмента ${index+1}`,summary:generation.instructions}));
              persist('Фрагмент разделён по фактическому контексту модели',true);i--;continue;
            }
            const replacement=await structured(rewriteArgs);
            signal.throwIfAborted();generation.completedText=(generation.completedText||'')+replacementAtSourceBoundary(selected,replacement);generation.partial='';generation.sceneIndex=i+1;persist(`Фрагмент ${i+1}/${generation.outline.length} сохранён`,true);continue;
          }
          for (let request = 0; request < 3; request++) {
            const currentText = generation.action === 'rewrite' ? generation.partial : generation.action === 'continue' ? compose(generation) : join(generation.completedText, generation.partial);
            const continuing = generation.partial.length > 0;
            const editing=generation.action==='rewrite';
            const editStart=editing?generation.selectionStart+(generation.editParts||[]).slice(0,i).join('').length:0;
            const selected=editing?(generation.editParts?.[i]??generation.baseContent.slice(generation.selectionStart,generation.selectionEnd)):'';
            const context=await contextFor(state,project,episode,signal,job,{instructions:generation.instructions,currentText:editing?selected:currentText,scene:generation.outline[i]});
            const prepared = await prepareFanficMessages({ project, episode, connection, ...context, purpose: generation.action,
              instructions: generation.instructions + (continuing ? '\nThe response was interrupted. Continue exactly after its last character, completing any unfinished sentence. Never restart or repeat the response. Finish naturally within '+Math.min(50,fanficSceneWordLimit(writingProfile.maxTokens,wordBudget?.tokensPerWord))+' words; do not introduce new plot turns.' : editing?'\nВерни только переработанный исходный фрагмент. Объём соразмерен исходному.':`\nЭта сцена должна быть короткой: не более ${fanficSceneWordLimit(Math.min(writingProfile.maxTokens,Math.floor((Number(connection.contextWindow)||8192)*.32)),wordBudget?.tokensPerWord)} слов. Если автор просит меньший объём, соблюдай его. Заверши сразу после запрошенных событий, полным предложением. Не начинай следующую сцену.`),
              maxTokensOverride:editing?rewriteProfile.maxTokens:writingProfile.maxTokens,currentText, scene: { ...generation.outline[i], index: i + 1, total: generation.outline.length, next: generation.outline[i + 1]?.summary || '' },
              selectedText: selected,
              surroundingContext: editing ? { before: generation.baseContent.slice(Math.max(0, editStart - 900), editStart), after: generation.baseContent.slice(editStart+selected.length, editStart+selected.length+900) } : undefined },{secret:getSecret(connection.id),signal,countTokens});
            patch(projectId,episodeId,(_p,e)=>{e.contextReport=reportFor(context,prepared);});
            const before = generation.partial.length;
            let finishReason;const continuationJoiner=continuing?createTextContinuationJoiner(generation.partial):null;
            try {
            for await (const chunk of stream(connection, getSecret(connection.id), prepared.messages, { signal, stop:fanficStops, disableThinking: true,adaptInstruction:true,guardRepetition:true, onFinish: reason => { finishReason = reason; }, preset: { maxTokens: prepared.maxTokens, temperature:editing?rewriteProfile.temperature:writingProfile.temperature } })) {
              signal.throwIfAborted();
              // Continuation may begin with a suffix of an unfinished word.
              // Never insert a speculative space between letters.
              generation.partial += continuationJoiner?continuationJoiner.push(chunk):chunk; job.text = generation.partial;
              if (compose(generation).length > 2000000) throw fail('Эпизод достиг лимита в 2 миллиона символов. Создайте следующий эпизод.');
              persist(stage);
            }
            } finally {if(continuationJoiner){generation.partial+=continuationJoiner.flush();job.text=generation.partial;persist(stage);}}
            if (!generation.partial.slice(before).trim()) throw new Error(before>0
              ? 'Модель не смогла завершить оборванную сцену. Весь полученный черновик сохранён. Нажмите «Возобновить» или выберите другую модель.'
              : 'Модель не вернула художественный текст. Повторите продолжение или выберите другую модель.');
            if (finishReason !== 'length') break;
            persist(`Завершение сцены ${i + 1}/${generation.outline.length}: продолжение ${request + 1}`, true);
            if (request === 2) {
              // Editing must retain the selected range's scope; an ending is
              // appropriate only for prose scenes, never replacement chunks.
              if(editing)throw new Error(`Модель трижды исчерпала длину правки. Черновик сохранён. Нажмите «Возобновить».`);
              persist('Короткое завершение оборванной сцены',true);
              try {
                const ending=await finishFanficScene({state,connection,getSecret,signal,scene:generation.outline[i],tail:generation.partial,
                  instructions:episode.brief+'\n'+generation.instructions,maxTokens:writingProfile.maxTokens,temperature:writingProfile.temperature,structured,countTokens});
                signal.throwIfAborted();
                const seam=createTextContinuationJoiner(generation.partial);
                generation.partial+=seam.push(ending)+seam.flush();job.text=generation.partial;
                job.warnings.push(`Сцена ${i+1} завершена коротким дополнением после трёх ограниченных ответов. Проверьте связность заключительной фразы.`);
                persist('Завершение сцены сохранено',true);
              } catch(error) {
                signal.throwIfAborted();
                throw new Error(`Модель трижды исчерпала длину ответа в сцене ${i+1}, и короткое завершение не удалось: ${error.message} Черновик сохранён. Нажмите «Возобновить».`);
              }
            }
          }
          const sceneText=cleanFanficProse(generation.partial);
          if(!sceneText.trim())throw new Error('Модель вернула служебный комментарий вместо текста сцены. Черновик сохранён; повторите генерацию с другим пожеланием или моделью.');
          if(generation.action==='rewrite'){const source=generation.editParts?.[i]??generation.baseContent.slice(generation.selectionStart,generation.selectionEnd);generation.completedText=(generation.completedText||'')+replacementAtSourceBoundary(source,sceneText);}
          else generation.completedText = join(generation.completedText, sceneText); generation.partial = ''; generation.sceneIndex = i + 1;
          persist(`Сцена ${i + 1}/${generation.outline.length} сохранена`, true);
        }
        signal.throwIfAborted();
        const candidate=compose(generation);let review=null;
        if(project.settings.continuityCheck===true){
          try{
            persist('Проверка связности нового текста',true);
            const start=generation.action==='continue'?Math.min(candidate.length,generation.baseContent.length):generation.action==='rewrite'?generation.selectionStart:0;
            const end=generation.action==='rewrite'?candidate.length-(generation.baseContent.length-generation.selectionEnd):candidate.length;
            const context=await contextFor(state,project,episode,signal,job,{currentText:candidate,instructions:generation.instructions});
            review=await reviewFanficProse({state,project,episode,connection,content:candidate,range:{start,end},context,getSecret,signal,structured,countTokens,onProgress:stage=>persist(stage)});
          }catch(error){signal.throwIfAborted();review={status:'unavailable',sourceHash:contentHash(candidate),issues:[],error:error.message,createdAt:now()};job.warnings.push('Проверка связности не завершилась; текст сохранён: '+error.message);}
        }
        episode = patch(projectId, episodeId, (p, e) => {
          if(generation.preview){
            e.editProposal={id:randomUUID(),sourceHash:generation.sourceHash,sourceRevision:e.revision+1,selectionStart:generation.selectionStart,selectionEnd:generation.selectionEnd,original:generation.baseContent.slice(generation.selectionStart,generation.selectionEnd),replacement:(generation.completedText||'')+(generation.partial||''),instructions:generation.instructions,warnings:review?.issues||[],reviewStatus:review?.status||'disabled',createdAt:now()};
            e.status=generation.previousStatus||'draft';e.needsReview=generation.previousNeedsReview===true;e.stage='Предложение правки готово';
          }else {e.content=candidate;e.status='draft';e.stage='Черновик готов';e.continuityReview=review;}
          e.generation=generation.preview?generation.previousGeneration||null:null;e.error=e.generation?generation.previousError||'':'';
          addEditor(e,'assistant',generation.preview?'Предложение готово. Сравните исходный фрагмент и замену; текст и канон пока не изменены.':generation.action==='rewrite'?'Выделенный фрагмент заменён. Остальной текст сохранён.':'Черновик готов. Проверьте текст и утвердите эпизод, чтобы его события вошли в память произведения.');
        });
        return { projectId, episodeId };
      } catch (error) {
        patch(projectId, episodeId, (p, e) => {
          e.generation = structuredClone(generation); e.status = generation.preview||generation.action==='review'?(generation.previousStatus||'draft'):signal.aborted ? 'stopped' : 'error'; e.error = signal.aborted ? '' : error.message;
          e.stage = signal.aborted ? 'Остановлено, черновик сохранён' : 'Ошибка генерации';
          if (!['approve','review'].includes(generation.action)&&!generation.preview) e.content = compose(generation);
        });
        throw error;
      }
    });
    return task.job;
  }

  const route = handler => async (req, res) => { try { await handler(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.message }); } };
  router.post('/projects', route((req, res) => {
    tasks.assertIdle(); const state = getState(), project = normalizeFanficProject(req.body, state);
    state.fanficProjects ||= []; state.fanficProjects.push(project); saveState(state); res.status(201).json(project);
  }));
  router.patch('/projects/:id', route((req, res) => {
    tasks.assertIdle(); const state = getState(); read(req.params.id);
    const result = patch(req.params.id, null, project => {
      const oldReferences=JSON.stringify([project.world,project.canon,project.divergence,project.characters,project.personas,project.lorebooks]);
      for (const key of ['title', 'world', 'canon', 'divergence']) if (has(req.body, key)) project[key] = text(req.body[key], key === 'title' ? 200 : 12000);
      if (!project.title.trim()) project.title = 'Новый фанфик';
      if (has(req.body, 'settings')) project.settings = settingsOf({ ...project.settings, ...req.body.settings });
      for (const [key, field] of [['characterIds', 'characters'], ['personaIds', 'personas'], ['lorebookIds', 'lorebooks']]) if (has(req.body, key)) project[field] = updateSnapshots(req.body, field, state, project[field]);
      if(oldReferences!==JSON.stringify([project.world,project.canon,project.divergence,project.characters,project.personas,project.lorebooks]))for(const episode of project.episodes){
        if(episode.content)episode.needsReview=true;
        episode.contextReport=null;episode.editProposal=null;episode.continuityReview=null;
        if(episode.generation){episode.generation=null;episode.status='draft';episode.error='';episode.stage='Материалы произведения изменены';episode.revision=(episode.revision||0)+1;}
      }
    }); res.json(result);
  }));
  router.delete('/projects/:id', route((req, res) => {
    tasks.assertIdle(); read(req.params.id); const state = getState(); state.fanficProjects = state.fanficProjects.filter(p => p.id !== req.params.id);
    state.images=(state.images||[]).filter(image=>image.fanficProjectId!==req.params.id);
    saveState(state); res.json({ ok: true });
  }));
  router.post('/projects/:id/calibrate',route((req,res)=>{
    tasks.assertIdle();const {project}=read(req.params.id),state=getState(),connection=getConnection(state,{connectionId:project.settings.connectionId});
    if(!connection.model)throw fail('Выберите и запустите модель в настройках подключения.');
    const task=tasks.run({kind:'fanfic',fanficProjectId:project.id,stage:'Проверка модели для фанфика'},async(signal,job)=>{
      const persist=report=>{job.stage='Проверка модели: '+report.stages.length+'/5';patch(project.id,null,p=>{p.modelEvaluation=structuredClone(report);});};
      const report=await calibrateFanficModel({state,project,connection,getSecret,signal,structured,stream,countTokens,onProgress:persist});
      persist(report);return {projectId:project.id,evaluation:report};
    });res.status(202).json(task.job);
  }));
  router.post('/projects/:id/episodes', route((req, res) => {
    tasks.assertIdle(); const { project } = read(req.params.id); if (project.episodes.length >= 500) throw fail('В произведении уже 500 эпизодов. Создайте новый том.');
    const season = Math.round(bounded(req.body.season, 1, 1, 999));
    const number = req.body.number ?? Math.max(0, ...project.episodes.filter(e => e.season === season).map(e => e.number)) + 1;
    const episode = newEpisode({ ...req.body, season, number }); ensureEpisodeNumber(project,episode);patch(project.id, null, p => p.episodes.push(episode)); res.status(201).json(episode);
  }));
  router.patch('/projects/:id/episodes/:episodeId', route((req, res) => {
    tasks.assertIdle(); const { project,episode } = read(req.params.id, req.params.episodeId); revision(episode, req.body.expectedRevision);
    ensureEpisodeNumber(project,{season:Math.round(bounded(req.body.season,episode.season,1,999)),number:Math.round(bounded(req.body.number,episode.number,1,9999))},episode.id);
    if (has(req.body, 'content') && (typeof req.body.content !== 'string' || req.body.content.length > 2000000)) throw fail('Текст эпизода должен быть короче 2 миллионов символов.');
    res.json(patch(req.params.id, episode.id, (p, e) => {
      const changed = has(req.body, 'content') && req.body.content !== e.content;
      const orderChanged = ['season', 'number'].some(key => has(req.body, key) && Number(req.body[key]) !== e[key]);
      if (changed || orderChanged) { rememberVersion(e, 'До ручной правки'); invalidateEpisode(p, e); }
      else if (has(req.body, 'brief') && req.body.brief !== e.brief && e.generation) { e.generation = null; e.status = 'draft'; e.error = ''; e.stage = ''; }
      for (const key of ['title', 'brief', 'content']) if (has(req.body, key)) e[key] = text(req.body[key], key === 'content' ? 2000000 : key === 'brief' ? 16000 : 200);
      if (has(req.body, 'season')) e.season = Math.round(bounded(req.body.season, e.season, 1, 999));
      if (has(req.body, 'number')) e.number = Math.round(bounded(req.body.number, e.number, 1, 9999));
      if (orderChanged) for (const later of p.episodes) if (fanficEpisodeOrder(later, e) > 0) invalidateDependentEpisode(later);
    }));
  }));
  router.delete('/projects/:id/episodes/:episodeId', route((req, res) => {
    tasks.assertIdle(); const { episode } = read(req.params.id, req.params.episodeId);
    const state=getState(),project=state.fanficProjects.find(p=>p.id===req.params.id);
    invalidateEpisode(project,project.episodes.find(e=>e.id===episode.id));project.episodes=project.episodes.filter(e=>e.id!==episode.id);project.updatedAt=now();
    state.images=(state.images||[]).filter(image=>image.fanficProjectId!==project.id||image.episodeId!==episode.id);
    saveState(state);res.json({ ok: true });
  }));
  router.post('/projects/:id/episodes/:episodeId/generate', route((req, res) => res.status(202).json(generate(req.params.id, req.params.episodeId, req.body))));
  router.post('/projects/:id/episodes/:episodeId/context',route(async(req,res)=>{
    tasks.assertIdle();const {project,episode}=read(req.params.id,req.params.episodeId),state=getState(),connection=getConnection(state,{connectionId:project.settings.connectionId});
    if(req.body.instructions!==undefined&&typeof req.body.instructions!=='string')throw fail('Пожелание должно быть текстом.');
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const options={instructions:text(req.body.instructions,16000),currentText:episode.content};
    const context=await contextFor(state,project,episode,controller.signal,null,options);
    const prepared=await prepareFanficMessages({project,episode,connection,...options,...context,purpose:'continue'},{secret:getSecret(connection.id),signal:controller.signal,countTokens});
    res.json({...prepared,report:reportFor(context,prepared)});
  }));
  router.get('/projects/:id/episodes/:episodeId/canon',route((req,res)=>{
    const {project,episode}=read(req.params.id,req.params.episodeId);
    const current=eligibleCanonFacts(project).filter(f=>f.episodeId===episode.id);
    res.json({projectId:project.id,episodeId:episode.id,facts:[...eligibleCanonFacts(project,episode),...current]});
  }));
  router.patch('/projects/:id/episodes/:episodeId/memory/facts',route((req,res)=>{
    tasks.assertIdle();const {episode}=read(req.params.id,req.params.episodeId);
    if(!Number.isInteger(req.body.expectedRevision))throw fail('Нужна текущая версия серии.',409);revision(episode,req.body.expectedRevision);
    if(!episode.memory||episode.memory.sourceHash!==contentHash(episode.content))throw fail('Сначала создайте память из текущего текста серии.');
    const index=req.body.chunkIndex??0,parts=episode.memory.chunks?.length?episode.memory.chunks:[episode.memory];
    if(!Number.isInteger(index)||index<0||index>=parts.length)throw fail('Блок памяти не найден.',404);
    const range=episode.memory.sourceRanges?.[index]||{start:0,end:episode.content.length};
    if(!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<0||range.end<=range.start||range.end>episode.content.length)throw fail('Границы памяти устарели. Создайте память заново.',409);
    const facts=validateCanonManualFacts(req.body.facts,{prose:episode.content.slice(range.start,range.end),projectId:req.params.id,episodeId:episode.id,sourceHash:episode.memory.sourceHash,chunkIndex:index,sourceOffset:range.start,existingFacts:parts[index].facts||[]});
    res.json(patch(req.params.id,episode.id,(project,e)=>{
      const chunks=structuredClone(parts);chunks[index].facts=facts;chunks[index].editedByAuthor=true;
      e.memory={...e.memory,chunks,updatedAt:now()};e.contextReport=null;e.editProposal=null;e.continuityReview=null;
      for(const later of project.episodes)if(fanficEpisodeOrder(later,e)>0)invalidateDependentEpisode(later);
    }));
  }));
  router.post('/projects/:id/episodes/:episodeId/edits/:proposalId/apply',route((req,res)=>{
    tasks.assertIdle();const {episode}=read(req.params.id,req.params.episodeId);
    if(!Number.isInteger(req.body.expectedRevision))throw fail('Нужна текущая версия серии.',409);revision(episode,req.body.expectedRevision);
    const proposal=episode.editProposal;
    if(!proposal||proposal.id!==req.params.proposalId)throw fail('Предложение правки больше не существует.',409);
    if(proposal.sourceHash!==contentHash(episode.content)||proposal.sourceRevision!==episode.revision||!Number.isInteger(proposal.selectionStart)||!Number.isInteger(proposal.selectionEnd)||proposal.selectionStart<0||proposal.selectionEnd<=proposal.selectionStart||proposal.selectionEnd>episode.content.length||episode.content.slice(proposal.selectionStart,proposal.selectionEnd)!==proposal.original)throw fail('Исходный текст изменился. Подготовьте правку заново.',409);
    if(typeof proposal.replacement!=='string'||!proposal.replacement.trim())throw fail('Предложенная замена пуста.');
    const candidate=episode.content.slice(0,proposal.selectionStart)+proposal.replacement+episode.content.slice(proposal.selectionEnd);
    if(candidate.length>2000000)throw fail('Эпизод достиг лимита в 2 миллиона символов.');
    res.json(patch(req.params.id,episode.id,(p,e)=>{rememberVersion(e,'До принятия ИИ-правки');invalidateEpisode(p,e);e.content=candidate;e.stage='Правка принята';addEditor(e,'assistant','Правка принята. Проверьте и утвердите новую память серии.');}));
  }));
  router.delete('/projects/:id/episodes/:episodeId/edits/:proposalId',route((req,res)=>{
    tasks.assertIdle();const {episode}=read(req.params.id,req.params.episodeId);
    if(!Number.isInteger(req.body?.expectedRevision))throw fail('Нужна текущая версия серии.',409);revision(episode,req.body.expectedRevision);
    if(episode.editProposal?.id!==req.params.proposalId)throw fail('Предложение правки больше не существует.',409);
    res.json(patch(req.params.id,episode.id,(_p,e)=>{e.editProposal=null;e.stage='Правка отклонена';}));
  }));
  router.patch('/projects/:id/episodes/:episodeId/memory',route((req,res)=>{
    tasks.assertIdle();const {episode}=read(req.params.id,req.params.episodeId);revision(episode,req.body.expectedRevision);
    if(!episode.memory||episode.memory.sourceHash!==contentHash(episode.content))throw fail('Сначала создайте память из текущего текста серии.');
    const index=req.body.chunkIndex??0,parts=episode.memory.chunks?.length?episode.memory.chunks:[episode.memory];
    if(!Number.isInteger(index)||index<0||index>=parts.length)throw fail('Блок памяти не найден.',404);
    for(const key of ['summary','location'])if(typeof req.body[key]!=='string'||req.body[key].length>(key==='summary'?6000:1000))throw fail('Неверный размер поля памяти.');
    if(!req.body.summary.trim())throw fail('Сводка памяти не должна быть пустой.');
    for(const key of ['relationships','openThreads'])if(!Array.isArray(req.body[key])||req.body[key].length>20||req.body[key].some(v=>typeof v!=='string'||v.length>800))throw fail('В памяти допускается до 20 кратких записей в каждом списке.');
    const memory=validateMemory(req.body);memory.editedByAuthor=true;
    const fields=['summary','location','relationships','openThreads'];
    if(JSON.stringify(fields.map(key=>parts[index][key]))===JSON.stringify(fields.map(key=>memory[key])))return res.json(episode);
    res.json(patch(req.params.id,episode.id,(project,e)=>{
      const chunks=structuredClone(parts);chunks[index]={...parts[index],...memory,facts:parts[index].facts||[],rejectedFacts:parts[index].rejectedFacts||[]};const last=chunks.at(-1);
      e.memory={...e.memory,chunks,summary:chunks.map(d=>d.summary).join('\n\n'),location:last.location,relationships:last.relationships,openThreads:last.openThreads,updatedAt:now()};e.contextReport=null;e.editProposal=null;e.continuityReview=null;
      for(const later of project.episodes)if(fanficEpisodeOrder(later,e)>0)invalidateDependentEpisode(later);
    }));
  }));
  router.post('/projects/:id/episodes/:episodeId/restore', route((req, res) => {
    tasks.assertIdle(); const { episode } = read(req.params.id, req.params.episodeId); revision(episode, req.body.expectedRevision);
    const version = episode.versions.find(v => v.id === req.body.versionId); if (!version) throw fail('Вариант текста не найден.', 404);
    res.json(patch(req.params.id, episode.id, (p, e) => { rememberVersion(e, 'До восстановления варианта'); invalidateEpisode(p, e); e.content = version.content; }));
  }));
  router.get('/projects/:id/export', route((req, res) => {
    const { project } = read(req.params.id); const exported = structuredClone(project); exported.settings.connectionId = '';
    for (const episode of exported.episodes) episode.generation = null;
    res.json({ spec: 'sas_fanfic_v1', project: exported });
  }));
  router.post('/import', route((req, res) => {
    tasks.assertIdle(); const input = req.body?.project || req.body;
    const state = getState(), project = normalizeFanficProject(input, state, { importing: true }); state.fanficProjects ||= []; state.fanficProjects.push(project); saveState(state); res.status(201).json(project);
  }));
  return { router, generate, read };
}

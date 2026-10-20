import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_TEXT = 1_000_000;
const string = (value, fallback = '') => typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const id = prefix => `${prefix}-${randomUUID()}`;
const cleanStrings = value => list(value).filter(item => typeof item === 'string').slice(0, 1000);

export function parseImportData(data, fileName = '') {
  if (typeof data !== 'string') {
    if (!data || typeof data !== 'object') throw new Error('Файл должен содержать JSON-объект.');
    return data;
  }
  if (/\.png$/i.test(fileName) || data.startsWith('data:image/png;base64,')) return parsePngCard(data);
  if (Buffer.byteLength(data, 'utf8') > 12_000_000) throw new Error('JSON превышает лимит 12 МБ.');
  try { return JSON.parse(data); } catch { throw new Error('Не удалось прочитать JSON. Проверьте формат файла.'); }
}

// Decode metadata only. Image pixels and imported JavaScript are never evaluated.
export function parsePngCard(base64) {
  const encoded = String(base64).replace(/^data:image\/png;base64,/, '').replace(/\s/g, '');
  if (encoded.length > 28_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Некорректный PNG или файл больше 20 МБ.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 20 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Файл не является PNG.');
  let offset = 8;
  const cards = new Map();
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) throw new Error('Повреждённая структура PNG.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    offset += size + 12;
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const end = chunk.indexOf(0);
      if (end < 1 || end > 79) continue;
      const key = chunk.toString('ascii', 0, end);
      if (!['chara', 'ccv3'].includes(key)) continue;
      let payload = chunk.subarray(end + 1);
      if (type === 'zTXt') {
        if (payload[0] !== 0) throw new Error('Неизвестное сжатие PNG.');
        payload = inflateSync(payload.subarray(1), { maxOutputLength: 12_000_000 });
      } else if (type === 'iTXt') {
        if (payload.length < 4 || payload[1] !== 0) throw new Error('Повреждённые метаданные PNG.');
        const compressed = payload[0];
        const languageEnd = payload.indexOf(0, 2);
        const translatedEnd = payload.indexOf(0, languageEnd + 1);
        if (languageEnd < 0 || translatedEnd < 0) throw new Error('Повреждённые метаданные PNG.');
        payload = payload.subarray(translatedEnd + 1);
        if (compressed === 1) payload = inflateSync(payload, { maxOutputLength: 12_000_000 });
        else if (compressed !== 0) throw new Error('Неизвестное сжатие PNG.');
      }
      if (payload.length > 12_000_000) throw new Error('Метаданные PNG превышают лимит.');
      const text = payload.toString('utf8').trim();
      try { cards.set(key, JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'))); }
      catch { throw new Error('В PNG найдена повреждённая карточка персонажа.'); }
    }
    if (type === 'IEND') break;
  }
  const card = cards.get('ccv3') || cards.get('chara');
  if (!card) throw new Error('В PNG нет карточки chara/ccv3. Обычное изображение нельзя импортировать как персонажа.');
  return card;
}

export function convertCharacter(input) {
  const root = object(input);
  const data = Object.keys(object(root.data)).length ? root.data : root;
  if (!string(data.name).trim()) throw new Error('В карточке отсутствует имя персонажа.');
  const sas = object(object(data.extensions).sas);
  return {
    id: id('char'), name: string(data.name).trim(), subtitle: string(data.subtitle, string(sas.subtitle, 'Импортированная карточка')),
    avatar: string(data.avatar, string(sas.avatar, '✦')), color: string(data.color, string(sas.color, 'violet')),
    description: string(data.description), personality: string(data.personality), appearance: string(data.appearance, string(sas.appearance)),
    scenario: string(data.scenario), firstMessage: string(data.firstMessage, string(data.first_mes)),
    exampleDialogue: string(data.exampleDialogue, string(data.mes_example)), systemPrompt: string(data.systemPrompt, string(data.system_prompt)),
    postHistoryInstructions: string(data.postHistoryInstructions, string(data.post_history_instructions)),
    creatorNotes: string(data.creatorNotes, string(data.creator_notes)), alternateGreetings: cleanStrings(data.alternateGreetings || data.alternate_greetings),
    tags: cleanStrings(data.tags), blocks: list(data.blocks || sas.blocks).slice(0, 100).map(block => ({id:id('block'), name:string(block.name, 'Блок'), content:string(block.content), enabled:block.enabled !== false})),
    extensions: structuredClone(object(data.extensions)), sourceCard: structuredClone(data),
    ...(data.character_book ? {characterBook: convertLorebook(data.character_book)} : {}),
  };
}

export function exportCharacter(character) {
  const c = object(character);
  const prior = object(c.sourceCard);
  return {spec:'chara_card_v2', spec_version:'2.0', data:{
    ...prior, name:c.name, description:c.description || '', personality:c.personality || '', scenario:c.scenario || '',
    first_mes:c.firstMessage || '', mes_example:c.exampleDialogue || '', creator_notes:c.creatorNotes || '',
    system_prompt:c.systemPrompt || '', post_history_instructions:c.postHistoryInstructions || '',
    alternate_greetings:list(c.alternateGreetings), tags:list(c.tags), creator:string(prior.creator), character_version:string(prior.character_version, '1.0'),
    extensions:{...object(prior.extensions), ...object(c.extensions), sas:{...object(object(prior.extensions).sas), appearance:c.appearance || '', blocks:list(c.blocks), subtitle:c.subtitle || '', avatar:c.avatar || '✦', color:c.color || 'violet'}},
    ...(c.characterBook ? {character_book:exportLorebook(c.characterBook, true)} : {}),
  }};
}

export function convertLorebook(input) {
  const data = object(input);
  const entries = Array.isArray(data.entries) ? data.entries : Object.values(object(data.entries));
  if (!('entries' in data)) throw new Error('В лорбуке отсутствует entries.');
  if (entries.length > 5000) throw new Error('Лорбук содержит больше 5000 записей.');
  return {
    id:id('lore'), name:string(data.name, 'Импортированный лорбук'), description:string(data.description), enabled:data.enabled !== false,
    sourceLorebook:structuredClone(data), entries:entries.map((entry, index) => ({
      id:id('entry'), name:string(entry.name, string(entry.comment, `Запись ${index + 1}`)), keys:cleanStrings(entry.keys || entry.key),
      secondaryKeys:cleanStrings(entry.secondary_keys || entry.keysecondary), content:string(entry.content),
      enabled:entry.enabled !== false && entry.disable !== true, constant:!!entry.constant,
      priority:Number.isFinite(Number(entry.priority ?? entry.order ?? entry.insertion_order)) ? Number(entry.priority ?? entry.order ?? entry.insertion_order) : 100,
      vectorized:!!(entry.vectorized??entry.extensions?.sas?.vectorized),caseSensitive:!!(entry.caseSensitive ?? entry.case_sensitive), selective:!!entry.selective,
      sourceEntry:structuredClone(object(entry)),
    })),
  };
}

export function exportLorebook(lorebook, characterBook = false) {
  const entries = list(lorebook.entries).map((entry, index) => ({
    ...object(entry.sourceEntry), uid:index, id:index, key:list(entry.keys), keys:list(entry.keys), keysecondary:list(entry.secondaryKeys), secondary_keys:list(entry.secondaryKeys),
    comment:entry.name, name:entry.name, content:entry.content, disable:entry.enabled === false, enabled:entry.enabled !== false,
    constant:!!entry.constant, order:entry.priority ?? 100, insertion_order:entry.priority ?? 100, caseSensitive:!!entry.caseSensitive, case_sensitive:!!entry.caseSensitive,
    selective:!!entry.selective, vectorized:!!entry.vectorized, extensions:{...object(object(entry.sourceEntry).extensions),sas:{...object(object(object(entry.sourceEntry).extensions).sas),vectorized:!!entry.vectorized}},
  }));
  return {...object(lorebook.sourceLorebook), name:lorebook.name, description:lorebook.description || '', entries:characterBook ? entries : Object.fromEntries(entries.map((entry, index) => [String(index), entry]))};
}

export function convertPreset(input, fileName = '') {
  const source = object(input);
  if (!Object.keys(source).length) throw new Error('Пустой пресет.');
  const prompts = list(source.prompts).slice(0, 200).map(prompt => ({...object(prompt), content:string(prompt.content)}));
  const result = {id:id('preset'), name:string(source.name, fileName.replace(/\.json$/i, '') || 'Импортированный пресет'),
    systemPrompt:string(source.systemPrompt, string(source.system_prompt, string(source.main_prompt))), prompts,
    promptOrder:list(source.promptOrder || source.prompt_order), source:structuredClone(source)};
  for (const [target, keys, minimum, maximum] of [['temperature',['temperature','temp'],0,2], ['maxTokens',['maxTokens','openai_max_tokens','max_tokens','max_length'],1,131072], ['topP',['topP','top_p'],0,1]]) {
    const value = keys.map(key => source[key]).find(value => value !== undefined);
    if (value !== undefined && Number.isFinite(Number(value))) result[target] = Math.min(maximum, Math.max(minimum, Number(value)));
  }
  return result;
}

export function convertRegexRules(input) {
  const rules = Array.isArray(input) ? input : Array.isArray(input?.regexRules) ? input.regexRules : Array.isArray(input?.regex_scripts) ? input.regex_scripts : [input];
  if (rules.length > 100) throw new Error('Не более 100 Regex-правил за один импорт.');
  return rules.map((source, index) => {
    const rule = object(source);
    const findRegex = string(rule.findRegex, string(rule.pattern));
    if (!findRegex || findRegex.length > 2000) throw new Error(`Правило ${index + 1}: шаблон отсутствует или длиннее 2000 символов.`);
    const pattern = parseRegex(findRegex, rule.flags);
    try { new RegExp(pattern.source, pattern.flags); } catch { throw new Error(`Правило ${index + 1}: некорректное регулярное выражение.`); }
    return {id:id('regex'), scriptName:string(rule.scriptName, string(rule.name, `Правило ${index + 1}`)), findRegex,
      replaceString:string(rule.replaceString, string(rule.replacement)), flags:typeof rule.flags === 'string' ? rule.flags : undefined,
      placement:Array.isArray(rule.placement) ? rule.placement.filter(item => [0,1,2,3,5,6].includes(item)) : [1,2],
      disabled:!!rule.disabled || rule.enabled === false, markdownOnly:!!rule.markdownOnly, promptOnly:!!rule.promptOnly,
      runOnEdit:!!rule.runOnEdit, substituteRegex:Number(rule.substituteRegex) || 0, trimStrings:cleanStrings(rule.trimStrings),
      minDepth:rule.minDepth == null || rule.minDepth === '' ? null : Number(rule.minDepth), maxDepth:rule.maxDepth == null || rule.maxDepth === '' ? null : Number(rule.maxDepth)};
  });
}

export function convertPlugin(input) {
  const source = object(input);
  if (source.js || source.css || source.entry || source.main || source.scripts || source.requires || source.display_name) {
    const error = new Error('Это расширение SillyTavern с JavaScript. Прямой запуск не поддерживается. Импортируйте его Regex-правила или используйте нативный SAS-плагин.');
    error.supported = false;
    throw error;
  }
  if (!string(source.name).trim() || !string(source.version).trim()) throw new Error('SAS-плагину нужны name и version.');
  if (source.format && source.format !== 'sas-plugin-v1') throw new Error('Неизвестный формат плагина. Ожидается sas-plugin-v1.');
  if (!source.prompt && !list(source.regexRules).length) throw new Error('SAS-плагин должен содержать prompt и/или regexRules.');
  return {id:id('plugin'), name:string(source.name), version:string(source.version), description:string(source.description),
    prompt:string(source.prompt), regexRules:source.regexRules ? convertRegexRules(source.regexRules) : [], enabled:false, builtin:false,
    format:'sas-plugin-v1', capabilities:[...(source.prompt ? ['prompt'] : []), ...(list(source.regexRules).length ? ['regex'] : [])]};
}

function parseRegex(value, explicitFlags) {
  if (value.startsWith('/')) {
    const finalSlash = value.lastIndexOf('/');
    if (finalSlash > 0 && /^[dgimsuvy]*$/.test(value.slice(finalSlash + 1))) return {source:value.slice(1, finalSlash), flags:value.slice(finalSlash + 1)};
  }
  return {source:value, flags:typeof explicitFlags === 'string' ? explicitFlags : ''};
}

function runRegex({text, rules, placement, options}) {
  let result = text;
  const position = typeof placement === 'number' ? placement : ({input:1, output:2, lore:5, reasoning:6}[placement] ?? 2);
  const mode = options.mode || 'display';
  for (const rule of rules.slice(0, 100)) {
    if (rule.disabled || rule.enabled === false || (Array.isArray(rule.placement) && !rule.placement.includes(position))) continue;
    if (mode === 'prompt' && rule.markdownOnly && !rule.promptOnly) continue;
    if (mode === 'display' && rule.promptOnly && !rule.markdownOnly) continue;
    if (mode === 'storage' && (rule.promptOnly || rule.markdownOnly)) continue;
    if (options.isEdit && !rule.runOnEdit) continue;
    if (rule.minDepth != null && rule.minDepth >= 0 && options.depth < rule.minDepth) continue;
    if (rule.maxDepth != null && rule.maxDepth >= 0 && options.depth > rule.maxDepth) continue;
    let find = string(rule.findRegex, string(rule.pattern));
    if (!find || find.length > 2000) continue;
    if (rule.substituteRegex && options.macros) find = find.replace(/\{\{(user|char)\}\}/g, (match, key) => {
      const value = string(options.macros[key], match);
      return rule.substituteRegex === 2 ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;
    });
    const pattern = parseRegex(find, rule.flags);
    const regex = new RegExp(pattern.source, pattern.flags);
    const replace = string(rule.replaceString, string(rule.replacement));
    result = result.replace(regex, (...args) => {
      const groups = typeof args.at(-1) === 'object' ? args.pop() : {};
      const input = args.pop();
      const offset = args.pop();
      const trimmed = args.map(value => cleanStrings(rule.trimStrings).reduce((text, trim) => trim ? text.split(trim).join('') : text, value || ''));
      return replace.replace(/\{\{match\}\}|\$([$&`']|\d{1,2}|<[^>]+>)/g, (token, code) => {
        if (token === '{{match}}' || code === '&') return trimmed[0];
        if (code === '$') return '$';
        if (code === '`') return input.slice(0, offset);
        if (code === "'") return input.slice(offset + args[0].length);
        if (code?.startsWith('<')) return groups[code.slice(1,-1)] ?? token;
        const index = Number(code);
        if (index > 0 && index < trimmed.length) return trimmed[index];
        if (code.length === 2 && Number(code[0]) > 0 && Number(code[0]) < trimmed.length) return trimmed[Number(code[0])] + code[1];
        return token;
      });
    });
    if (result.length > MAX_TEXT) throw new Error('Regex-результат превышает лимит 1 МБ.');
  }
  return result;
}

// Run imported patterns in an isolated worker, so catastrophic backtracking cannot freeze the API.
export async function applyRegex(text, rules = [], placement = 'output', options = {}) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('Текст Regex должен быть строкой до 1 МБ.');
  if (!Array.isArray(rules) || !rules.some(rule => !rule.disabled && rule.enabled !== false)) return text;
  return new Promise((resolve, reject) => {
    // Preserve the Windows workspace path resolution mode used by the desktop launcher.
    // The flags are harmless on normal Node installations and keep worker_threads
    // from failing when the project path is behind a sandboxed junction.
    const worker = new Worker(new URL(import.meta.url), {workerData:{sasRegex:true, text, rules:rules.slice(0,100), placement, options:{depth:0, ...options}}, resourceLimits:{maxOldGenerationSizeMb:64, maxYoungGenerationSizeMb:16}, execArgv:['--preserve-symlinks','--preserve-symlinks-main']});
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Regex остановлен: превышен лимит выполнения 750 мс. Проверьте правила.')); }, 750);
    const done = () => { clearTimeout(timer); worker.terminate(); };
    worker.once('message', message => { done(); message.error ? reject(new Error(message.error)) : resolve(message.text); });
    worker.once('error', error => { done(); reject(new Error(`Ошибка Regex: ${error.message}`)); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Regex-процесс остановлен. Проверьте сложность правил.')); });
  });
}

if (!isMainThread && workerData?.sasRegex) {
  try { parentPort.postMessage({text:runRegex(workerData)}); }
  catch (error) { parentPort.postMessage({error:error.message}); }
}

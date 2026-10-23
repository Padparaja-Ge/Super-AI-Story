import {validMemory} from './memory.mjs';
export const estimateTokens = text => Math.ceil(String(text || '').length / 3);
export const messageTokens = messages => messages.reduce((sum, message) => sum + estimateTokens(message.content) + 6, 3);
const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));

export function macros(text, character, settings) {
  return String(text || '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '').replace(/\{\{trim\}\}/gi, '').replace(/\{\{char\}\}/gi, character?.name || 'Персонаж').replace(/\{\{user\}\}/gi, settings?.userName || 'Пользователь');
}

export function selectLore(state, chat, content = '', options = {}) {
  const scanDepth = number(chat.memorySettings?.scanDepth ?? state.settings?.scanDepth, 6, 1, 100);
  const scan = [...chat.messages.filter(m=>m.interruptionReason!=='repetition').slice(-scanDepth).map(message => message.content), content].join('\n');
  const budget = number(chat.memorySettings?.loreBudget ?? state.settings?.loreBudget, 1600, 0, 100000);
  const character = state.characters.find(item => item.id === chat.characterId);
  const bookIds = Array.isArray(chat.lorebookIds) ? chat.lorebookIds : character?.lorebookIds || [];
  const candidates = state.lorebooks.filter(book => bookIds.includes(book.id)).flatMap(book => (book.entries || []).filter(entry => {
    if (entry.enabled === false || !String(entry.content || '').trim()) return false;
    if (entry.constant) return true;
    if(entry.vectorized&&options.vectorLoreIds!==undefined)return options.vectorLoreIds.includes(entry.id);
    const source = entry.caseSensitive ? scan : scan.toLocaleLowerCase();
    const keys = Array.isArray(entry.keys) ? entry.keys : String(entry.keys || '').split(',');
    const matches = keys.some(key => String(key).trim() && source.includes(entry.caseSensitive ? String(key).trim() : String(key).trim().toLocaleLowerCase()));
    const secondary = entry.secondaryKeys || entry.secondary_keys || [];
    return matches && (!entry.selective || !secondary.length || secondary.some(key => source.includes(entry.caseSensitive ? String(key) : String(key).toLocaleLowerCase())));
  })).sort((a, b) => Number(b.priority ?? b.insertion_order ?? 0) - Number(a.priority ?? a.insertion_order ?? 0));
  let used = 0;
  const selected = [];
  for (const entry of candidates) {
    const cost = estimateTokens(`${entry.name}: ${entry.content}`) + 4;
    if (used + cost <= budget) { selected.push(entry); used += cost; }
  }
  return { selected, used, budget };
}

function presetInstructions(preset, blocks) {
  if (!preset) return [];
  const prompts = preset.prompts || [];
  const rawOrder = preset.promptOrder || preset.prompt_order || [];
  const order = Array.isArray(rawOrder) ? (rawOrder.find(item => item.character_id === 100001)?.order || rawOrder.find(item => Array.isArray(item.order))?.order || rawOrder) : [];
  const arranged = order.length ? order.filter(item => item.enabled !== false).map(item => prompts.find(prompt => prompt.identifier === item.identifier)).filter(Boolean) : prompts.filter(prompt => prompt.enabled !== false);
  const messages = [];
  for (const prompt of arranged) {
    const markerContent = blocks[prompt.identifier];
    const content = prompt.marker ? markerContent : prompt.content;
    if (content?.trim()) messages.push({ role: ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system', content });
  }
  if (!prompts.length && preset.systemPrompt) messages.push({ role: 'system', content: preset.systemPrompt });
  return messages;
}

export function buildPrompt(state, chatId, content = '', options = {}) {
  const chat = state.chats.find(item => item.id === chatId);
  if (!chat) throw new Error('Чат не найден.');
  const character = state.characters.find(item => item.id === chat.characterId);
  if (!character) throw new Error('Персонаж чата не найден.');
  const connection = state.connections.find(item => item.id === (chat.connectionId || state.activeConnectionId));
  if (!connection) throw new Error('Выберите подключение к модели.');
  const preset = state.presets?.find(item => item.id === (chat.presetId || state.activePresetId));
  const persona = state.personas?.find(p => p.id === (chat.personaId || character.personaId));
  const settings = { ...state.settings, ...chat.memorySettings, userName:persona?.name || state.settings?.userName };
  const expand = text => macros(text, character, settings);
  // Game retrieval already contains bounded excerpts. Re-inserting whole lore
  // entries or summary blocks here defeats both relevance and the RAG cap.
  const lore = options.gameRag ? {selected:[],used:0,budget:0} : selectLore(state, chat, content, options);
  const sections = {
    charDescription: [character.description, character.appearance && `Внешность: ${character.appearance}`, ...(character.blocks || []).filter(block => block.enabled !== false).map(block => `${block.name}: ${block.content}`)].filter(Boolean).join('\n\n'),
    charPersonality: character.personality && `Личность: ${character.personality}`,
    scenario: character.scenario && `Сценарий: ${character.scenario}`,
    dialogueExamples: character.exampleDialogue && `Примеры диалогов:\n${character.exampleDialogue}`,
    worldInfoBefore: lore.selected.map(entry => `${entry.name}: ${entry.content}`).join('\n\n'),
    worldInfoAfter: '',
    personaDescription: `Персона игрока: ${settings.userName || 'Пользователь'}.\n${persona ? [persona.description,persona.appearance && 'Внешность: '+persona.appearance,persona.personality && 'Характер: '+persona.personality].filter(Boolean).join('\n') : ''}\nНе управляй действиями и решениями игрока.`,
    main: character.systemPrompt,
    jailbreak: character.postHistoryInstructions,
  };
  const presetMessages = presetInstructions(preset, sections);
  const usedMarkers = new Set((preset?.prompts || []).filter(prompt => prompt.marker && presetMessages.some(message => message.content === sections[prompt.identifier])).map(prompt => prompt.identifier));
  const baseSections = Object.entries(sections).filter(([key, value]) => value && !usedMarkers.has(key) && key !== 'jailbreak').map(([, value]) => value);
  if (options.extraInstructions) baseSections[options.extraFirst?'unshift':'push'](options.extraInstructions);
  const narrative = settings.narrative || {};
  const modes = { roleplay: 'Играй роль одного персонажа; не управляй персонажем пользователя', writer: 'Пиши художественный текст как автор, развивая сюжет и сохраняя стиль персонажей', gamemaster: 'Веди игру: описывай мир и NPC; решения за персонажа игрока принимает пользователь', conversation: 'Разговор', game: 'Игра с ведущим' };
  const tenses = { present: 'настоящее', past: 'прошедшее' };
  const perspectives = { first: 'первое лицо', second: 'второе лицо', third: 'третье лицо' };
  const lengths = { short: 'до 150 слов', medium: '150–300 слов', long: 'подробные ответы от 300 слов' };
  baseSections.push(`Режим: ${modes[narrative.mode] || narrative.mode || 'Ролевая история'}. Время: ${tenses[narrative.tense] || narrative.tense || 'настоящее'}. Повествование: ${perspectives[narrative.perspective] || narrative.perspective || 'третье лицо'}. Длина: ${lengths[narrative.length] || narrative.length || 'средняя'}.`, narrative.instructions || '');
  const memoryMode = settings.memoryMode || 'hybrid';
  if (!options.gameRag && ['hybrid', 'pinned', 'full', 'manual', 'summary'].includes(memoryMode)) {
    if (memoryMode !== 'summary') {
      const categories = { facts: 'Факты и состояние', relationships: 'Отношения', episodes: 'Эпизоды', diary: 'Дневник' };
      const availableMemory=validMemory(chat).filter(m=>!['pinned','manual'].includes(memoryMode)||!m.automatic),recent=availableMemory.filter(m=>m.automatic).slice(-2).map(m=>m.id);
      const query=[...chat.messages.slice(-3).map(m=>m.content),content].join(' ').toLocaleLowerCase(),words=[...new Set(query.match(/[\p{L}\p{N}]{4,}/gu)||[])];
      const ranked=availableMemory.map(m=>({m,score:!m.automatic?1000:recent.includes(m.id)?900:options.memoryIds?.includes(m.id)?800-options.memoryIds.indexOf(m.id):words.reduce((n,w)=>n+(m.content.toLocaleLowerCase().includes(w)?1:0),0)})).filter(({m,score})=>options.memoryIds!==undefined?recent.includes(m.id)||options.memoryIds.includes(m.id):!m.automatic||recent.includes(m.id)||score>0).sort((a,b)=>b.score-a.score);
      let left=Math.max(0,Math.min(Number(settings.memoryBudget)||1200,Math.floor((Number(connection.contextWindow)||8192)/4))),chosen=[];
      for(const {m} of ranked){if(left<30)break;const text=m.content.slice(0,left*3);chosen.push({...m,content:text});left-=estimateTokens(text)+10;}
      const memories=chosen.sort((a,b)=>(a.order??-1)-(b.order??-1)).map(item=>`${item.title||categories[item.category]||categories.facts}: ${item.content}`);
      if (memories.length) baseSections.push(`Закреплённая память:\n${memories.join('\n')}`);
    }
    if (memoryMode !== 'pinned' && memoryMode !== 'manual' && chat.summary&&(memoryMode==='summary'||!validMemory(chat).some(m=>m.automatic))) baseSections.push(`Сводка предыдущих событий:\n${chat.summary.slice(0,Math.min(4000,(Number(connection.contextWindow)||8192)*0.6))}`);
  }

  if (state.plugins?.some(plugin => plugin.id === 'rpg' && plugin.enabled) && chat.scene) {
    const rpg = chat.scene;
    baseSections.push(`Состояние сцены:\nМесто: ${rpg.location || ''}\nВремя: ${rpg.time || ''}\nПогода: ${rpg.weather || ''}\nЗаметки: ${rpg.notes || ''}\n${(rpg.stats || []).map(stat => `${stat.name}: ${stat.value}/${stat.max}`).join(', ')}`);
  }
  for (const plugin of state.plugins || []) {
    if (plugin.enabled && !plugin.builtin && typeof plugin.prompt === 'string' && plugin.prompt.trim()) baseSections.push(`Расширение ${plugin.name}:\n${plugin.prompt}`);
  }
  const prefix = [...presetMessages.map(message => ({ ...message, content: expand(message.content) })), { role: 'system', content: expand(baseSections.filter(Boolean).join('\n\n')) }].filter(message => message.content.trim());
  const historyLimit = number(settings.historyLimit, 30, 0, 500);
  const history = (options.historyMessages ?? (historyLimit ? chat.messages.slice(-historyLimit) : [])).filter(message => ['user', 'assistant'].includes(message.role) && message.content && message.interruptionReason!=='repetition').map(message => ({ role: message.role, content: expand(message.content) }));
  const tail = [];
  if(options.tailInstructions)tail.push({role:'system',content:options.tailInstructions});
  if(options.sourceExcerpts?.length)tail.push({role:'system',content:'Исходные события ЭТОЙ истории (архив, не новые действия):\n'+options.sourceExcerpts.map(s=>`[Сообщение ${s.index+1}] ${s.text}`).join('\n\n')+'\nИспользуй эти подтверждённые факты для ответа. Если сводка противоречит исходному событию, верь исходному событию. Если ответа нет, не выдумывай его.'});
  if (content?.trim()) tail.push({ role: 'user', content: expand(content.trim()) });
  if (character.postHistoryInstructions && !usedMarkers.has('jailbreak')) tail.push({ role: 'system', content: expand(character.postHistoryInstructions) });
  const contextWindow = number(connection.contextWindow, 8192, 256, 2000000);
  const maxTokens = number(preset?.maxTokens ?? connection.maxTokens, 1024, 1, options.compact?Math.floor(contextWindow/2):contextWindow-1);
  const available = Math.min(contextWindow - maxTokens,Number(options.inputBudget)||contextWindow);
  let droppedMessages = Math.max(0, chat.messages.length - history.length);
  if(options.compact&&!options.gameRag){
    // Keep the continuation instruction even when a card contains a huge post-history block.
    let tailChars=Math.max(0,(Math.floor(available/3)-tail.length*7)*3);
    for(const m of tail){m.content=m.content.slice(0,tailChars);tailChars=Math.max(0,tailChars-m.content.length);}
  }
  if(options.compact&&!options.gameRag&&messageTokens([...prefix,...tail])>available-100){
    let chars=Math.max(0,(available-messageTokens(tail)-Math.min(256,Math.floor(available/4))-prefix.length*7)*3);
    for(const m of prefix){m.content=m.content.slice(0,chars);chars=Math.max(0,chars-m.content.length);}
  }
  if(options.preserveHistory&&!options.gameRag&&messageTokens([...prefix,...history,...tail])>available){
    let chars=Math.max(0,(available-messageTokens([...history,...tail])-prefix.length*7-20)*3);
    for(const m of prefix){m.content=m.content.slice(0,chars);chars=Math.max(0,chars-m.content.length);}
  }
  while (history.length>(options.compact?1:0) && messageTokens([...prefix, ...history, ...tail]) > available) { history.shift(); droppedMessages++; }
  if(options.compact&&history.length&&messageTokens([...prefix,...history,...tail])>available){const chars=Math.max(0,(available-messageTokens([...prefix,...tail])-8)*3);history[0].content=history[0].content.slice(-chars);if(!chars)history.pop();}
  const messages = [...prefix, ...history, ...tail];
  const estimatedTokens = messageTokens(messages);
  if (estimatedTokens > available && !options.allowOverflow && !options.gameRag) throw new Error(`Промпт (~${estimatedTokens} токенов) превышает доступный контекст ${available}. Сократите карточку, память или лор, либо увеличьте контекст подключения. Оценка приблизительная.`);
  return { messages, estimatedTokens, activeLore: lore.selected.map(entry => ({ id: entry.id, name: entry.name })), budget: { contextWindow, maxTokens, available, loreBudget: lore.budget, loreUsed: lore.used }, breakdown: { instructions: messageTokens(prefix), history: messageTokens(history), newMessage: messageTokens(tail), droppedMessages, estimate: 'Приблизительно: 1 токен на 3 символа; точное число зависит от модели.' } };
}

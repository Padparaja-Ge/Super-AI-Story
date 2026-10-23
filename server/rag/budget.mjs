import { calculateTokenBudget } from './tokens.mjs';
export const MAX_RAG_TOKENS = 1500;
export const MAX_RAG_CHUNKS = 3;
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number.isFinite(value) ? value : fallback)));
/** Metadata is quoted as data; book text never becomes the system instruction. */
export function formatRagChunk(chunk) {
    return JSON.stringify({ id: chunk.id, source: chunk.metadata.source, type: chunk.metadata.type,
        ...(chunk.metadata.name ? { name: chunk.metadata.name } : {}),
        ...(chunk.metadata.kind ? { kind: chunk.metadata.kind } : {}), content: chunk.content });
}
export function formatRag(chunks) {
    return chunks.length ? '[SAS_RAG_SOURCES]\n' + chunks.map(formatRagChunk).join('\n') : '';
}
export function selectRagChunks(results, options = {}) {
    const count = options.countTokens || calculateTokenBudget;
    const limit = integer(options.maxTokens, MAX_RAG_TOKENS, 0, MAX_RAG_TOKENS);
    const max = integer(options.maxChunks, MAX_RAG_CHUNKS, 0, MAX_RAG_CHUNKS);
    const loreLimit = integer(options.maxLoreTokens, MAX_RAG_TOKENS, 0, MAX_RAG_TOKENS), memoryLimit = integer(options.maxMemoryTokens, MAX_RAG_TOKENS, 0, MAX_RAG_TOKENS);
    const isMemory = (chunk) => chunk.metadata.kind === 'memory' || chunk.metadata.kind === 'source';
    const chunks = [], ids = new Set(), contents = new Set();
    for (const result of results) {
        if (chunks.length >= max)
            break;
        const chunk = result.chunk;
        if (!chunk?.content?.trim() || ids.has(chunk.id) || contents.has(chunk.content.trim()))
            continue;
        const proposed = [...chunks, chunk];
        const category = proposed.filter(candidate => isMemory(candidate) === isMemory(chunk));
        if (count(formatRag(category)) > (isMemory(chunk) ? memoryLimit : loreLimit))
            continue;
        // Count wrappers, names and separators as well as the actual excerpt.
        if (count(formatRag(proposed)) > limit)
            continue;
        chunks.push(chunk);
        ids.add(chunk.id);
        contents.add(chunk.content.trim());
    }
    const text = formatRag(chunks);
    return { chunks, tokens: text ? count(text) : 0, text };
}
const renderMessage = (message) => JSON.stringify({ role: message.role, content: message.content });
const renderHistory = (messages) => messages.length
    ? '[SAS_RECENT_MESSAGES]\n' + messages.map(renderMessage).join('\n') : '';
/**
 * Pure assembly, with no model call. The system text is preserved byte-for-byte.
 * A required state/latest post that cannot fit raises instead of silently losing canon.
 */
export function assemblePromptDetailed(context) {
    const count = context.countTokens || calculateTokenBudget;
    if (typeof context.systemPrompt !== 'string' || !context.sceneState || !Array.isArray(context.recentMessages))
        throw new TypeError('Неверный контекст промпта.');
    const window = integer(context.maxContextTokens, 8192, 256, 2_000_000);
    const output = integer(context.responseTokens, Math.min(1024, Math.floor(window / 2)), 1, window - 1);
    const safety = integer(context.safetyTokens, Math.min(128, Math.floor(window / 16)), 0, window - output);
    const available = window - output - safety;
    const stateText = '[SAS_SCENE_STATE]\n' + JSON.stringify(context.sceneState);
    const base = context.systemPrompt + '\n\n' + stateText;
    if (count(base) > available)
        throw Object.assign(new Error('Системный промпт и состояние сцены не помещаются в контекст.'), { code: 'RAG_CONTEXT_REQUIRED' });
    const source = context.recentMessages.filter(m => ['user', 'assistant'].includes(m.role) && m.content?.trim());
    const history = [];
    const historyLimit = integer(context.historyTokens, 800, 0, available);
    for (let i = source.length - 1; i >= 0; i--) {
        const candidate = [source[i], ...history];
        const historyText = renderHistory(candidate);
        const cost = count(base + '\n\n' + historyText);
        if (cost > available) {
            if (!history.length)
                throw Object.assign(new Error('Последнее сообщение и обязательное состояние не помещаются в контекст.'), { code: 'RAG_CONTEXT_REQUIRED' });
            break;
        }
        // The latest post is always kept, even if it exceeds the preferred history share.
        if (history.length && count(historyText) > historyLimit)
            break;
        history.unshift(source[i]);
    }
    const historyText = renderHistory(history);
    const required = base + (historyText ? '\n\n' + historyText : '');
    const rag = selectRagChunks(context.ragResults || [], {
        maxTokens: Math.min(integer(context.maxRagTokens, MAX_RAG_TOKENS, 0, MAX_RAG_TOKENS), Math.max(0, available - count(required) - 8)),
        maxChunks: context.maxRagChunks, maxLoreTokens: context.maxLoreTokens, maxMemoryTokens: context.maxMemoryTokens, countTokens: count,
    });
    while (rag.chunks.length && count(required + '\n\n' + formatRag(rag.chunks)) > available)
        rag.chunks.pop();
    const ragText = formatRag(rag.chunks);
    const prompt = required + (ragText ? '\n\n' + ragText : '');
    const messages = [{ role: 'system', content: context.systemPrompt }, { role: 'user', content: stateText }, ...history];
    if (ragText)
        messages.push({ role: 'user', content: ragText });
    return { prompt, messages, selectedChunks: rag.chunks, tokens: count(prompt),
        ragTokens: ragText ? count(ragText) : 0, historyTokens: historyText ? count(historyText) : 0,
        omittedMessages: source.length - history.length };
}
export function assemblePrompt(context) { return assemblePromptDetailed(context).prompt; }
/** Existing SAS pipeline already supplies protected system/state/current posts. */
export function budgetGameMessages(input) {
    if (!Number.isInteger(input.maxInputTokens) || input.maxInputTokens <= 0 || input.maxInputTokens > 2_000_000)
        throw new RangeError('Лимит входного контекста должен быть конечным положительным целым числом.');
    const count = input.countTokens || calculateTokenBudget;
    // Chat framing reserve is counted even for API providers without /tokenize.
    const measure = (messages) => 3 + messages.reduce((sum, m) => sum + count(m.content) + 8, 0);
    const required = [...input.systemMessages, ...input.requiredMessages].map(m => ({ ...m }));
    if (measure(required) > input.maxInputTokens)
        throw Object.assign(new Error(`Инструкции, состояние и действия игроков не помещаются в контекст (${measure(required)} > ${input.maxInputTokens} токенов). Увеличьте контекст или сократите обязательные данные.`), { code: 'RAG_CONTEXT_REQUIRED' });
    const recent = (input.recentMessages || []).map(m => ({ ...m }));
    while (recent.length && measure([...input.systemMessages, ...recent, ...input.requiredMessages]) > input.maxInputTokens)
        recent.shift();
    const base = [...input.systemMessages, ...recent];
    const room = input.maxInputTokens - measure([...base, ...input.requiredMessages]);
    const rag = selectRagChunks(input.ragResults, { maxTokens: Math.min(room - 8, input.maxRagTokens ?? MAX_RAG_TOKENS), maxLoreTokens: input.maxLoreTokens, maxMemoryTokens: input.maxMemoryTokens, countTokens: count });
    const build = () => [...base, ...(rag.chunks.length ? [{ role: 'user', content: formatRag(rag.chunks) }] : []), ...input.requiredMessages];
    while (rag.chunks.length && measure(build()) > input.maxInputTokens)
        rag.chunks.pop();
    const messages = build(), text = formatRag(rag.chunks);
    return { messages, selectedChunks: rag.chunks, tokens: measure(messages), ragTokens: text ? count(text) : 0,
        omittedMessages: (input.recentMessages?.length || 0) - recent.length };
}

export type EntityType = 'npc' | 'location' | 'spell' | 'item' | 'lore' | 'quest';
export interface ChunkMetadata {
    type: EntityType;
    name?: string;
    tags: string[];
    source: string;
    scope?: string;
    documentId?: string;
    sourceHash?: string;
    kind?: 'lore' | 'memory' | 'source';
    messageId?: string;
    role?: string;
    index?: number;
    start?: number;
    end?: number;
    vectorized?: boolean;
    priority?: number;
    segmentation?: 'sentence' | 'word' | 'codepoint';
    bookId?: string;
    entryId?: string;
    memoryId?: string;
    messageKind?: string;
    automatic?: boolean;
    tokenization?: 'native' | 'approximate';
    nativeTokenLimit?: number;
}
export interface Chunk {
    id: string;
    content: string;
    embedding?: number[];
    metadata: ChunkMetadata;
}
export interface ChunkOptions {
    maxTokens?: number;
    modelTokenLimit?: number;
    overlap?: number;
    source?: string;
    documentId?: string;
    scope?: string;
    lorebookType?: string;
    metadata?: Partial<ChunkMetadata>;
    countTokens?: (text: string) => number;
}
export interface SceneState {
    currentLocation?: string;
    presentNPCs: string[];
    activeQuests: string[];
    [key: string]: unknown;
}
export interface SearchResult {
    chunk: Chunk;
    vectorScore: number;
    keywordScore: number;
    finalScore: number;
}
export interface SearchOptions {
    chunks: readonly Chunk[];
    embed?: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
    type?: EntityType | EntityType[];
    scope?: string;
    topK?: number;
    vectorTopK?: number;
    keywordTopK?: number;
    vectorThreshold?: number;
    signal?: AbortSignal;
    onVectorError?: (error: unknown) => void;
}
export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
    id?: string;
}
export interface PromptContext {
    systemPrompt: string;
    sceneState: SceneState;
    recentMessages: Message[];
    ragResults: SearchResult[];
    maxContextTokens?: number;
    responseTokens?: number;
    safetyTokens?: number;
    maxRagTokens?: number;
    maxRagChunks?: number;
    maxLoreTokens?: number;
    maxMemoryTokens?: number;
    historyTokens?: number;
    countTokens?: (text: string) => number;
}
export interface PromptAssembly {
    prompt: string;
    messages: Message[];
    selectedChunks: Chunk[];
    tokens: number;
    ragTokens: number;
    historyTokens: number;
    omittedMessages: number;
}
export interface ParsedResponse {
    thinking: string;
    action_required: 'roll_dice' | 'update_state' | 'none';
    action_params: {
        formula?: string;
        target?: string;
        reason?: string;
        field?: string;
        value?: unknown;
    };
    narrative_text: string;
}
export interface ActionResult {
    success: boolean;
    result?: unknown;
    error?: string;
    narrative_text: string;
}
export interface GameEngine {
    rollDice(params: ParsedResponse['action_params']): unknown;
    updateState(params: ParsedResponse['action_params']): unknown;
}

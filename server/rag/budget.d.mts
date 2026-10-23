import type { Chunk, Message, PromptAssembly, PromptContext, SearchResult } from './types.mjs';
export declare const MAX_RAG_TOKENS = 1500;
export declare const MAX_RAG_CHUNKS = 3;
/** Metadata is quoted as data; book text never becomes the system instruction. */
export declare function formatRagChunk(chunk: Chunk): string;
export declare function formatRag(chunks: readonly Chunk[]): string;
export declare function selectRagChunks(results: readonly SearchResult[], options?: {
    maxTokens?: number;
    maxChunks?: number;
    maxLoreTokens?: number;
    maxMemoryTokens?: number;
    countTokens?: (text: string) => number;
}): {
    chunks: Chunk[];
    tokens: number;
    text: string;
};
/**
 * Pure assembly, with no model call. The system text is preserved byte-for-byte.
 * A required state/latest post that cannot fit raises instead of silently losing canon.
 */
export declare function assemblePromptDetailed(context: PromptContext): PromptAssembly;
export declare function assemblePrompt(context: PromptContext): string;
/** Existing SAS pipeline already supplies protected system/state/current posts. */
export declare function budgetGameMessages(input: {
    systemMessages: Message[];
    requiredMessages: Message[];
    recentMessages?: Message[];
    ragResults: SearchResult[];
    maxInputTokens: number;
    maxRagTokens?: number;
    maxLoreTokens?: number;
    maxMemoryTokens?: number;
    countTokens?: (text: string) => number;
}): {
    messages: Message[];
    selectedChunks: Chunk[];
    tokens: number;
    ragTokens: number;
    omittedMessages: number;
};

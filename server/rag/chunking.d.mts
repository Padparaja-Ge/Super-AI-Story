import type { Chunk, ChunkMetadata, ChunkOptions } from './types.mjs';
export type AsyncChunkOptions = Omit<ChunkOptions, 'countTokens'> & {
    countTokens: (text: string) => Promise<number>;
    signal?: AbortSignal;
};
/** Conservative lexical heuristics, not a claim of full named-entity recognition. */
export declare function extractMetadata(text: string, lorebookType?: string): Partial<ChunkMetadata>;
/** Semantic, lossless source slices with bounded sentence overlap. */
export declare function chunkLorebook(text: string, options?: ChunkOptions): Chunk[];
export declare const semanticChunkLorebook: typeof chunkLorebook;
/** Same splitting policy using the active embedding model's native tokenizer. */
export declare function chunkLorebookAsync(text: string, options: AsyncChunkOptions): Promise<Chunk[]>;

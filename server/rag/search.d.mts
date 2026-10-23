import type { SceneState, SearchOptions, SearchResult } from './types.mjs';
export declare function rerankResults(vectorResults: SearchResult[], keywordResults: SearchResult[], scene: SceneState): SearchResult[];
/** Scope/type-filtered, independent BM25 + cosine retrieval and deterministic reranking. */
export declare function hybridSearch(query: string, scene: SceneState, options: SearchOptions): Promise<SearchResult[]>;

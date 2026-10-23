import type { Chunk, SceneState, SearchOptions, SearchResult } from './types.mjs';

function terms(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').match(/[\p{L}\p{N}_]+/gu) || [];
}
function phrase(text: string): string { return terms(text).join(' '); }
function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    value.some(n => n !== 0);
}
function cosine(left: number[], right: unknown): number {
  if (!validVector(right) || left.length !== right.length) return 0;
  // Scale before taking products so finite, very large vector entries cannot
  // overflow their norm and very small entries cannot underflow it to zero.
  const leftScale = left.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const rightScale = right.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  let product = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] / leftScale, b = right[index] / rightScale;
    product += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const result = product / Math.sqrt(leftNorm * rightNorm);
  return Number.isFinite(result) ? Math.max(0, Math.min(1, result)) : 0;
}
function countOption(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(100, Math.floor(value)));
}
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'));
}
function sceneEntities(scene: SceneState): string[] {
  return [...new Set([scene.currentLocation, ...(scene.presentNPCs || []), ...(scene.activeQuests || [])]
    .filter((value): value is string => typeof value === 'string').map(phrase).filter(Boolean))];
}
function entityMatches(chunk: Chunk, entities: string[]): boolean {
  const name = phrase(chunk.metadata.name || '');
  // Only the entity identity earns the scene bonus. An unrelated record that
  // merely mentions a present NPC in its prose must not receive that bonus.
  return !!name && entities.some(entity => ` ${entity} `.includes(` ${name} `));
}

const normalizedScore = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export function rerankResults(vectorResults: SearchResult[], keywordResults: SearchResult[], scene: SceneState): SearchResult[] {
  const combined = new Map<string, SearchResult>(), entities = sceneEntities(scene);
  for (const result of [...vectorResults, ...keywordResults]) {
    if (!result?.chunk?.id) continue;
    const previous = combined.get(result.chunk.id);
    combined.set(result.chunk.id, {chunk: previous?.chunk || result.chunk,
      vectorScore:Math.max(previous?.vectorScore || 0, normalizedScore(result.vectorScore)),
      keywordScore:Math.max(previous?.keywordScore || 0, normalizedScore(result.keywordScore)), finalScore:0});
  }
  return [...combined.values()].map(result => ({...result, finalScore:
    .6 * result.vectorScore + .4 * result.keywordScore + .2 * (entityMatches(result.chunk, entities) ? .2 : 0)
  })).sort((a,b) => b.finalScore - a.finalScore);
}

function keywordScores(chunks: Chunk[], query: string): number[] {
  const queryTerms = [...new Set(terms(query))];
  if (!queryTerms.length) return chunks.map(() => 0);
  const documents = chunks.map(chunk => terms([chunk.metadata.name || '', ...chunk.metadata.tags, chunk.content].join(' ')));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1) || 1;
  const frequencies = documents.map(document => {
    const result = new Map<string, number>();
    for (const term of document) result.set(term, (result.get(term) || 0) + 1);
    return result;
  });
  const documentFrequency = new Map(queryTerms.map(term => [term, frequencies.reduce((sum, document) => sum + (document.has(term) ? 1 : 0), 0)]));
  const k1 = 1.2, b = .75;
  const scores = frequencies.map((document, index) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = document.get(term) || 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term)!;
      const inverseFrequency = Math.log(1 + (chunks.length - df + .5) / (df + .5));
      score += inverseFrequency * frequency * (k1 + 1) /
        (frequency + k1 * (1 - b + b * documents[index].length / averageLength));
    }
    return Number.isFinite(score) ? score : 0;
  });
  const maximum = scores.reduce((maximum, score) => Math.max(maximum, score), 0);
  return maximum ? scores.map(score => score / maximum) : scores;
}

/** Scope/type-filtered, independent BM25 + cosine retrieval and deterministic reranking. */
export async function hybridSearch(query: string, scene: SceneState, options: SearchOptions): Promise<SearchResult[]> {
  options.signal?.throwIfAborted();
  const outputLimit = countOption(options.topK, 10);
  const keywordLimit = countOption(options.keywordTopK, 10);
  const vectorLimit = countOption(options.vectorTopK, 10);
  if (!outputLimit) return [];
  const allowedTypes = options.type === undefined ? undefined : new Set(Array.isArray(options.type) ? options.type : [options.type]);
  const seenIds = new Set<string>();
  // Room scope is enforced before even computing document frequencies or
  // passing any content to an embedding callback.
  const chunks = options.chunks.filter(chunk => {
    if (options.scope !== undefined && chunk.metadata.scope !== options.scope) return false;
    if (allowedTypes && !allowedTypes.has(chunk.metadata.type)) return false;
    if (seenIds.has(chunk.id)) return false;
    seenIds.add(chunk.id);
    return true;
  });
  if (!chunks.length) return [];
  const keyword = keywordLimit ? keywordScores(chunks, query) : chunks.map(() => 0);
  const vector = chunks.map(() => 0);
  const eligible = chunks.flatMap((chunk, index) => chunk.metadata.vectorized === false ? [] : [index]);
  if (options.embed && vectorLimit && eligible.length) {
    const missing = eligible.filter(index => !validVector(chunks[index].embedding));
    try {
      // Exactly one request per search, including the query even when all
      // document vectors were cached. Lexical-only chunks never enter it.
      const embedded = await options.embed([query, ...missing.map(index => chunks[index].content)], options.signal);
      options.signal?.throwIfAborted();
      if (!Array.isArray(embedded) || embedded.length !== missing.length + 1 || !validVector(embedded[0])) {
        throw new TypeError('The embedding provider returned an invalid query vector or batch.');
      }
      const supplied = new Map(missing.map((index, position) => [index, embedded[position + 1]]));
      for (const index of eligible) vector[index] = cosine(embedded[0], supplied.get(index) ?? chunks[index].embedding);
    } catch (error) {
      if (isAbort(error, options.signal)) {
        options.signal?.throwIfAborted();
        throw error;
      }
      // This observer must not turn an available lexical search into a failure.
      try { options.onVectorError?.(error); } catch { /* optional diagnostics */ }
    }
  }
  options.signal?.throwIfAborted();
  const threshold = Number.isFinite(options.vectorThreshold) ? Math.max(0, Math.min(1, options.vectorThreshold!)) : 0;
  const byScore = (scores: number[]) => (a: number, b: number) => scores[b] - scores[a] || a - b;
  const indices = chunks.map((_, index) => index);
  const keywordCandidates = indices.filter(index => keyword[index] > 0).sort(byScore(keyword)).slice(0, keywordLimit);
  const vectorCandidates = indices.filter(index => vector[index] > 0 && vector[index] >= threshold)
    .sort(byScore(vector)).slice(0, vectorLimit);
  const entry = (index:number): SearchResult => ({chunk:chunks[index],vectorScore:vector[index],keywordScore:keyword[index],finalScore:0});
  return rerankResults(vectorCandidates.map(entry), keywordCandidates.map(entry), scene).slice(0,outputLimit);
}

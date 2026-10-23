import { createRequire } from 'node:module';
import type { Tiktoken as Tokenizer, TiktokenBPE } from 'js-tiktoken/lite';

const require = createRequire(import.meta.url);
let encoder: Tokenizer | undefined;
const cache = new Map<string, number>();
let cachedCharacters = 0;
const MAX_ENTRIES = 256;
const MAX_CHARACTERS = 262_144;
const MAX_ENTRY_CHARACTERS = 16_384;

function tokenizer(): Tokenizer {
  if (!encoder) {
    // Loading the rank table and constructing the encoder costs time. Neither is
    // needed while the application is simply starting up.
    const { Tiktoken } = require('js-tiktoken/lite') as typeof import('js-tiktoken/lite');
    const ranks = require('js-tiktoken/ranks/cl100k_base') as TiktokenBPE;
    encoder = new Tiktoken(ranks);
  }
  return encoder;
}

/** Count literal text with cl100k_base; this is a count, not a context limit. */
export function calculateTokenBudget(text: string): number {
  if (typeof text !== 'string') throw new TypeError('Token counting requires a string.');
  if (!text) return 0;
  const cached = cache.get(text);
  if (cached !== undefined) {
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }
  // Scene/lore text may contain strings such as <|endoftext|>. Count them as
  // ordinary text, never as an instruction to the tokenizer.
  const result = tokenizer().encode(text, [], []).length;
  if (text.length <= MAX_ENTRY_CHARACTERS) {
    cache.set(text, result);
    cachedCharacters += text.length;
    while (cache.size > MAX_ENTRIES || cachedCharacters > MAX_CHARACTERS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
      cachedCharacters -= oldest.length;
    }
  }
  return result;
}

// Each piece includes its original boundary whitespace. Surrogate pairs stay intact.
export function splitTranslation(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new Error('Invalid translation chunk limit');
  const chunks = [];
  while (text.length > maxChars) {
    const candidate = text.slice(0, maxChars);
    const sentences = [...candidate.matchAll(/[.!?。！？]["'»”)]*\s+|\n+/gu)];
    let end = sentences.length ? sentences.at(-1).index + sentences.at(-1)[0].length : 0;
    if (!end) {
      const whitespace = [...candidate.matchAll(/\s+/gu)].at(-1);
      end = whitespace ? whitespace.index + whitespace[0].length : maxChars;
    }
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

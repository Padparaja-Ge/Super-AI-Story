import { TranslationProvider } from './translationProvider.js';
import { TranslationError, providerError } from '../services/translationErrors.js';
import { batchTranslate } from 'google-translate-api-x';

export class GoogleProvider extends TranslationProvider {
  constructor(config) { super('google', { maxChars: 1000, ...config }); this.mode = config?.mode || 'batch'; }
  async translate(text, sourceLang, targetLang, { signal } = {}) {
    this.validate(text, sourceLang, targetLang);
    const url = this.url();
    if (this.mode === 'batch') {
      try {
        const result = await batchTranslate(text, { from: sourceLang, to: targetLang, forceFrom: true, forceTo: true, autoCorrect: false,
          requestFunction: async (generatedUrl, options) => {
            for (const [key, value] of new URL(generatedUrl).searchParams) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
            const body = await this.request(url, options, signal, true);
            return { ok: true, text: async () => body };
          },
        });
        return this.extract(result?.text);
      } catch (error) {
        if (signal?.aborted || error instanceof TranslationError) throw error;
        throw new TranslationError(this.id, 'INVALID_RESPONSE', 'Google вернул некорректный ответ перевода.', 502);
      }
    }
    let options;
    if (this.mode === 'api') {
      options = { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'X-Goog-Api-Key': this.apiKey } : {}) }, body: JSON.stringify({ q: text, target: targetLang, format: 'text', ...(sourceLang !== 'auto' ? { source: sourceLang } : {}) }) };
    } else if (this.mode === 'web') {
      for (const [key, value] of Object.entries({ client: 'gtx', dt: 't', sl: sourceLang, tl: targetLang, q: text })) url.searchParams.set(key, value);
      options = { method: 'GET' };
    } else throw new TranslationError(this.id, 'PROVIDER_UNAVAILABLE', 'Проверьте GOOGLE_TRANSLATE_MODE: batch, web или api.', 502);
    const data = await this.request(url, options, signal);
    if (data.error) throw providerError(this.id, Number(data.error.code) || 502);
    const result = this.mode === 'api' ? data.data?.translations?.[0]?.translatedText : Array.isArray(data[0]) ? data[0].map(part => typeof part?.[0] === 'string' ? part[0] : '').join('') : undefined;
    return this.extract(result);
  }
}

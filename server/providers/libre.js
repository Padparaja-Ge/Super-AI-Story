import { TranslationProvider } from './translationProvider.js';
import { providerError } from '../services/translationErrors.js';

// Retain existing local LibreTranslate connections within the same service.
export class LibreProvider extends TranslationProvider {
  constructor(config) { super('libre', config); }
  async translate(text, sourceLang, targetLang, { signal } = {}) {
    this.validate(text, sourceLang, targetLang);
    const data = await this.request(this.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, format: 'text', ...(this.apiKey ? { api_key: this.apiKey } : {}) }) }, signal);
    if (data.error) throw providerError(this.id, 502);
    return this.extract(data.translatedText);
  }
}

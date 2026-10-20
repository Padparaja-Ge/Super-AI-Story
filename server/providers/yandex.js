import { randomUUID } from 'node:crypto';
import { TranslationProvider } from './translationProvider.js';
import { providerError } from '../services/translationErrors.js';

export class YandexProvider extends TranslationProvider {
  constructor(config) { super('yandex', config); }
  async translate(text, sourceLang, targetLang, { signal } = {}) {
    this.validate(text, sourceLang, targetLang);
    const url = this.url();
    if (!url.searchParams.has('ucid')) url.searchParams.set('ucid', randomUUID().replaceAll('-', ''));
    if (!url.searchParams.has('srv')) url.searchParams.set('srv', 'android');
    if (!url.searchParams.has('format')) url.searchParams.set('format', 'text');
    const lang = code => code.toLowerCase().split('-')[0];
    const body = new URLSearchParams({ text, lang: sourceLang === 'auto' ? lang(targetLang) : `${lang(sourceLang)}-${lang(targetLang)}` });
    const data = await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, signal);
    if (data.code && data.code !== 200) throw providerError(this.id, Number(data.code));
    return this.extract(Array.isArray(data.text) && data.text.every(t => typeof t === 'string') ? data.text.join('') : undefined);
  }
}

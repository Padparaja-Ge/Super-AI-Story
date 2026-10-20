import { TranslationProvider } from './translationProvider.js';
import { TranslationError, providerError } from '../services/translationErrors.js';

export class DeepLProvider extends TranslationProvider {
  constructor(config) { super('deepl', config); this.mode = config?.mode || 'deeplx'; }
  async translate(text, sourceLang, targetLang, { signal } = {}) {
    this.validate(text, sourceLang, targetLang);
    if (!['api', 'deeplx'].includes(this.mode)) throw new TranslationError(this.id, 'PROVIDER_UNAVAILABLE', 'Проверьте DEEPL_TRANSLATE_MODE: api или deeplx.', 502);
    const url = this.url();
    if (/^api(?:-free)?\.deepl\.com$/.test(url.hostname) && !this.apiKey) throw new TranslationError(this.id, 'PROVIDER_UNAVAILABLE', 'DeepL: настройте прокси либо DEEPL_API_KEY на сервере.', 502);
    const target = targetLang.toUpperCase();
    const body = { text: this.mode === 'api' ? [text] : text, target_lang: target, ...(sourceLang !== 'auto' ? { source_lang: sourceLang.toUpperCase().split('-')[0] } : this.mode === 'deeplx' ? { source_lang: 'auto' } : {}) };
    const headers = { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `${this.mode === 'api' ? 'DeepL-Auth-Key' : 'Bearer'} ${this.apiKey}` } : {}) };
    const data = await this.request(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
    if (data.code && Number(data.code) !== 200) throw providerError(this.id, Number(data.code));
    if (data.error) throw providerError(this.id, 502);
    return this.extract(this.mode === 'api' ? data.translations?.[0]?.text : data.data);
  }
}

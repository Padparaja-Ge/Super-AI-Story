import { TranslationError, providerError, validateTranslation } from '../services/translationErrors.js';

export class TranslationProvider {
  constructor(id, { endpoint, apiKey = '', fetchImpl = (...args) => fetch(...args), timeoutMs = 12000, maxChars = 4500 } = {}) {
    Object.assign(this, { id, endpoint, apiKey, fetchImpl, timeoutMs, maxChars });
  }
  async translate(text, sourceLang, targetLang) { throw new Error('Not implemented'); }
  validate(text, sourceLang, targetLang) { validateTranslation(text, sourceLang, targetLang, this.id); }
  url() {
    try {
      const url = new URL(typeof this.endpoint === 'function' ? this.endpoint() : this.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
      return url;
    } catch { throw new TranslationError(this.id, 'PROVIDER_UNAVAILABLE', `Проверьте endpoint переводчика ${this.id} в конфигурации сервера.`, 502); }
  }
  extract(value) {
    if (typeof value !== 'string' || !value.trim()) throw new TranslationError(this.id, 'INVALID_RESPONSE', `Переводчик ${this.id} вернул пустой или некорректный ответ.`, 502);
    return value;
  }
  async request(url, options, signal, rawText = false) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) {
        await response.body?.cancel();
        throw providerError(this.id, response.status);
      }
      // Bound replies even for a broken custom endpoint; never echo its body into an error.
      let size = 0; const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1024 * 1024) throw new TranslationError(this.id, 'INVALID_RESPONSE', 'Слишком большой ответ переводчика.', 502);
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (rawText) return text;
      try { return JSON.parse(text); }
      catch { throw new TranslationError(this.id, 'INVALID_RESPONSE', `Переводчик ${this.id} вернул некорректный JSON.`, 502); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TranslationError) throw error;
      if (timeout.aborted || error.name === 'TimeoutError') throw new TranslationError(this.id, 'TIMEOUT', `Переводчик ${this.id} не ответил вовремя.`, 502);
      throw new TranslationError(this.id, 'NETWORK_ERROR', `Не удалось подключиться к переводчику ${this.id}.`, 502);
    }
  }
}

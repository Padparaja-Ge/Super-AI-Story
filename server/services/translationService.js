import { setTimeout as delay } from 'node:timers/promises';
import { translationConfig } from '../config/translation.js';
import { YandexProvider } from '../providers/yandex.js';
import { DeepLProvider } from '../providers/deepl.js';
import { GoogleProvider } from '../providers/google.js';
import { LibreProvider } from '../providers/libre.js';
import { TranslationCache } from '../cache/translationCache.js';
import { splitTranslation } from './translationChunks.js';
import { TranslationRateLimit } from './translationRateLimit.js';
import { TranslationError, validateTranslation } from './translationErrors.js';

export class TranslationService {
  constructor({ providers, cache = new TranslationCache(), limiter = new TranslationRateLimit(), retryDelays = [500, 1500], sleep = (ms, signal) => delay(ms, undefined, { signal }), debug = false, logger = console, maxConcurrent = 4 } = {}) {
    Object.assign(this, { providers, cache, limiter, retryDelays, sleep, debug, logger, maxConcurrent });
    this.active = 0; this.controller = new AbortController();
  }
  async translate(text, sourceLang = 'auto', targetLang, provider = 'yandex', { fallback = false, signal } = {}) {
    if (typeof provider !== 'string' || !Object.hasOwn(this.providers, provider)) throw new TranslationError(typeof provider === 'string' ? provider.slice(0, 32) : null, 'UNKNOWN_PROVIDER', 'Неизвестный провайдер перевода.', 400);
    validateTranslation(text, sourceLang, targetLang, provider);
    sourceLang = sourceLang.toLowerCase(); targetLang = targetLang.toLowerCase();
    if (typeof fallback !== 'boolean') throw new TranslationError(provider, 'INVALID_REQUEST', 'fallback должен быть true или false.', 400);
    signal?.throwIfAborted(); this.controller.signal.throwIfAborted();
    if (sourceLang === targetLang) return { translation: text, provider };
    if (this.active >= this.maxConcurrent) throw new TranslationError(provider, 'RATE_LIMITED', 'Переводчик занят. Попробуйте немного позже.', 429);
    this.active++;
    const timeout = AbortSignal.timeout(120000);
    const combined = AbortSignal.any([this.controller.signal, timeout, ...(signal ? [signal] : [])]);
    try {
      const candidates = [provider, ...(fallback ? ['yandex', 'google', 'deepl'].filter(id => id !== provider && Object.hasOwn(this.providers, id)) : [])];
      for (let index = 0; index < candidates.length; index++) {
        const id = candidates[index];
        try { return { translation: await this.translateWith(id, text, sourceLang, targetLang, combined), provider: id }; }
        catch (error) {
          if (combined.aborted) throw error;
          if (!(error instanceof TranslationError) || error.status < 500 || index === candidates.length - 1) throw error;
        }
      }
    } catch (error) {
      if (signal?.aborted || this.controller.signal.aborted) throw error;
      if (timeout.aborted) throw new TranslationError(provider, 'TIMEOUT', 'Перевод занял слишком много времени. Попробуйте меньший текст.', 502);
      throw error;
    } finally { this.active--; }
  }
  async translateWith(id, text, source, target, signal) {
    const translator = this.providers[id];
    const key = this.cache.key(id, source, target, text, typeof translator.endpoint === 'function' ? translator.endpoint() : '');
    const cached = this.cache.get(key); if (cached !== undefined) return cached;
    if (this.debug) this.logger.debug(`[Translation] provider=${id} source=${source} target=${target}`);
    try {
      const translated = [];
      for (const chunk of splitTranslation(text, translator.maxChars || 4500)) {
        signal.throwIfAborted();
        const leading = chunk.match(/^\s*/u)[0], trailing = chunk.trim() ? chunk.match(/\s*$/u)[0] : '';
        if (!chunk.trim()) { translated.push(chunk); continue; }
        let result;
        for (let attempt = 0; ; attempt++) {
          this.limiter.take(id);
          try { result = await translator.translate(chunk.trim(), source, target, { signal }); break; }
          catch (error) {
            const retryable = ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) || error.upstreamStatus >= 500 && error.upstreamStatus !== 501;
            if (signal.aborted || !retryable || attempt >= this.retryDelays.length) throw error;
            await this.sleep(this.retryDelays[attempt], signal);
          }
        }
        if (typeof result !== 'string' || !result.trim()) throw new TranslationError(id, 'INVALID_RESPONSE', 'Переводчик вернул пустой ответ.', 502);
        translated.push(leading + result.trim() + trailing);
      }
      const result = translated.join(''); this.cache.set(key, result);
      if (this.debug) this.logger.debug(`[Translation] success provider=${id}`);
      return result;
    } catch (error) {
      if (this.debug) this.logger.debug(`[Translation] failed provider=${id} status=${Number(error.upstreamStatus || error.status) || 502}`);
      throw error;
    }
  }
  close() { this.controller.abort(); this.cache.clear(); }
}

export function createTranslationService({ config = translationConfig(), getLegacyEndpoint, ...options } = {}) {
  return new TranslationService({
    providers: {
      yandex: new YandexProvider(config.yandex), deepl: new DeepLProvider(config.deepl), google: new GoogleProvider(config.google),
      libre: new LibreProvider({ ...config.libre, endpoint: config.libre.endpoint || getLegacyEndpoint }),
    }, debug: config.debug, ...options,
  });
}

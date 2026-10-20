import { TranslationError } from './translationErrors.js';

// A shared core budget also covers clients behind gateways and automatic chat translation.
export class TranslationRateLimit {
  constructor({ limit = 180, windowMs = 60000, now = Date.now } = {}) { Object.assign(this, { limit, windowMs, now }); this.reset = 0; this.count = 0; }
  take(provider) {
    const now = this.now();
    if (now >= this.reset) { this.reset = now + this.windowMs; this.count = 0; }
    if (++this.count > this.limit) {
      const error = new TranslationError(provider, 'RATE_LIMITED', 'Слишком много запросов перевода. Попробуйте через минуту.', 429);
      error.retryAfter = Math.max(1, Math.ceil((this.reset - now) / 1000)); throw error;
    }
  }
}

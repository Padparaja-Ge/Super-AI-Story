import { createHash } from 'node:crypto';

export class TranslationCache {
  constructor({ maxEntries = 256, maxBytes = 8 * 1024 * 1024, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { maxEntries, maxBytes, ttlMs, now }); this.entries = new Map(); this.bytes = 0;
  }
  key(provider, source, target, text, scope = '') { return createHash('sha256').update(JSON.stringify([provider, source, target, text, scope])).digest('hex'); }
  delete(key) { const entry = this.entries.get(key); if (entry) this.bytes -= entry.size; this.entries.delete(key); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value) {
    this.delete(key); const size = Buffer.byteLength(value, 'utf8');
    if (size > this.maxBytes) return;
    this.entries.set(key, { value, size, expires: this.now() + this.ttlMs }); this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}

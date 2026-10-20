import express from 'express';
import { TranslationError } from '../services/translationErrors.js';
import { TranslationRateLimit } from '../services/translationRateLimit.js';

export function createTranslationRouter({ translationService, getSettings, limiter = new TranslationRateLimit({ limit: 60 }) }) {
  const router = express.Router();
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', (req, res, next) => { try { limiter.take(); next(); } catch (error) { next(error); } }, express.json({ limit: '512kb' }), async (req, res) => {
    const settings = getSettings(), body = req.body || {};
    // Old source/target names remain accepted for already-open clients during migration.
    const result = await translationService.translate(body.text, body.sourceLang ?? body.source ?? settings.sourceLanguage, body.targetLang ?? body.target ?? settings.displayLanguage, body.provider ?? settings.provider, { fallback: body.fallback ?? settings.translationFallback ?? false });
    res.json({ ...result, text: result.translation });
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const isKnown = error instanceof TranslationError;
    const status = isKnown ? error.status : error.type === 'entity.too.large' || error.type === 'entity.parse.failed' ? 400 : 500;
    const provider = error.provider ?? (typeof req.body?.provider === 'string' ? req.body.provider.slice(0, 32) : getSettings().provider);
    if (status === 429) res.setHeader('Retry-After', String(error.retryAfter || 60));
    res.status(status).json({ error: isKnown ? error.message : status === 400 ? 'Некорректный или слишком большой запрос перевода.' : 'Внутренняя ошибка перевода.', provider, code: isKnown ? error.code : 'TRANSLATION_FAILED' });
  });
  return router;
}

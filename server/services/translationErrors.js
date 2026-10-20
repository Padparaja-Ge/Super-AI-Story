export class TranslationError extends Error {
  constructor(provider, code, message, status = 502, upstreamStatus) {
    super(message);
    Object.assign(this, { provider, code, status, upstreamStatus });
  }
}

export function providerError(provider, status) {
  if (status === 429 || status === 456) return new TranslationError(provider, 'RATE_LIMITED', 'Превышен лимит переводчика. Попробуйте позже.', 429, status);
  if (status === 400 || status === 422 || status === 501) return new TranslationError(provider, 'UNSUPPORTED_LANGUAGE', 'Переводчик не поддерживает указанный язык или формат запроса.', 400, status);
  return new TranslationError(provider, 'PROVIDER_UNAVAILABLE', `Переводчик ${provider} недоступен. Проверьте сервис и его конфигурацию на сервере.`, 502, status);
}

const language = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
export function validateTranslation(text, sourceLang, targetLang, provider) {
  const invalid = message => { throw new TranslationError(provider, 'INVALID_REQUEST', message, 400); };
  if (typeof text !== 'string' || !text.trim()) invalid('Введите непустой текст для перевода.');
  if (text.length > 100000) invalid('Перевод: не более 100 000 символов за запрос.');
  if (typeof sourceLang !== 'string' || (sourceLang !== 'auto' && !language.test(sourceLang))) invalid('Неверный исходный язык: используйте en, ru или auto.');
  if (typeof targetLang !== 'string' || targetLang.toLowerCase() === 'auto' || !language.test(targetLang)) invalid('Неверный язык перевода: используйте код языка, например ru.');
}

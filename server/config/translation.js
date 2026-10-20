import './env.mjs';

export function translationConfig(env = process.env) {
  return {
    yandex: { endpoint: env.YANDEX_TRANSLATE_ENDPOINT || 'https://translate.yandex.net/api/v1/tr.json/translate' },
    deepl: {
      endpoint: env.DEEPL_TRANSLATE_ENDPOINT || (env.DEEPL_API_KEY ? 'https://api-free.deepl.com/v2/translate' : 'http://127.0.0.1:1188/translate'),
      apiKey: env.DEEPL_API_KEY || '',
      mode: env.DEEPL_TRANSLATE_MODE || (env.DEEPL_API_KEY ? 'api' : 'deeplx'),
    },
    google: {
      endpoint: env.GOOGLE_TRANSLATE_ENDPOINT || (env.GOOGLE_API_KEY ? 'https://translation.googleapis.com/language/translate/v2' : env.GOOGLE_TRANSLATE_MODE === 'web' ? 'https://translate.googleapis.com/translate_a/single' : 'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute'),
      apiKey: env.GOOGLE_API_KEY || '',
      mode: env.GOOGLE_TRANSLATE_MODE || (env.GOOGLE_API_KEY ? 'api' : 'batch'),
    },
    libre: { endpoint: env.LIBRE_TRANSLATE_ENDPOINT || '', apiKey: env.LIBRE_API_KEY || '' },
    debug: env.TRANSLATION_DEBUG === 'true',
  };
}

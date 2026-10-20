# Сторонние компоненты

Apache-2.0 применяется к оригинальному коду SAS и не заменяет условия зависимостей, моделей и самостоятельных сторонних компонентов. Версии JavaScript-зависимостей зафиксированы в `package-lock.json`; их лицензии сохраняются в устанавливаемых пакетах и готовом приложении.

| Компонент | Условия и расположение |
| --- | --- |
| Electron / Chromium / Node.js | Собственные лицензии и уведомления в дистрибутиве Electron |
| React, Vite, Express, ws и прочие npm-пакеты | Лицензии соответствующих пакетов в `node_modules` и готовой поставке |
| Manrope | SIL Open Font License; уведомление поставляется с пакетом шрифта |
| llama.cpp | MIT; `server/third-party/LICENSE-llama.cpp.txt` и лицензии в папке движка |
| CUDA-библиотеки | NVIDIA CUDA EULA; `server/third-party/NVIDIA-CUDA-EULA.html` и уведомления движка |
| ONNX Runtime | MIT; `server/third-party/LICENSE-onnxruntime.txt`, используется дополнительным движком Kokoro |
| eSpeak / `server/tts/phonemes.mjs` | GPL-3.0-or-later; `server/third-party/LICENSE-espeak-ng.txt`, отдельная утилита с JSON stdin/stdout |
| Silero `v3_1_ru` / `v3_en` | **CC BY-NC-SA 4.0**, включая ограничение коммерческого использования; `server/third-party/LICENSE-Silero-models.txt` |
| Python, PyTorch, NumPy | PSF / BSD и уведомления зависимостей в подготовленной среде озвучки |
| Kokoro, XTTS v2, Fish Speech, образцы голосов | Отдельные условия конкретной модели, версии и образца |

Полная информация об озвучке, источниках и версиях — в [SPEECH-NOTICES.md](https://github.com/Padparaja-Ge/Super-AI-Story/blob/main/server/third-party/SPEECH-NOTICES.md). Исходные каталоги моделей содержат закреплённые ревизии, URL и контрольные суммы. Подготовка компонентов не меняет их лицензии.

Готовый Windows-пакет содержит Silero RU/EN и соответствующую среду исполнения. Другие модели озвучки устанавливаются отдельно. Модели чата, embeddings и ComfyUI выбирает пользователь; они не входят в лицензию на код SAS.

Для коммерческого использования программы отдельно проверьте совместимость условий всех выбранных моделей и образцов. Сам по себе выбор Apache-2.0 для SAS не предоставляет права на коммерческое использование Silero или иных компонентов с ограничениями.

# SAS · Super AI Story

Локальная студия для ролевых историй, фанфиков и совместных приключений.

## Запуск

Windows 10/11 x64. Распакуйте весь архив в отдельную папку и откройте **SAS.exe**. Папки `app/` и `engines/` должны оставаться рядом. Node.js и сборка для готовой программы не нужны.

В «Настройки → Модели и API» выберите GGUF-модель или совместимый API. Локальные компоненты работают офлайн после установки; внешние API, переводчики и загрузки требуют сети. Модели чата, embeddings и ComfyUI выбираются отдельно.

## Веб-режим

- **Start-SAS-Web.cmd** запускает сервер и открывает браузер после готовности.
- Enter закрывает консоль; сервер продолжает работать в фоне.
- **Stop-SAS-Web.cmd** завершает веб-сервер.
- **Start-SAS-Web-Shell.cmd** открывает веб-оболочку уже работающего ядра SAS.
- **Repair-SAS.cmd** проверяет и восстанавливает файлы приложения.

Адрес по умолчанию — http://127.0.0.1:3212. Адрес, порт, ключ и режим IP-списка задаются в `web-server.json`. Для другого устройства нужен сетевой адрес компьютера с SAS и подходящие правила доступа.

## Данные

Истории и настройки в Windows: `%APPDATA%\Super AI Story\data`. Модели находятся в выбранной папке. Перед обновлением сохраните изменения, закройте старые окна и серверы и сделайте резервную копию.

## Исходники, руководство и расширения

Полные исходники, инструкции запуска и сборки, руководство пользователя и SAS API 2:
https://github.com/Padparaja-Ge/Super-AI-Story

## Авторы и лицензии

© 2026 **Padparaja**. Разработчики: [Padparaja-Ge](https://github.com/Padparaja-Ge) и [Wenzeslaus-first](https://github.com/Wenzeslaus-first).

Оригинальный код SAS — Apache-2.0; см. `LICENSE`, `NOTICE` и `COPYRIGHT.md`. Сторонние компоненты и модели имеют собственные условия. Включённые модели Silero — CC BY-NC-SA 4.0; лицензия на код SAS не отменяет их ограничений. См. `THIRD-PARTY.md`.

## English

Windows 10/11 x64: extract the entire archive and run **SAS.exe**, keeping app/ and engines/ beside it. Select your language during the introduction or in Settings. Choose a GGUF model or API under Models and API. **Start-SAS-Web.cmd** starts browser mode; **Stop-SAS-Web.cmd** stops it; **Repair-SAS.cmd** checks files. No Node.js or compilation is required.

## 日本語

Windows 10/11 x64：全体を展開し **SAS.exe** を起動します。app/ と engines/ は同じ場所に置いてください。初回ガイドまたは設定で言語を選び、モデルと API の設定から GGUF または API を指定します。**Start-SAS-Web.cmd** はブラウザー版の起動、**Stop-SAS-Web.cmd** は停止、**Repair-SAS.cmd** はファイルの検査に使います。Node.js やビルド作業は不要です。

## 简体中文

适用于 Windows 10/11 x64：解压整个压缩包，运行 **SAS.exe**，保留同目录下的 app/ 和 engines/。在首次引导或设置中选择语言，在模型与 API 设置中选择 GGUF 或配置 API。**Start-SAS-Web.cmd** 启动浏览器模式，**Stop-SAS-Web.cmd** 停止服务器，**Repair-SAS.cmd** 检查文件。不需要 Node.js，也无需编译。

## 한국어

Windows 10/11 x64: 압축 파일 전체를 풀고 **SAS.exe**를 실행하세요. app/과 engines/를 같은 위치에 두세요. 첫 실행 안내나 설정에서 언어를 선택하고 모델 및 API 설정에서 GGUF 또는 API를 지정하세요. **Start-SAS-Web.cmd**는 브라우저 모드 실행, **Stop-SAS-Web.cmd**는 종료, **Repair-SAS.cmd**는 파일 검사에 사용합니다. Node.js나 빌드는 필요하지 않습니다.

## Licensing / ライセンス / 许可 / 라이선스

© 2026 Padparaja. Developers: [Padparaja-Ge](https://github.com/Padparaja-Ge) and [Wenzeslaus-first](https://github.com/Wenzeslaus-first). Original SAS code: Apache-2.0. Bundled Silero models: **CC BY-NC-SA 4.0**, including the noncommercial restriction. Third-party components retain their own licenses; see LICENSE, NOTICE, COPYRIGHT.md and THIRD-PARTY.md.

Silero モデルには非商用の制限があります。 / Silero 模型包含非商业用途限制。 / Silero 모델에는 비상업적 이용 제한이 있습니다.

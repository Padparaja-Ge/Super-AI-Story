# SAS · Super AI Story

[Русский](../README.md) · [English](README.en.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

**言語モデルと楽しむキャラクター会話、ファンフィクション、仲間との冒険。**

SAS はキャラクターカード、プレイヤーのペルソナ、世界設定、記憶、イラスト、読み上げをまとめたローカル環境です。手元の GGUF モデルや互換 API を利用し、友人を同じ物語に招待できます。

[Windows 版 SAS 0.9.11 をダウンロード](https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v0.9.11/SAS-Windows-0.9.11.zip) · [リリース一覧](https://github.com/Padparaja-Ge/Super-AI-Story/releases) · [ユーザーガイド](USER-GUIDE.md)

## 主な機能

- **ロールプレイ：** ペルソナ、場面、ロアブック、物語ごとの記憶を使ったキャラクターとの会話。
- **ファンフィクション：** 作品・シーズン・エピソードの整理、登場人物と原作設定の管理、本文の承認。
- **マルチプレイ：** ロビー、共同 RP・D&D セッション、ホスト用ツール、音楽、ボイスチャット。
- **D&D・独自の TRPG：** ストーリーブック、ルール、戦術マップ、イニシアチブ、所持品、サーバー側での行動判定。
- **モデルとメディア：** CPU/CUDA/Vulkan 対応の llama.cpp、互換 API、任意のローカル埋め込みモデル、ComfyUI 画像生成、読み上げエンジン。
- **拡張機能：** SAS API 2 によるパネル、ページ、コマンド、外観、サーバー機能の追加。

表示言語は **ロシア語・英語・日本語・簡体字中国語・韓国語**に対応しています。初回ガイドまたは設定の「言語と文章校正」で切り替えられます。保存済みの物語やモデルの出力言語は変更されません。

## Windows へのインストール

1. Windows 10/11 x64 用の **SAS-Windows-0.9.11.zip** をダウンロードします。
2. 全体を専用のフォルダーに展開し、**SAS.exe** を起動します。<code>app/</code> と <code>engines/</code> は同じ場所に置いてください。
3. 設定の「モデルと API」で GGUF モデルまたは API 接続を設定します。

配布パッケージの実行に Node.js やビルド作業は不要です。小容量の **SAS-Start-0.9.11.zip** は、<code>Start-SAS.cmd</code> の実行時に同じパッケージをダウンロードしてインストールします。この方法にはインターネット接続が必要です。会話用モデル、埋め込みモデル、ComfyUI は別途選択します。

ブラウザー版は <code>Start-SAS-Web.cmd</code> で起動します。既定のアドレスは **http://127.0.0.1:3212** です。<code>Stop-SAS-Web.cmd</code> で停止、<code>Repair-SAS.cmd</code> でファイルの検査・復元ができます。更新前にはデータをバックアップしてください。

## ソースからの起動とビルド

このリポジトリには <code>src/</code>、<code>server/</code>、<code>shared/</code>、<code>electron/</code> など、編集可能な全ソースが含まれます。**Node.js 22 以降、npm、Git** を用意します。

~~~sh
git clone https://github.com/Padparaja-Ge/Super-AI-Story.git
cd Super-AI-Story
npm ci
npm run build
npm run desktop
~~~

ブラウザー版は <code>npm run web</code>、開発環境は <code>npm run dev</code> で起動します。<code>npm run package:app</code> はエンジンを同梱せずに Electron アプリを作成します。ランタイムを準備すると、<code>npm run package:win</code> で完全な Windows パッケージを作成できます。[ビルドガイド](BUILDING.md)を参照してください。

## 拡張機能・データ・ネットワーク

[SAS API 2 ガイド](EXTENSIONS-API.md)と[キャンペーンノートの例](../examples/sas-extensions/campaign-notes)を用意しています。拡張機能は実行可能なコードです。バックエンド拡張機能は Node.js プロセスと同じ権限で動作するため、有効化の前に権限とソースを確認してください。<code>SAS_DISABLE_EXTENSIONS=1</code> でセーフモードを利用できます。

通常の保存先は Windows の <code>%APPDATA%/Super AI Story/data</code>、開発時は <code>data/</code> です。<code>SAS_DATA_DIR</code> で変更できます。個人の物語や認証情報を Git に公開しないでください。ローカル推論は PC 内で処理されますが、外部 API や翻訳サービスには利用時に必要なデータが送信されます。

初期設定では localhost からのみアクセスできます。LAN/VPN 向けの設定は <code>web-server.json</code> と[ネットワークガイド](MULTIPLAYER-NETWORK.md)を確認してください。接続と音声はファイアウォール、経路、ブラウザーの権限にも依存します。

## 著作権とライセンス

© 2026 **Padparaja**。開発者：[Padparaja-Ge](https://github.com/Padparaja-Ge)、[Wenzeslaus-first](https://github.com/Wenzeslaus-first)。

SAS 独自のコードと文書は [Apache-2.0](../LICENSE) で提供されます。[COPYRIGHT.md](../COPYRIGHT.md)と[NOTICE](../NOTICE)もご確認ください。外部コンポーネントとモデルには、それぞれのライセンスが適用されます。同梱の Silero モデルは **CC BY-NC-SA 4.0** であり、SAS 本体のライセンスによってその制限が解除されることはありません。[THIRD-PARTY.md](../THIRD-PARTY.md)を参照してください。

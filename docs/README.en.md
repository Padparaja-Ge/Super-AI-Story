# SAS · Super AI Story

[Русский](../README.md) · [English](README.en.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

**Characters, fanfiction and shared adventures with language models.**

SAS brings character cards, player personas, world lore, memory, illustrations and speech into one local workspace. Use your own GGUF model, connect a compatible API, or invite friends to a shared story.

[Download SAS 0.9.11 for Windows](https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v0.9.11/SAS-Windows-0.9.11.zip) · [Releases](https://github.com/Padparaja-Ge/Super-AI-Story/releases) · [User guide](USER-GUIDE.md)

## Features

- **Roleplay:** character conversations with a player persona, scene, lorebooks and story memory.
- **Fanfiction:** works, seasons and episodes; characters, canon and approved text.
- **Multiplayer:** lobbies, shared RP and D&D sessions, host tools, music and voice chat.
- **D&D and custom tabletop systems:** storybooks, rules, tactical maps, initiative, inventory and server-side action resolution.
- **Models and media:** llama.cpp with CPU/CUDA/Vulkan, compatible APIs, optional local embeddings, ComfyUI illustrations and speech engines.
- **Extensions:** panels, pages, commands, styles and backend features through SAS API 2.

The interface supports **Russian, English, Japanese, Simplified Chinese and Korean**. Select a language during the introduction or in **Settings → Language and proofreading**. This does not change saved stories or the model's output language.

## Install on Windows

1. Download **SAS-Windows-0.9.11.zip** for Windows 10/11 x64.
2. Extract the entire archive into a separate folder and run **SAS.exe**. Keep <code>app/</code> and <code>engines/</code> beside it.
3. Choose a GGUF model or configure an API under **Settings → Models and API**.

The ready-made package needs no Node.js or compilation. The smaller **SAS-Start-0.9.11.zip** downloads and installs the same package when you run <code>Start-SAS.cmd</code>; this requires internet access. Chat models, embeddings and ComfyUI are selected separately.

<code>Start-SAS-Web.cmd</code> starts browser mode at **http://127.0.0.1:3212**. <code>Stop-SAS-Web.cmd</code> stops the server; <code>Repair-SAS.cmd</code> checks and restores files. Back up your data before upgrading.

## Source and build

This repository contains the complete editable source: <code>src/</code>, <code>server/</code>, <code>shared/</code> and <code>electron/</code>, together with build scripts and tests. Install **Node.js 22+, npm and Git**:

~~~sh
git clone https://github.com/Padparaja-Ge/Super-AI-Story.git
cd Super-AI-Story
npm ci
npm run build
npm run desktop
~~~

Use <code>npm run web</code> for the full browser interface or <code>npm run dev</code> for development. <code>npm run package:app</code> packages Electron without bundled engines. Prepare the runtime components before building a full Windows package with <code>npm run package:win</code>. See [build instructions](BUILDING.md).

## Extensions, data and networking

See the [SAS API 2 guide](EXTENSIONS-API.md) and [campaign-notes example](../examples/sas-extensions/campaign-notes). Extensions are executable code: backend extensions have the permissions of the Node.js process. Review permissions and source before enabling them. <code>SAS_DISABLE_EXTENSIONS=1</code> enables safe mode.

Windows data normally lives in <code>%APPDATA%/Super AI Story/data</code>; development uses <code>data/</code>. Override this with <code>SAS_DATA_DIR</code>. Keep personal stories and credentials out of Git. Local inference stays on your computer; external APIs and translation services receive the data you send to them.

Access defaults to localhost. Configure <code>web-server.json</code> for LAN/VPN and review the [network guide](MULTIPLAYER-NETWORK.md). Connections and voice chat depend on routing, firewalls and browser permissions.

## Authors and licenses

© 2026 **Padparaja**. Developers: [Padparaja-Ge](https://github.com/Padparaja-Ge) and [Wenzeslaus-first](https://github.com/Wenzeslaus-first).

Original SAS code and documentation use [Apache-2.0](../LICENSE). See [COPYRIGHT.md](../COPYRIGHT.md) and [NOTICE](../NOTICE). Third-party components and models retain their own licenses. Bundled Silero models use **CC BY-NC-SA 4.0**; the SAS code license does not remove these restrictions. See [THIRD-PARTY.md](../THIRD-PARTY.md).

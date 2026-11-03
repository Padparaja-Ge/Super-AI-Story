# SAS · Super AI Story

[Русский](../README.md) · [English](README.en.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

**与语言模型一起开展角色扮演、创作同人故事，与朋友共同冒险。**

SAS 将角色卡、玩家人设、世界设定、记忆、插图和语音朗读整合在一个本地工作空间中。你可以使用自己的 GGUF 模型、连接兼容 API，或邀请朋友加入同一个故事。

[下载 Windows 版 SAS 0.9.11](https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v0.9.11/SAS-Windows-0.9.11.zip) · [所有版本](https://github.com/Padparaja-Ge/Super-AI-Story/releases) · [使用指南](USER-GUIDE.md)

## 主要功能

- **角色扮演：** 结合玩家人设、场景、世界书和独立的故事记忆，与角色互动。
- **同人创作：** 管理作品、季和章节，维护角色与原作设定，审核并确认正文。
- **多人游戏：** 房间大厅、多人 RP 或 D&D、房主管理工具、背景音乐和语音聊天。
- **D&D 与自定义跑团规则：** 故事书、规则、战术地图、先攻顺序、物品栏，以及服务器引擎处理的行动判定。
- **模型与媒体：** 支持 CPU/CUDA/Vulkan 的 llama.cpp、兼容 API、可选本地嵌入模型、ComfyUI 图像生成和语音引擎。
- **扩展：** 通过 SAS API 2 添加面板、页面、命令、样式和后端功能。

界面支持**俄语、英语、日语、简体中文和韩语**。首次引导或“设置 → 语言与文本校对”中均可选择。切换界面语言不会改动已保存的故事，也不会自动改变模型的输出语言。

## 在 Windows 上安装

1. 下载适用于 Windows 10/11 x64 的 **SAS-Windows-0.9.11.zip**。
2. 将整个压缩包解压到单独的文件夹，运行 **SAS.exe**。<code>app/</code> 和 <code>engines/</code> 必须保留在同一目录下。
3. 在“设置 → 模型与 API”中选择 GGUF 模型或配置 API。

成品包不需要 Node.js，也无需自行编译。较小的 **SAS-Start-0.9.11.zip** 会在运行 <code>Start-SAS.cmd</code> 时下载并安装相同的成品包，因此需要联网。对话模型、嵌入模型和 ComfyUI 需单独选择。

浏览器模式使用 <code>Start-SAS-Web.cmd</code>，默认地址为 **http://127.0.0.1:3212**。<code>Stop-SAS-Web.cmd</code> 停止服务器，<code>Repair-SAS.cmd</code> 检查和恢复程序文件。更新前请先备份数据。

## 从源码运行与构建

本仓库提供完整可编辑源码，包括 <code>src/</code>、<code>server/</code>、<code>shared/</code> 和 <code>electron/</code>。准备 **Node.js 22 或更新版本、npm 和 Git**，然后执行：

~~~sh
git clone https://github.com/Padparaja-Ge/Super-AI-Story.git
cd Super-AI-Story
npm ci
npm run build
npm run desktop
~~~

使用 <code>npm run web</code> 启动完整浏览器界面，使用 <code>npm run dev</code> 启动开发环境。<code>npm run package:app</code> 构建不含内置引擎的 Electron 程序。准备运行组件后，使用 <code>npm run package:win</code> 构建完整 Windows 包。详见[构建指南](BUILDING.md)。

## 扩展、数据与网络

请参阅 [SAS API 2 文档](EXTENSIONS-API.md)和[战役笔记示例](../examples/sas-extensions/campaign-notes)。扩展包含可执行代码，后端扩展拥有 Node.js 进程的权限。启用前请检查权限和源码。<code>SAS_DISABLE_EXTENSIONS=1</code> 可启用安全模式。

Windows 默认数据目录为 <code>%APPDATA%/Super AI Story/data</code>，开发模式使用 <code>data/</code>。可通过 <code>SAS_DATA_DIR</code> 更改。请勿将私人故事、凭据和数据上传到 Git。本地推理在你的电脑上完成；使用外部 API 或翻译服务时，相应数据会发送给所选服务。

默认仅允许本机访问。局域网或 VPN 访问需配置 <code>web-server.json</code>，请查看[网络指南](MULTIPLAYER-NETWORK.md)。连接和语音聊天还受防火墙、路由及浏览器权限影响。

## 作者与许可

© 2026 **Padparaja**。开发者：[Padparaja-Ge](https://github.com/Padparaja-Ge) 与 [Wenzeslaus-first](https://github.com/Wenzeslaus-first)。

SAS 原创代码和文档采用 [Apache-2.0](../LICENSE) 许可，另请参阅 [COPYRIGHT.md](../COPYRIGHT.md) 与 [NOTICE](../NOTICE)。第三方组件与模型保留各自的许可。内置 Silero 模型采用 **CC BY-NC-SA 4.0**；SAS 代码的许可不会解除模型的这些限制。详见 [THIRD-PARTY.md](../THIRD-PARTY.md)。

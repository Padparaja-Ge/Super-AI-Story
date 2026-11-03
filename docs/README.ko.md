# SAS · Super AI Story

[Русский](../README.md) · [English](README.en.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

**언어 모델과 함께하는 캐릭터 대화, 팬픽, 친구들과의 모험.**

SAS는 캐릭터 카드, 플레이어 페르소나, 세계관, 기억, 삽화, 음성 읽기를 하나로 모은 로컬 작업 공간입니다. 직접 준비한 GGUF 모델이나 호환 API를 사용하고, 친구를 같은 이야기에 초대할 수 있습니다.

[Windows용 SAS 0.9.11 다운로드](https://github.com/Padparaja-Ge/Super-AI-Story/releases/download/v0.9.11/SAS-Windows-0.9.11.zip) · [전체 릴리스](https://github.com/Padparaja-Ge/Super-AI-Story/releases) · [사용 안내서](USER-GUIDE.md)

## 주요 기능

- **역할극:** 플레이어 페르소나, 장면, 로어북, 이야기별 기억을 활용한 캐릭터 대화.
- **팬픽:** 작품·시즌·에피소드 구성, 등장인물과 원작 설정 관리, 본문 검토 및 승인.
- **멀티플레이:** 대기실, 공동 RP 및 D&D 세션, 호스트 도구, 음악, 음성 채팅.
- **D&D 및 사용자 지정 TRPG:** 스토리북, 규칙, 전술 지도, 우선권, 소지품, 서버 엔진의 행동 판정.
- **모델과 미디어:** CPU/CUDA/Vulkan을 지원하는 llama.cpp, 호환 API, 선택형 로컬 임베딩 모델, ComfyUI 이미지 생성, 음성 엔진.
- **확장 기능:** SAS API 2를 통해 패널, 페이지, 명령, 스타일, 백엔드 기능 추가.

인터페이스는 **러시아어, 영어, 일본어, 중국어 간체, 한국어**를 지원합니다. 첫 실행 안내 또는 설정의 ‘언어 및 문장 교정’에서 선택할 수 있습니다. 인터페이스 언어를 바꿔도 저장된 이야기나 모델의 출력 언어는 변경되지 않습니다.

## Windows 설치

1. Windows 10/11 x64용 **SAS-Windows-0.9.11.zip**을 다운로드합니다.
2. 압축 파일 전체를 별도 폴더에 풀고 **SAS.exe**를 실행합니다. <code>app/</code>과 <code>engines/</code> 폴더를 같은 위치에 두세요.
3. 설정의 ‘모델 및 API’에서 GGUF 모델을 선택하거나 API를 설정합니다.

배포 패키지 실행에는 Node.js나 별도 빌드가 필요하지 않습니다. 작은 **SAS-Start-0.9.11.zip**은 <code>Start-SAS.cmd</code> 실행 시 같은 패키지를 내려받아 설치하므로 인터넷 연결이 필요합니다. 대화 모델, 임베딩 모델, ComfyUI는 별도로 선택합니다.

브라우저 모드는 <code>Start-SAS-Web.cmd</code>로 실행하며 기본 주소는 **http://127.0.0.1:3212**입니다. <code>Stop-SAS-Web.cmd</code>는 서버를 종료하고, <code>Repair-SAS.cmd</code>는 파일을 검사하고 복구합니다. 업데이트 전에 데이터를 백업하세요.

## 소스 실행 및 빌드

이 저장소에는 <code>src/</code>, <code>server/</code>, <code>shared/</code>, <code>electron/</code> 등 수정 가능한 전체 소스가 들어 있습니다. **Node.js 22 이상, npm, Git**을 준비한 뒤 실행합니다.

~~~sh
git clone https://github.com/Padparaja-Ge/Super-AI-Story.git
cd Super-AI-Story
npm ci
npm run build
npm run desktop
~~~

전체 브라우저 인터페이스는 <code>npm run web</code>, 개발 환경은 <code>npm run dev</code>로 실행합니다. <code>npm run package:app</code>은 엔진을 포함하지 않는 Electron 앱을 만듭니다. 런타임을 준비한 뒤 <code>npm run package:win</code>을 실행하면 전체 Windows 패키지를 만들 수 있습니다. [빌드 안내서](BUILDING.md)를 참고하세요.

## 확장 기능, 데이터, 네트워크

[SAS API 2 안내서](EXTENSIONS-API.md)와 [캠페인 메모 예제](../examples/sas-extensions/campaign-notes)를 제공합니다. 확장 기능은 실행 가능한 코드이며, 백엔드 확장 기능은 Node.js 프로세스와 같은 권한을 갖습니다. 활성화 전에 권한과 소스를 확인하세요. <code>SAS_DISABLE_EXTENSIONS=1</code>로 안전 모드를 사용할 수 있습니다.

Windows 기본 데이터 위치는 <code>%APPDATA%/Super AI Story/data</code>이며 개발 모드는 <code>data/</code>를 사용합니다. <code>SAS_DATA_DIR</code>로 변경할 수 있습니다. 개인 이야기와 인증 정보는 Git에 올리지 마세요. 로컬 추론은 내 컴퓨터에서 처리되지만 외부 API나 번역 서비스를 이용하면 해당 데이터가 선택한 서비스로 전송됩니다.

기본 설정은 로컬 컴퓨터의 접속만 허용합니다. LAN/VPN 접속은 <code>web-server.json</code>과 [네트워크 안내서](MULTIPLAYER-NETWORK.md)를 확인하세요. 연결과 음성 채팅은 방화벽, 네트워크 경로, 브라우저 권한의 영향도 받습니다.

## 저작권과 라이선스

© 2026 **Padparaja**. 개발자: [Padparaja-Ge](https://github.com/Padparaja-Ge), [Wenzeslaus-first](https://github.com/Wenzeslaus-first).

SAS 원본 코드와 문서는 [Apache-2.0](../LICENSE)으로 배포됩니다. [COPYRIGHT.md](../COPYRIGHT.md)와 [NOTICE](../NOTICE)도 참고하세요. 타사 구성 요소와 모델에는 각각의 라이선스가 적용됩니다. 포함된 Silero 모델은 **CC BY-NC-SA 4.0**이며, SAS 코드 라이선스가 이 제한을 해제하지는 않습니다. 자세한 내용은 [THIRD-PARTY.md](../THIRD-PARTY.md)를 확인하세요.

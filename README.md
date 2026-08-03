# Victory 1944

**Language:** 한국어 | [English](README.en.md)

Victory 1944는 모바일 우선 전략 게임 프로토타입의 포트폴리오 스냅샷입니다. 결정론적 시뮬레이션 엔진, 서버 권위 애플리케이션 계층, PixiJS 클라이언트를 분리하여 화면과 저장 방식에 의존하지 않고 게임 규칙을 검증할 수 있도록 구성했습니다.

## 포함된 내용

- `engine/`: 결정론적 전투·경제·캠페인·성장 시뮬레이션
- `server/`: SQLite 기반 건설·작전 흐름, HTTP API, 복구 및 계측 테스트
- `client/`: TypeScript, PixiJS, Vite, Capacitor 기반 모바일 클라이언트
- [기술 아키텍처](victory_1944_docs/docs/engineering/ARCHITECTURE.md)와 [품질 게이트](victory_1944_docs/docs/engineering/QUALITY_GATES.md)

내부 결정 기록, 진행 중인 계획, 출시 운영 자료, 로컬 에이전트 지침, 비공개 제품 전략은 공개 스냅샷에서 제외했습니다.

## 아키텍처

```text
PixiJS 클라이언트
       |
       v
HTTP 애플리케이션 서버
       |
       +--> 서버 권위 건설·작전 규칙
       +--> SQLite 영속화·복구
       +--> 계측·관리자 경계
       |
       v
결정론적 시뮬레이션 엔진
```

시뮬레이션 엔진은 결정론적 도메인 규칙을 담당합니다. 서버는 영속성, 동시성, 복구, 권위 상태를 담당합니다. 클라이언트는 서버 상태를 렌더링하고 명령을 전송하지만 또 하나의 진실 공급원이 되지 않습니다.

## 검사 실행

Node.js 24를 권장합니다.

```powershell
cd engine
npm install
npm run typecheck
npm test

cd ..\server
npm run typecheck
npm test

cd ..\client
npm install
npm run typecheck
npm run build
```

클라이언트를 로컬에서 실행하려면 `client/.env.example`을 `client/.env.local`로 복사하고 로컬 API 주소를 사용합니다.

## 포트폴리오 범위

이 저장소는 시스템 분리, 결정론적 테스트, 서버 권위, 복구 경로, 모바일 클라이언트 통합을 보여주기 위한 선별된 스냅샷입니다. 전체 비공개 개발 저장소를 그대로 공개한 것이 아닙니다.

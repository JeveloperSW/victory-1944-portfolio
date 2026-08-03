export interface PrototypePageOptions {
  /** 루프백 프로토타입이 발급받은 player Bearer 토큰. */
  readonly token: string;
  /** 화면이 조작할 단일 도시 ID. */
  readonly cityId: string;
}

/**
 * JSON 문자열을 inline script의 JavaScript 문자열 리터럴로 안전하게 직렬화한다.
 * `<`를 이스케이프하므로 `</script>`로 script 요소를 닫을 수 없고, U+2028/U+2029도
 * JavaScript 소스 경계를 깨지 않는다.
 */
function inlineString(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * 플레이어블 첫 루프를 사람이 직접 확인하기 위한 로컬 전용 한 화면 하네스.
 *
 * 이 함수는 정적 HTML만 반환한다. 서버 라우팅·인증·게임 규칙을 구현하거나 우회하지
 * 않으며, 페이지의 모든 상태 변경은 Bearer 인증된 `/v1` 명령으로 다시 서버에 보낸다.
 */
export function renderPrototypePage(options: PrototypePageOptions): string {
  const token = inlineString(options.token);
  const cityId = inlineString(options.cityId);

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Victory 1944 · 첫 작전 검증판</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #e7e0cb;
      --muted: #aaa58f;
      --canvas: #171a16;
      --panel: #22271f;
      --panel-raised: #2a3026;
      --line: #535b45;
      --line-soft: #3b4234;
      --khaki: #c5b37a;
      --olive: #879066;
      --success: #a8bb7a;
      --warning: #d1a35c;
      --danger: #d47c67;
      --focus: #f0ce72;
      --shadow: rgba(0, 0, 0, .28);
      font-family: "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-width: 320px;
      background: var(--canvas);
    }

    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background-color: var(--canvas);
      background-image:
        linear-gradient(rgba(197, 179, 122, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(197, 179, 122, .035) 1px, transparent 1px);
      background-size: 28px 28px;
    }

    button,
    input {
      font: inherit;
    }

    button {
      touch-action: manipulation;
    }

    button:focus-visible,
    a:focus-visible,
    [tabindex="-1"]:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
    }

    .skip-link {
      position: fixed;
      z-index: 100;
      top: 8px;
      left: 8px;
      padding: 9px 12px;
      color: #11140f;
      background: var(--focus);
      transform: translateY(-150%);
    }

    .skip-link:focus {
      transform: translateY(0);
    }

    .shell {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 24px clamp(16px, 3vw, 44px) 48px;
    }

    .masthead {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      padding: 22px 0 18px;
      border-top: 5px solid var(--khaki);
      border-bottom: 1px solid var(--line);
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--khaki);
      font-size: .76rem;
      font-weight: 800;
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    h1,
    h2,
    h3,
    p {
      margin-top: 0;
    }

    h1 {
      margin-bottom: 7px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(1.8rem, 4vw, 3.35rem);
      font-weight: 700;
      line-height: 1;
      letter-spacing: -.035em;
    }

    .subtitle {
      max-width: 720px;
      margin-bottom: 0;
      color: var(--muted);
      font-size: .94rem;
      line-height: 1.65;
    }

    .stamp {
      flex: 0 0 auto;
      min-width: 134px;
      padding: 10px 12px;
      border: 2px solid var(--warning);
      color: var(--warning);
      font-size: .72rem;
      font-weight: 900;
      line-height: 1.45;
      letter-spacing: .12em;
      text-align: center;
      transform: rotate(1.5deg);
    }

    .status-strip {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      min-height: 54px;
      margin: 18px 0;
      padding: 11px 14px;
      border: 1px solid var(--line-soft);
      background: rgba(34, 39, 31, .92);
      box-shadow: 0 8px 24px var(--shadow);
    }

    .status-copy {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      color: var(--muted);
      font-size: .86rem;
    }

    .signal {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--olive);
      box-shadow: 0 0 0 4px rgba(135, 144, 102, .14);
    }

    .signal.busy {
      background: var(--warning);
      box-shadow: 0 0 0 4px rgba(209, 163, 92, .14);
    }

    .status-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .refresh {
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid var(--line);
      color: var(--ink);
      background: transparent;
      cursor: pointer;
    }

    .refresh:hover:not(:disabled) {
      border-color: var(--khaki);
      background: rgba(197, 179, 122, .08);
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(310px, .82fr) minmax(420px, 1.38fr);
      gap: 18px;
      align-items: start;
    }

    .column {
      display: grid;
      gap: 18px;
      min-width: 0;
    }

    .panel {
      min-width: 0;
      border: 1px solid var(--line-soft);
      background: rgba(34, 39, 31, .94);
      box-shadow: 0 12px 30px var(--shadow);
    }

    .panel-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      min-height: 54px;
      padding: 15px 17px 12px;
      border-bottom: 1px solid var(--line-soft);
    }

    .panel-header h2 {
      margin-bottom: 0;
      font-size: 1rem;
      letter-spacing: .03em;
    }

    .panel-kicker {
      color: var(--muted);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .7rem;
      letter-spacing: .06em;
    }

    .panel-body {
      padding: 17px;
    }

    .city-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
      padding-bottom: 13px;
      border-bottom: 1px dashed var(--line);
    }

    .city-name {
      overflow-wrap: anywhere;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .92rem;
      font-weight: 800;
    }

    .version {
      flex: 0 0 auto;
      color: var(--khaki);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .76rem;
    }

    .section-label {
      margin: 20px 0 9px;
      color: var(--muted);
      font-size: .7rem;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      min-width: 0;
      padding: 10px 11px;
      border-left: 3px solid var(--olive);
      background: var(--panel-raised);
    }

    .metric dt,
    .metric dd {
      margin: 0;
    }

    .metric dt {
      overflow: hidden;
      color: var(--muted);
      font-size: .68rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .metric dd {
      margin-top: 3px;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .94rem;
      font-weight: 800;
    }

    .building-list,
    .army-list,
    .steps,
    .recommendations,
    .threat-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .building-list,
    .army-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 12px;
    }

    .building-list li,
    .army-list li {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 0;
      border-bottom: 1px dotted var(--line-soft);
      color: var(--muted);
      font-size: .78rem;
    }

    .building-list strong,
    .army-list strong {
      color: var(--ink);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    }

    .empty {
      margin: 0;
      padding: 12px;
      border: 1px dashed var(--line);
      color: var(--muted);
      font-size: .8rem;
      line-height: 1.6;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    .steps {
      counter-reset: operation-step;
    }

    .steps li {
      position: relative;
      min-height: 46px;
      padding: 4px 0 12px 47px;
      color: var(--muted);
      font-size: .78rem;
      line-height: 1.45;
      counter-increment: operation-step;
    }

    .steps li:not(:last-child)::after {
      position: absolute;
      top: 29px;
      bottom: -2px;
      left: 15px;
      width: 1px;
      content: "";
      background: var(--line);
    }

    .steps li::before {
      position: absolute;
      top: 0;
      left: 0;
      display: grid;
      width: 31px;
      height: 31px;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 50%;
      content: counter(operation-step);
      color: var(--muted);
      background: var(--canvas);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-weight: 800;
    }

    .steps li.done {
      color: var(--ink);
    }

    .steps li.done::before {
      border-color: var(--success);
      color: #11140f;
      background: var(--success);
    }

    .steps strong {
      display: block;
      color: inherit;
      font-size: .84rem;
    }

    .action-list {
      display: grid;
      gap: 10px;
    }

    .action {
      display: grid;
      grid-template-columns: 43px minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-height: 74px;
      padding: 10px 11px;
      border: 1px solid var(--line-soft);
      background: var(--panel-raised);
    }

    .action-number {
      display: grid;
      width: 39px;
      height: 39px;
      place-items: center;
      border: 1px solid var(--line);
      color: var(--khaki);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.15rem;
    }

    .action-copy {
      min-width: 0;
    }

    .action-copy strong {
      display: block;
      margin-bottom: 3px;
      font-size: .88rem;
    }

    .action-copy span {
      display: block;
      color: var(--muted);
      font-size: .71rem;
      line-height: 1.5;
    }

    .action-button {
      min-height: 40px;
      padding: 8px 13px;
      border: 1px solid var(--khaki);
      color: #171a16;
      background: var(--khaki);
      font-size: .76rem;
      font-weight: 900;
      cursor: pointer;
    }

    .action-button:hover:not(:disabled) {
      background: #dcc88b;
    }

    button:disabled {
      cursor: wait;
      opacity: .46;
    }

    .notice {
      margin-bottom: 14px;
      padding: 11px 13px;
      border-left: 4px solid var(--warning);
      color: var(--muted);
      background: rgba(209, 163, 92, .08);
      font-size: .77rem;
      line-height: 1.6;
    }

    .error-box {
      display: none;
      margin-bottom: 14px;
      padding: 12px 14px;
      border: 1px solid var(--danger);
      color: #f4d6cf;
      background: rgba(122, 44, 32, .28);
      font-size: .8rem;
      line-height: 1.55;
    }

    .error-box.visible {
      display: block;
    }

    .error-code {
      display: block;
      margin-bottom: 3px;
      color: var(--danger);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .72rem;
      font-weight: 900;
    }

    .reports {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .report {
      min-width: 0;
      padding: 14px;
      border: 1px solid var(--line-soft);
      background: var(--panel-raised);
    }

    .report h3 {
      margin-bottom: 11px;
      color: var(--khaki);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.02rem;
    }

    .report dl {
      display: grid;
      grid-template-columns: minmax(82px, .7fr) minmax(0, 1.3fr);
      gap: 7px 10px;
      margin: 0;
      font-size: .75rem;
    }

    .report dt {
      color: var(--muted);
    }

    .report dd {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
      color: var(--ink);
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      text-align: right;
    }

    .report-subhead {
      margin: 14px 0 7px;
      color: var(--muted);
      font-size: .68rem;
      font-weight: 800;
      letter-spacing: .08em;
    }

    .recommendations li,
    .threat-list li {
      position: relative;
      margin: 5px 0;
      padding-left: 13px;
      color: var(--ink);
      font-size: .73rem;
      line-height: 1.5;
    }

    .recommendations li::before,
    .threat-list li::before {
      position: absolute;
      top: .65em;
      left: 0;
      width: 5px;
      height: 5px;
      content: "";
      background: var(--olive);
      transform: rotate(45deg);
    }

    details {
      margin-top: 12px;
      border-top: 1px dotted var(--line);
      padding-top: 9px;
    }

    summary {
      color: var(--muted);
      font-size: .7rem;
      cursor: pointer;
    }

    pre {
      max-height: 230px;
      margin: 9px 0 0;
      padding: 10px;
      overflow: auto;
      border: 1px solid var(--line-soft);
      color: #cbd1bb;
      background: #171a16;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      font-size: .66rem;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: .68rem;
      line-height: 1.5;
    }

    @media (max-width: 940px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 650px) {
      .shell {
        padding-inline: 12px;
      }

      .masthead {
        display: block;
      }

      .stamp {
        width: fit-content;
        margin-top: 18px;
      }

      .status-strip {
        grid-template-columns: 1fr;
      }

      .refresh {
        width: 100%;
      }

      .metric-grid,
      .building-list,
      .army-list,
      .reports {
        grid-template-columns: 1fr;
      }

      .action {
        grid-template-columns: 38px minmax(0, 1fr);
      }

      .action-button {
        grid-column: 1 / -1;
        width: 100%;
      }

      .footer {
        display: block;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">작전 화면으로 건너뛰기</a>
  <div class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">Victory 1944 / Field Operations</p>
        <h1>첫 작전 검증판</h1>
        <p class="subtitle">도시 성장에서 동원·정찰·NPC 전투·영구 보고서까지 한 흐름으로 확인합니다. 모든 계산과 판정은 서버 응답을 기준으로 표시합니다.</p>
      </div>
      <div class="stamp" aria-label="내부 검증용, 공개 배포 금지">내부 검증용<br>공개 배포 금지</div>
    </header>

    <div class="status-strip" aria-live="polite" aria-atomic="true">
      <div class="status-copy">
        <span class="signal" id="signal" aria-hidden="true"></span>
        <span class="status-text" id="status">서버 상태를 불러오는 중입니다.</span>
      </div>
      <button class="refresh" id="refresh" type="button">최신 상태 갱신</button>
    </div>

    <div class="error-box" id="error" tabindex="-1" role="alert">
      <span class="error-code" id="error-code"></span>
      <span id="error-message"></span>
    </div>

    <main class="grid" id="main">
      <div class="column">
        <section class="panel" aria-labelledby="city-heading">
          <header class="panel-header">
            <h2 id="city-heading">도시 상황</h2>
            <span class="panel-kicker">AUTHORITATIVE SNAPSHOT</span>
          </header>
          <div class="panel-body">
            <div class="city-line">
              <span class="city-name" id="city-id">—</span>
              <span class="version" id="city-version">VERSION —</span>
            </div>
            <p class="section-label">자원</p>
            <dl class="metric-grid" id="resources"></dl>
            <p class="section-label">시설</p>
            <ul class="building-list" id="buildings"></ul>
            <p class="section-label">가용 병력</p>
            <ul class="army-list" id="army"></ul>
          </div>
        </section>

        <section class="panel" aria-labelledby="progress-heading">
          <header class="panel-header">
            <h2 id="progress-heading">작전 단계</h2>
            <span class="panel-kicker">FIRST LOOP</span>
          </header>
          <div class="panel-body">
            <ol class="steps" id="steps" aria-label="첫 루프 진행 단계"></ol>
          </div>
        </section>
      </div>

      <div class="column">
        <section class="panel" aria-labelledby="orders-heading">
          <header class="panel-header">
            <h2 id="orders-heading">명령판</h2>
            <span class="panel-kicker">SERVER COMMANDS</span>
          </header>
          <div class="panel-body">
            <p class="notice">이 화면은 출시 클라이언트가 아닙니다. 루프백 환경에서 서버 권위 경로와 저장 결과를 사람이 직접 확인하는 일회성 하네스입니다.</p>
            <div class="action-list">
              <div class="action">
                <span class="action-number" aria-hidden="true">I</span>
                <div class="action-copy">
                  <strong>농장 증설</strong>
                  <span>현재 도시 version으로 farm 건설을 시작합니다. 완료는 건설 워커가 처리합니다.</span>
                </div>
                <button class="action-button command" id="build-farm" type="button">건설 시작</button>
              </div>
              <div class="action">
                <span class="action-number" aria-hidden="true">II</span>
                <div class="action-copy">
                  <strong>추천 부대 동원</strong>
                  <span>소총 10 · 중형전차 2 · 정찰 1 · 곡사포 1</span>
                </div>
                <button class="action-button command" id="mobilize" type="button">즉시 동원</button>
              </div>
              <div class="action">
                <span class="action-number" aria-hidden="true">III</span>
                <div class="action-copy">
                  <strong>훈련 전초기지 정찰</strong>
                  <span>정찰 비용과 정확도는 서버가 계산하며, 보고서는 6시간 뒤 만료됩니다.</span>
                </div>
                <button class="action-button command" id="recon" type="button">정찰 실행</button>
              </div>
              <div class="action">
                <span class="action-number" aria-hidden="true">IV</span>
                <div class="action-copy">
                  <strong>NPC 전초기지 공격</strong>
                  <span>가용 병력으로 전·중·후열을 편성하고 포병 지원 교리를 적용합니다.</span>
                </div>
                <button class="action-button command" id="battle" type="button">공격 개시</button>
              </div>
            </div>
          </div>
        </section>

        <section class="panel" aria-labelledby="reports-heading">
          <header class="panel-header">
            <h2 id="reports-heading">작전 보고서</h2>
            <span class="panel-kicker">PERSISTED EVIDENCE</span>
          </header>
          <div class="panel-body reports">
            <article class="report" aria-labelledby="recon-heading">
              <h3 id="recon-heading">최신 정찰 보고</h3>
              <div id="recon-report" class="empty">저장된 정찰 보고서가 없습니다.</div>
            </article>
            <article class="report" aria-labelledby="battle-heading">
              <h3 id="battle-heading">최신 전투 보고</h3>
              <div id="battle-report" class="empty">저장된 전투 보고서가 없습니다.</div>
            </article>
          </div>
        </section>
      </div>
    </main>

    <footer class="footer">
      <span>규칙·비용·seed·판정은 화면에서 계산하지 않습니다.</span>
      <span>Bearer 토큰은 이 루프백 문서의 실행 메모리에만 유지됩니다.</span>
    </footer>
  </div>

  <script>
    (() => {
      'use strict';

      const TOKEN = ${token};
      const CITY_ID = ${cityId};
      const SCENARIO_ID = 'training_outpost';
      const DOCTRINE = 'artillery_support';
      const RECOMMENDED_FORCE = Object.freeze([
        { unitId: 'rifle', count: 10 },
        { unitId: 'medium_tank', count: 2 },
        { unitId: 'scout', count: 1 },
        { unitId: 'howitzer', count: 1 }
      ]);
      const ROW_BY_UNIT = Object.freeze({
        rifle: 'front',
        at_infantry: 'front',
        medium_tank: 'front',
        heavy_tank: 'front',
        engineer: 'front',
        scout: 'mid',
        at_gun: 'mid',
        aa_gun: 'mid',
        supply_truck: 'mid',
        howitzer: 'back',
        fighter: 'back',
        bomber: 'back'
      });
      const RESOURCE_LABELS = Object.freeze({
        food: '식량',
        steel: '강철',
        oil: '석유',
        supplies: '보급품',
        manpower: '인력',
        scrip: '군표'
      });
      const BUILDING_LABELS = Object.freeze({
        hq: '사령부',
        farm: '농장',
        steel_mill: '제철소',
        refinery: '정유소',
        supply_depot: '물류센터',
        housing: '주거지',
        warehouse: '창고'
      });
      const UNIT_LABELS = Object.freeze({
        rifle: '소총병',
        at_infantry: '대전차보병',
        scout: '정찰차량',
        medium_tank: '중형전차',
        heavy_tank: '중전차',
        howitzer: '곡사포',
        at_gun: '대전차포',
        aa_gun: '대공포',
        fighter: '전투기',
        bomber: '폭격기',
        engineer: '공병',
        supply_truck: '보급트럭'
      });
      const OUTCOME_LABELS = Object.freeze({
        attacker_win: '공격 승리',
        defender_win: '공격 실패',
        draw: '무승부'
      });
      const REASON_LABELS = Object.freeze({
        annihilation: '섬멸',
        retreat: '철수',
        timeout: '교착',
        mutual_retreat: '상호 철수'
      });

      const model = {
        operations: null,
        nowHour: null,
        busy: false
      };

      const statusElement = document.getElementById('status');
      const signalElement = document.getElementById('signal');
      const errorElement = document.getElementById('error');
      const errorCodeElement = document.getElementById('error-code');
      const errorMessageElement = document.getElementById('error-message');
      const refreshButton = document.getElementById('refresh');
      const commandButtons = Array.from(document.querySelectorAll('.command'));

      function text(element, value) {
        element.textContent = String(value);
      }

      function record(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value
          : {};
      }

      function numeric(value, fallback) {
        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      }

      function firstDefined(values) {
        for (const value of values) {
          if (value !== undefined && value !== null) return value;
        }
        return undefined;
      }

      function latestEntry(value) {
        if (!Array.isArray(value) || value.length === 0) return null;
        return value.reduce((latest, candidate) => {
          const latestRecord = record(latest);
          const candidateRecord = record(candidate);
          const latestHour = numeric(firstDefined([
            latestRecord.createdAtHour,
            latestRecord.startedAtHour,
            latestRecord.generatedAtHour
          ]), -1);
          const candidateHour = numeric(firstDefined([
            candidateRecord.createdAtHour,
            candidateRecord.startedAtHour,
            candidateRecord.generatedAtHour
          ]), -1);
          return candidateHour >= latestHour ? candidate : latest;
        });
      }

      function rootState() {
        return record(model.operations);
      }

      function cityState() {
        const root = rootState();
        const snapshot = record(root.snapshot);
        return record(firstDefined([root.city, snapshot.city, snapshot, root]));
      }

      function currentVersion() {
        const root = rootState();
        const city = cityState();
        const snapshot = record(root.snapshot);
        const candidate = firstDefined([
          city.version,
          root.cityVersion,
          root.version,
          snapshot.cityVersion,
          snapshot.version
        ]);
        const version = numeric(candidate, NaN);
        if (!Number.isSafeInteger(version) || version < 0) {
          const error = new Error('최신 도시 version을 확인할 수 없습니다. 상태를 다시 불러오십시오.');
          error.code = 'STATE_UNAVAILABLE';
          throw error;
        }
        return version;
      }

      function authoritativeNowHour() {
        const root = rootState();
        const city = cityState();
        const snapshot = record(root.snapshot);
        const candidate = firstDefined([
          model.nowHour,
          root.nowHour,
          snapshot.nowHour,
          city.nowHour,
          root.lastServerHour,
          snapshot.lastServerHour,
          city.lastServerHour
        ]);
        const nowHour = numeric(candidate, NaN);
        if (!Number.isSafeInteger(nowHour) || nowHour < 0) {
          const error = new Error('권위 서버 시각을 확인할 수 없습니다. 상태를 다시 불러오십시오.');
          error.code = 'STATE_UNAVAILABLE';
          throw error;
        }
        return nowHour;
      }

      function latestRecon() {
        const root = rootState();
        const snapshot = record(root.snapshot);
        return firstDefined([
          root.latestRecon,
          root.latestReconReport,
          snapshot.latestRecon,
          snapshot.latestReconReport,
          latestEntry(root.reconReports),
          latestEntry(snapshot.reconReports)
        ]) || null;
      }

      function reconValidity(rawReport) {
        const data = record(rawReport);
        const reportBody = record(firstDefined([data.report, data.summary, data]));
        const expiresAtHour = numeric(firstDefined([
          data.expiresAtHour,
          reportBody.expiresAtHour
        ]), NaN);
        if (!Number.isSafeInteger(expiresAtHour) || expiresAtHour < 0) {
          const error = new Error('정찰 보고서의 만료 시각이 유효하지 않습니다.');
          error.code = 'STATE_UNAVAILABLE';
          throw error;
        }
        const nowHour = authoritativeNowHour();
        return {
          nowHour,
          expiresAtHour,
          remainingHours: Math.max(0, expiresAtHour - nowHour),
          expired: nowHour >= expiresAtHour
        };
      }

      function requireActiveRecon() {
        const report = latestRecon();
        if (report === null) {
          const error = new Error('공격 전에 유효한 정찰 보고서가 필요합니다.');
          error.code = 'RECON_REQUIRED';
          throw error;
        }
        const validity = reconValidity(report);
        if (validity.expired) {
          const error = new Error(
            '정찰 보고서가 서버 시각 ' + validity.expiresAtHour
            + '에 만료되었습니다. 다시 정찰한 뒤 공격하십시오.'
          );
          error.code = 'RECON_EXPIRED';
          throw error;
        }
        return report;
      }

      function latestBattle() {
        const root = rootState();
        const snapshot = record(root.snapshot);
        return firstDefined([
          root.latestBattle,
          root.latestBattleReport,
          snapshot.latestBattle,
          snapshot.latestBattleReport,
          latestEntry(root.battleReports),
          latestEntry(snapshot.battleReports)
        ]) || null;
      }

      function readyArmy() {
        const root = rootState();
        const snapshot = record(root.snapshot);
        const city = cityState();
        const armyContainer = record(firstDefined([root.army, snapshot.army, city.army]));
        const source = firstDefined([
          root.readyArmy,
          snapshot.readyArmy,
          city.readyArmy,
          armyContainer.ready,
          armyContainer.units,
          armyContainer
        ]);
        const result = {};

        if (Array.isArray(source)) {
          for (const raw of source) {
            const entry = record(raw);
            if (typeof entry.unitId !== 'string') continue;
            const count = numeric(firstDefined([entry.ready, entry.count, entry.quantity]), 0);
            if (Number.isSafeInteger(count) && count >= 0) result[entry.unitId] = count;
          }
          return result;
        }

        for (const [unitId, raw] of Object.entries(record(source))) {
          const entry = record(raw);
          const count = typeof raw === 'object' && raw !== null
            ? numeric(firstDefined([entry.ready, entry.count, entry.quantity]), 0)
            : numeric(raw, 0);
          if (Number.isSafeInteger(count) && count >= 0) result[unitId] = count;
        }
        return result;
      }

      function commandId(prefix) {
        const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
        return 'prototype:' + prefix + ':' + suffix;
      }

      async function api(path, options) {
        const request = options || {};
        const headers = new Headers(request.headers || {});
        headers.set('authorization', 'Bearer ' + TOKEN);
        headers.set('accept', 'application/json');
        if (request.body !== undefined) headers.set('content-type', 'application/json');

        const response = await fetch(path, {
          method: request.method || 'GET',
          headers,
          body: request.body,
          cache: 'no-store',
          credentials: 'same-origin'
        });
        const raw = await response.text();
        let payload = {};
        if (raw.length > 0) {
          try {
            payload = JSON.parse(raw);
          } catch {
            const parseError = new Error('서버가 JSON이 아닌 응답을 반환했습니다.');
            parseError.code = 'INVALID_RESPONSE';
            throw parseError;
          }
        }
        if (!response.ok) {
          const body = record(payload);
          const failure = new Error(
            typeof body.message === 'string' ? body.message : '명령이 거부되었습니다.'
          );
          failure.code = typeof body.code === 'string' ? body.code : 'HTTP_' + response.status;
          throw failure;
        }
        return payload;
      }

      function clearError() {
        errorElement.classList.remove('visible');
        text(errorCodeElement, '');
        text(errorMessageElement, '');
      }

      function showError(error) {
        const candidate = record(error);
        const code = typeof candidate.code === 'string' ? candidate.code : 'UNEXPECTED_ERROR';
        const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
        text(errorCodeElement, code);
        text(errorMessageElement, message);
        errorElement.classList.add('visible');
        errorElement.focus({ preventScroll: true });
      }

      function setStatus(message, busy) {
        model.busy = busy;
        text(statusElement, message);
        signalElement.classList.toggle('busy', busy);
        refreshButton.disabled = busy;
        for (const button of commandButtons) button.disabled = busy || model.operations === null;
      }

      function appendEmpty(parent, message) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = message;
        parent.append(empty);
      }

      function renderResources() {
        const root = rootState();
        const city = cityState();
        const microSource = firstDefined([city.resourcesMicro, root.resourcesMicro]);
        const regularSource = firstDefined([city.resources, root.resources]);
        const isMicro = microSource !== undefined;
        const resources = record(isMicro ? microSource : regularSource);
        const container = document.getElementById('resources');
        container.replaceChildren();

        const knownOrder = ['food', 'steel', 'oil', 'supplies', 'manpower', 'scrip'];
        const keys = Array.from(new Set(knownOrder.concat(Object.keys(resources))))
          .filter((key) => resources[key] !== undefined);
        if (keys.length === 0) {
          const note = document.createElement('p');
          note.className = 'empty';
          note.textContent = '자원 스냅샷이 없습니다.';
          container.append(note);
          return;
        }

        for (const resourceId of keys) {
          const metric = document.createElement('div');
          metric.className = 'metric';
          const term = document.createElement('dt');
          term.textContent = RESOURCE_LABELS[resourceId] || resourceId;
          const description = document.createElement('dd');
          const raw = numeric(resources[resourceId], 0);
          const amount = isMicro ? raw / 1000 : raw;
          description.textContent = new Intl.NumberFormat('ko-KR', {
            maximumFractionDigits: 3
          }).format(amount);
          metric.append(term, description);
          container.append(metric);
        }
      }

      function renderBuildings() {
        const root = rootState();
        const city = cityState();
        const buildings = record(firstDefined([city.buildings, root.buildings]));
        const container = document.getElementById('buildings');
        container.replaceChildren();
        const entries = Object.entries(buildings);
        if (entries.length === 0) {
          appendEmpty(container, '시설 스냅샷이 없습니다.');
          return;
        }
        for (const [buildingId, level] of entries) {
          const item = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = BUILDING_LABELS[buildingId] || buildingId;
          const value = document.createElement('strong');
          value.textContent = 'Lv.' + numeric(level, 0);
          item.append(label, value);
          container.append(item);
        }
      }

      function renderArmy() {
        const army = readyArmy();
        const container = document.getElementById('army');
        container.replaceChildren();
        const entries = Object.entries(army).filter(([, count]) => numeric(count, 0) > 0);
        if (entries.length === 0) {
          appendEmpty(container, '가용 병력이 없습니다. 추천 부대를 동원하십시오.');
          return;
        }
        for (const [unitId, count] of entries) {
          const item = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = UNIT_LABELS[unitId] || unitId;
          const value = document.createElement('strong');
          value.textContent = String(count);
          item.append(label, value);
          container.append(item);
        }
      }

      function renderSteps() {
        const root = rootState();
        const city = cityState();
        const buildings = record(firstDefined([city.buildings, root.buildings]));
        const jobs = firstDefined([city.jobs, root.jobs]);
        const farmJobs = Array.isArray(jobs)
          ? jobs.map((raw) => record(raw)).filter((job) => job.buildingId === 'farm')
          : [];
        const farmPending = farmJobs.some((job) => job.status === 'pending');
        const farmCompleted = numeric(buildings.farm, 0) > 1
          || farmJobs.some((job) => job.status === 'completed');
        const army = readyArmy();
        const hasArmy = Object.values(army).some((count) => numeric(count, 0) > 0);
        const providedSteps = firstDefined([root.steps, record(root.snapshot).steps]);
        const computed = [
          {
            key: 'construction',
            title: '도시 성장',
            detail: farmPending
              ? '농장 건설 진행 중 · 건설 워커 완료 대기'
              : '농장 증설 명령과 건설 워커 완료 확인',
            done: farmCompleted
          },
          { key: 'mobilization', title: '병력 동원', detail: '비용 차감과 가용 병력 영구 저장', done: hasArmy },
          { key: 'recon', title: '정찰', detail: '정확도·만료 시각·적 위협 보고', done: latestRecon() !== null },
          { key: 'battle', title: '첫 전투', detail: '서버 seed·사상자·보상·결과 hash 저장', done: latestBattle() !== null }
        ];

        if (Array.isArray(providedSteps)) {
          for (const step of computed) {
            if (step.key === 'construction') continue;
            const match = providedSteps.find((raw) => record(raw).key === step.key);
            if (match) {
              const entry = record(match);
              step.done = entry.done === true || entry.status === 'completed';
            }
          }
        }

        const container = document.getElementById('steps');
        container.replaceChildren();
        for (const step of computed) {
          const item = document.createElement('li');
          if (step.done) item.classList.add('done');
          const semanticState = step.done ? '완료' : '미완료';
          item.dataset.status = step.done ? 'completed' : 'pending';
          item.setAttribute(
            'aria-label',
            semanticState + ' 단계: ' + step.title + '. ' + step.detail
          );
          const state = document.createElement('span');
          state.className = 'visually-hidden';
          state.textContent = '상태: ' + semanticState + '. ';
          const title = document.createElement('strong');
          title.textContent = step.title;
          const detail = document.createElement('span');
          detail.textContent = step.detail;
          item.append(state, title, detail);
          container.append(item);
        }
      }

      function appendDefinition(list, label, value) {
        if (value === undefined || value === null) return;
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = String(value);
        list.append(term, description);
      }

      function listValues(value) {
        if (Array.isArray(value)) {
          return value.map((entry) => {
            if (typeof entry === 'string') return entry;
            const data = record(entry);
            if (typeof data.messageKo === 'string') return data.messageKo;
            if (typeof data.message === 'string') return data.message;
            if (typeof data.label === 'string') return data.label;
            if (typeof data.unitId === 'string') {
              const dead = firstDefined([data.dead, data.killed]);
              const wounded = firstDefined([data.wounded, data.injured]);
              if (dead !== undefined || wounded !== undefined) {
                return (UNIT_LABELS[data.unitId] || data.unitId)
                  + ' 전사 ' + numeric(dead, 0)
                  + ' · 부상 ' + numeric(wounded, 0);
              }
              const low = firstDefined([data.minimum, data.min, data.low]);
              const high = firstDefined([data.maximum, data.max, data.high]);
              if (low !== undefined || high !== undefined) {
                return (UNIT_LABELS[data.unitId] || data.unitId)
                  + ' ' + (low ?? '?') + '–' + (high ?? '?');
              }
              const count = firstDefined([data.count, data.max, data.estimated]);
              return (UNIT_LABELS[data.unitId] || data.unitId)
                + (count === undefined ? '' : ' ' + count);
            }
            return JSON.stringify(entry);
          });
        }
        if (value !== null && typeof value === 'object') {
          return Object.entries(value).map(([key, entry]) => {
            if (entry !== null && typeof entry === 'object') {
              const data = record(entry);
              const low = firstDefined([data.minimum, data.min, data.low]);
              const high = firstDefined([data.maximum, data.max, data.high]);
              if (low !== undefined || high !== undefined) {
                return (UNIT_LABELS[key] || key) + ' ' + (low ?? '?') + '–' + (high ?? '?');
              }
            }
            return (UNIT_LABELS[key] || key) + ' ' + String(entry);
          });
        }
        return value === undefined || value === null ? [] : [String(value)];
      }

      function appendTextList(parent, values, className) {
        const list = document.createElement('ul');
        list.className = className;
        const entries = listValues(values);
        if (entries.length === 0) return;
        for (const entry of entries) {
          const item = document.createElement('li');
          item.textContent = entry;
          list.append(item);
        }
        parent.append(list);
      }

      function appendRawDetails(parent, value) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '저장 계약 원문 보기';
        const raw = document.createElement('pre');
        raw.textContent = JSON.stringify(value, null, 2);
        details.append(summary, raw);
        parent.append(details);
      }

      function renderReconReport() {
        const report = latestRecon();
        const container = document.getElementById('recon-report');
        container.replaceChildren();
        if (report === null) {
          container.className = 'empty';
          container.textContent = '저장된 정찰 보고서가 없습니다.';
          return;
        }
        container.className = '';
        const data = record(report);
        const reportBody = record(firstDefined([data.report, data.summary, data]));
        const validity = reconValidity(report);
        const validityStatus = document.createElement('p');
        validityStatus.setAttribute('role', 'status');
        validityStatus.setAttribute('aria-live', 'polite');
        validityStatus.className = validity.expired ? 'notice danger' : 'notice';
        validityStatus.textContent = validity.expired
          ? '만료됨 · 서버 시각 ' + validity.nowHour
            + ' 기준, ' + validity.expiresAtHour + '시부터 공격에 사용할 수 없습니다.'
          : '유효 · 서버 시각 ' + validity.nowHour
            + ' 기준 ' + validity.remainingHours + '시간 남음';
        container.append(validityStatus);
        const definitions = document.createElement('dl');
        const accuracyPermille = firstDefined([data.accuracyPermille, reportBody.accuracyPermille]);
        const accuracy = firstDefined([data.accuracy, reportBody.accuracy]);
        appendDefinition(definitions, '목표', firstDefined([
          data.scenarioNameKo,
          reportBody.scenarioNameKo,
          data.scenarioId,
          reportBody.scenarioId,
          SCENARIO_ID
        ]));
        appendDefinition(definitions, '정확도', accuracyPermille !== undefined
          ? (numeric(accuracyPermille, 0) / 10).toFixed(1) + '%'
          : accuracy !== undefined
            ? (numeric(accuracy, 0) * 100).toFixed(1) + '%'
            : undefined);
        appendDefinition(definitions, '생성 시각', firstDefined([
          data.createdAtHour,
          data.generatedAtHour,
          reportBody.createdAtHour
        ]));
        appendDefinition(definitions, '만료 시각', firstDefined([
          data.expiresAtHour,
          reportBody.expiresAtHour
        ]));
        appendDefinition(definitions, '상태', validity.expired ? '만료' : '유효');
        appendDefinition(definitions, '남은 유효 시간', validity.remainingHours + '시간');
        container.append(definitions);

        const threats = firstDefined([
          reportBody.threats,
          reportBody.threat,
          data.threats,
          data.threat
        ]);
        const estimates = firstDefined([
          reportBody.forceEstimate,
          reportBody.estimatedForces,
          reportBody.estimatedUnits,
          data.forceEstimate,
          data.estimatedUnits
        ]);
        if (listValues(estimates).length > 0) {
          const heading = document.createElement('p');
          heading.className = 'report-subhead';
          heading.textContent = '추정 병력 범위';
          container.append(heading);
          appendTextList(container, estimates, 'threat-list');
        }
        if (listValues(threats).length > 0) {
          const heading = document.createElement('p');
          heading.className = 'report-subhead';
          heading.textContent = '식별 위협';
          container.append(heading);
          appendTextList(container, threats, 'threat-list');
        }
        appendRawDetails(container, report);
      }

      function casualtySummary(data) {
        const direct = firstDefined([data.casualties, data.attackerCasualties]);
        if (direct !== undefined) return direct;
        const result = record(data.result);
        const attacker = record(result.attacker);
        if (!Array.isArray(attacker.stacks)) return undefined;
        return attacker.stacks
          .map((raw) => record(raw))
          .filter((stack) => numeric(stack.dead, 0) > 0 || numeric(stack.wounded, 0) > 0)
          .map((stack) => {
            return (UNIT_LABELS[stack.unitId] || stack.unitId || '병종')
              + ' 전사 ' + numeric(stack.dead, 0)
              + ' · 부상 ' + numeric(stack.wounded, 0);
          });
      }

      function renderBattleReport() {
        const report = latestBattle();
        const container = document.getElementById('battle-report');
        container.replaceChildren();
        if (report === null) {
          container.className = 'empty';
          container.textContent = '저장된 전투 보고서가 없습니다.';
          return;
        }
        container.className = '';
        const data = record(report);
        const reportBody = record(firstDefined([data.report, data.summary, data]));
        const result = record(firstDefined([data.result, reportBody.result]));
        const outcome = firstDefined([data.outcome, reportBody.outcome, result.outcome]);
        const reason = firstDefined([data.reason, reportBody.reason, result.reason]);
        const definitions = document.createElement('dl');
        appendDefinition(definitions, '결과', OUTCOME_LABELS[outcome] || outcome);
        appendDefinition(definitions, '종료 사유', REASON_LABELS[reason] || reason);
        appendDefinition(definitions, '라운드', firstDefined([
          data.rounds,
          reportBody.rounds,
          result.rounds
        ]));
        appendDefinition(definitions, '교리', firstDefined([data.doctrine, reportBody.doctrine, DOCTRINE]));
        appendDefinition(definitions, '서버 seed', firstDefined([data.seed, reportBody.seed, result.seed]));
        appendDefinition(definitions, '결과 hash', firstDefined([
          data.resultHash,
          data.hash,
          reportBody.resultHash,
          result.hash
        ]));
        appendDefinition(definitions, '보상', listValues(firstDefined([
          data.reward,
          reportBody.reward
        ])).join(', ') || undefined);
        container.append(definitions);

        const casualties = casualtySummary(data);
        if (listValues(casualties).length > 0) {
          const heading = document.createElement('p');
          heading.className = 'report-subhead';
          heading.textContent = '아군 사상자';
          container.append(heading);
          appendTextList(container, casualties, 'threat-list');
        }

        const analysis = record(firstDefined([reportBody.analysis, data.analysis]));
        const recommendations = firstDefined([
          reportBody.recommendations,
          reportBody.improvements,
          analysis.recommendations,
          analysis.improvements,
          data.recommendations,
          data.improvements
        ]);
        if (listValues(recommendations).length > 0) {
          const heading = document.createElement('p');
          heading.className = 'report-subhead';
          heading.textContent = '다음 출정 개선';
          container.append(heading);
          appendTextList(container, recommendations, 'recommendations');
        }
        appendRawDetails(container, report);
      }

      function render() {
        const root = rootState();
        const city = cityState();
        text(document.getElementById('city-id'), firstDefined([city.id, root.cityId, CITY_ID]));
        let version = '—';
        try {
          version = currentVersion();
        } catch {
          version = '—';
        }
        text(document.getElementById('city-version'), 'VERSION ' + version);
        renderResources();
        renderBuildings();
        renderArmy();
        renderSteps();
        renderReconReport();
        renderBattleReport();
      }

      async function loadOperations() {
        const snapshots = await Promise.all([
          api('/v1/cities/' + encodeURIComponent(CITY_ID) + '/operations'),
          api('/health')
        ]);
        const payload = snapshots[0];
        const clockSnapshot = record(snapshots[1]);
        const nowHour = numeric(clockSnapshot.nowHour, NaN);
        if (!Number.isSafeInteger(nowHour) || nowHour < 0) {
          const error = new Error('서버 시각 스냅샷이 유효하지 않습니다.');
          error.code = 'INVALID_RESPONSE';
          throw error;
        }
        model.operations = payload;
        model.nowHour = nowHour;
        render();
        return payload;
      }

      async function refresh() {
        clearError();
        setStatus('서버에서 최신 도시·작전 스냅샷을 조회합니다.', true);
        try {
          await loadOperations();
          setStatus('최신 권위 상태를 불러왔습니다.', false);
        } catch (error) {
          showError(error);
          setStatus('상태 조회가 실패했습니다.', false);
        }
      }

      async function runCommand(label, path, makeBody, commandOptions) {
        const settings = record(commandOptions);
        clearError();
        setStatus(label + ' 명령을 서버에 제출합니다.', true);
        try {
          if (model.operations === null || settings.refreshBefore === true) {
            await loadOperations();
          }
          let staleRetryCount = 0;
          while (true) {
            try {
              const body = makeBody(currentVersion());
              const response = await api(path, {
                method: 'POST',
                body: JSON.stringify(body)
              });
              await loadOperations();
              const responseRecord = record(response);
              const replayed = responseRecord.replayed === true ? ' · 저장 영수증 재생' : '';
              setStatus(label + ' 명령이 반영되었습니다' + replayed + '.', false);
              return;
            } catch (error) {
              const errorCode = record(error).code;
              if (errorCode === 'STALE_VERSION' && staleRetryCount === 0) {
                staleRetryCount += 1;
                setStatus(
                  label + ' 도중 서버 version이 변경되었습니다. 최신 상태 조회 후 1회 재시도합니다.',
                  true
                );
                await loadOperations();
                continue;
              }
              throw error;
            }
          }
        } catch (error) {
          showError(error);
          setStatus(label + ' 명령이 거부되었습니다.', false);
        }
      }

      document.getElementById('build-farm').addEventListener('click', () => {
        void runCommand(
          '농장 건설',
          '/v1/cities/' + encodeURIComponent(CITY_ID) + '/constructions',
          (expectedVersion) => ({
            commandId: commandId('construction'),
            expectedVersion,
            buildingId: 'farm'
          })
        );
      });

      document.getElementById('mobilize').addEventListener('click', () => {
        void runCommand(
          '추천 부대 동원',
          '/v1/cities/' + encodeURIComponent(CITY_ID) + '/mobilizations',
          (expectedVersion) => ({
            commandId: commandId('mobilization'),
            expectedVersion,
            units: RECOMMENDED_FORCE.map((unit) => ({ ...unit }))
          })
        );
      });

      document.getElementById('recon').addEventListener('click', () => {
        void runCommand(
          '훈련 전초기지 정찰',
          '/v1/cities/' + encodeURIComponent(CITY_ID) + '/recon',
          (expectedVersion) => ({
            commandId: commandId('recon'),
            expectedVersion,
            scenarioId: SCENARIO_ID
          })
        );
      });

      document.getElementById('battle').addEventListener('click', () => {
        void runCommand(
          'NPC 전초기지 공격',
          '/v1/cities/' + encodeURIComponent(CITY_ID) + '/battles',
          (expectedVersion) => {
            requireActiveRecon();
            const army = readyArmy();
            const deployment = Object.entries(army)
              .filter(([, count]) => numeric(count, 0) > 0)
              .map(([unitId, count]) => ({
                unitId,
                count,
                row: ROW_BY_UNIT[unitId] || 'mid'
              }));
            if (deployment.length === 0) {
              const error = new Error('공격에 배치할 가용 병력이 없습니다.');
              error.code = 'EMPTY_DEPLOYMENT';
              throw error;
            }
            return {
              commandId: commandId('battle'),
              expectedVersion,
              scenarioId: SCENARIO_ID,
              doctrine: DOCTRINE,
              deployment
            };
          },
          { refreshBefore: true }
        );
      });

      refreshButton.addEventListener('click', () => {
        void refresh();
      });

      text(document.getElementById('city-id'), CITY_ID);
      void refresh();
    })();
  </script>
</body>
</html>`;
}

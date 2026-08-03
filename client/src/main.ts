import {
  ApiError,
  GameApi,
  apiBaseUrl,
  clearDevice,
  clearSession,
  guidanceFor,
  isInsecureApi,
  newCommandId,
  openSession,
  type DeploymentEntry,
  type Session,
} from './api/client.js';
import {
  BUILDING_LABELS,
  fromMicro,
  type BuildingId,
  type OperationsSnapshot,
  type Row,
} from './api/contract.js';
import { play, setSoundEnabled, soundEnabled, type SoundName } from './audio/sfx.js';
import { CityScene } from './city/city-scene.js';
import { DISTRICTS, districtOf, type DistrictId } from './city/districts.js';
import { tabIcon } from './screens/icons.js';
import { CityNamePlate } from './screens/nameplate.js';
import { Tutorial } from './screens/tutorial.js';
import { Telemetry } from './api/telemetry.js';
import type { EventSubject } from './api/telemetry.js';
import {
  renderArmy,
  renderBattle,
  renderBuildQueue,
  renderBuildings,
  renderCitySelection,
  renderDoctrines,
  renderFormation,
  renderMobilize,
  renderObjective,
  renderResearch,
  renderRecon,
  renderScenarios,
  renderResources,
  renderSteps,
} from './screens/views.js';

/**
 * Victory 1944 모바일 클라이언트 셸(D-025).
 * 첫 루프(건설 → 동원 → 정찰 → 전투 → 보고서)를 서버 API로만 수행한다.
 * 규칙·비용·판정은 서버가 결정하고 이 화면은 결과를 표시한다.
 */

/** 교리를 고르지 않았을 때 쓰는 기본값. 추천 부대에 야포가 들어 있어 포병 지원으로 둔다. */
const DEFAULT_DOCTRINE = 'artillery_support';
const DOCTRINE_KEY = 'victory1944.doctrine.v1';
/**
 * 추천 편성의 후보. 앞에 있는 것이 우선순위가 높다.
 *
 * 해금되지 않은 병종은 걸러 내고(D-043), **지금 가진 자원 안에서만 채운다**(D-044).
 * 자원은 서버 스냅샷 값이고 비용도 서버가 준 `trainCost`다 — 비용 규칙을 화면이 복제하지 않는다.
 * 최종 판정은 여전히 서버가 하며, 이 계산은 "거부당할 편성을 제안하지 않기" 위한 것이다.
 */
const RECOMMENDED_FORCE = [
  { unitId: 'rifle', count: 10 },
  { unitId: 'scout', count: 1 },
  { unitId: 'howitzer', count: 1 },
  { unitId: 'at_infantry', count: 2 },
  { unitId: 'at_gun', count: 2 },
  { unitId: 'medium_tank', count: 2 },
  { unitId: 'fighter', count: 2 },
] as const;

type TabId = 'city' | 'operations' | 'reports' | 'settings';

/** 하단 탭. 아이콘은 코드로 그린 SVG다(D-053). */
const TABS: readonly { readonly id: TabId; readonly nameKo: string }[] = [
  { id: 'city', nameKo: '도시' },
  { id: 'operations', nameKo: '작전' },
  { id: 'reports', nameKo: '보고서' },
  { id: 'settings', nameKo: '설정' },
];

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('#app 요소가 없습니다.');

/**
 * 첫 실행 화면(D-039). 이용자는 아무것도 입력하지 않는다 —
 * 기기가 계정을 만들고 세션을 받아 바로 게임으로 들어간다.
 * 실패하면 다시 시도만 제공한다(주소·토큰을 손으로 넣게 하지 않는다).
 */
function bootScreen(message: string, retry: boolean): void {
  app!.innerHTML = `
    <div class="shell">
      <header class="topbar"><h1>Victory 1944</h1><span class="meta">1944년 전선</span></header>
      <div class="body">
        <div class="boot">
          <p class="boot-message" id="boot-message"></p>
          ${retry ? '<button class="action primary" type="button" id="boot-retry">다시 시도</button>' : ''}
        </div>
      </div>
    </div>
  `;
  document.querySelector<HTMLElement>('#boot-message')!.textContent = message;
  document.querySelector<HTMLButtonElement>('#boot-retry')?.addEventListener('click', () => {
    void boot();
  });
}

async function boot(): Promise<void> {
  bootScreen('사령부에 접속하는 중…', false);
  try {
    const session = await openSession();
    await gameScreen(session);
  } catch (error) {
    // 저장된 세션이 서버에서 사라졌으면(계정 삭제·DB 초기화) 비우고 다음 시도에 새로 만든다.
    if (error instanceof ApiError && error.code === 'UNAUTHORIZED') clearSession();
    bootScreen(guidanceFor(error), true);
  }
}

async function gameScreen(session: Session): Promise<void> {
  const api = new GameApi(session);
  const telemetry = new Telemetry(api);
  telemetry.record('session_start');
  let snapshot: OperationsSnapshot | null = null;
  let nowHour = 0;
  let busy = false;
  let activeTab: TabId = 'city';
  let selectedBuilding: BuildingId | null = null;
  /** 고른 목표. 없으면 서버 목록에서 아직 격파하지 않은 가장 낮은 단계를 쓴다. */
  let selectedScenario: string | null = null;
  /** 동원할 편성. 병종별 수량이며 동원 성공 시 비운다. */
  const mobilizeOrder = new Map<string, number>();
  /**
   * 병종별로 고른 배치 열(D-045). 고르지 않은 병종은 서버가 준 기본 열을 쓴다.
   * 기기에만 남기고 서버에 저장하지 않는다 — 권위 상태가 아니라 다음 공격 명령의 입력이다.
   */
  const deploymentRows = new Map<string, Row>();
  /** 도시 화면에서 보고 있는 구역(D-052). 기기에만 남는 화면 상태다. */
  let activeDistrict: DistrictId = 'resource';
  /** 고른 교리. 기기에 남겨 다음 출격에도 유지한다. */
  let selectedDoctrine = localStorage.getItem(DOCTRINE_KEY) ?? DEFAULT_DOCTRINE;

  /** 서버가 준 목록에 없는 교리는 쓰지 않는다(규칙 버전이 바뀌었을 수 있다). */
  function activeDoctrine(): string {
    const doctrines = snapshot?.doctrines ?? [];
    if (doctrines.some((entry) => entry.id === selectedDoctrine)) return selectedDoctrine;
    return doctrines.some((entry) => entry.id === DEFAULT_DOCTRINE)
      ? DEFAULT_DOCTRINE
      : doctrines[0]?.id ?? DEFAULT_DOCTRINE;
  }

  function activeScenario(): string | null {
    const scenarios = snapshot?.scenarios ?? [];
    const chosen = scenarios.find((entry) => entry.id === selectedScenario);
    if (chosen !== undefined && chosen.unlocked) return chosen.id;
    return (scenarios.find((entry) => entry.unlocked && !entry.cleared)
      ?? scenarios.find((entry) => entry.unlocked))?.id ?? null;
  }

  app!.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div id="nameplate"></div>
      </header>
      <dl class="resources" id="resources"></dl>
      <div class="status" id="status" role="status">최신 상태를 불러옵니다…</div>
      <div class="body" id="body"></div>
      <div id="tutorial" hidden></div>
      <nav class="tabs" role="tablist">
        ${TABS.map((tab) => `<button class="tab" role="tab" data-tab="${tab.id}"`
          + ` aria-selected="${String(tab.id === 'city')}">${tabIcon(tab.id)}`
          + `<span class="tab-label">${tab.nameKo}</span></button>`).join('')}
      </nav>
    </div>
  `;

  const body = document.querySelector<HTMLDivElement>('#body')!;
  const status = document.querySelector<HTMLDivElement>('#status')!;
  const resources = document.querySelector<HTMLElement>('#resources')!;
  let scene: CityScene | null = null;
  /**
   * 도시 이름패(D-054). 제목 자리를 도시 이름에 내주고, 그 자리에서 바로 고친다.
   * 계측 subject는 `city`를 쓴다 — 이름 변경은 첫 루프 깔때기(D-035) 항목이 아니라서
   * 새 enum을 넣자고 client_events의 CHECK를 다시 세울 이유가 없다.
   */
  const nameplate = new CityNamePlate(document.querySelector<HTMLElement>('#nameplate')!, {
    onRename: async (name) => {
      let renamed = false;
      await runCommand('도시 이름', 'city', async (expectedVersion) => {
        const result = await api.renameCity(newCommandId('name'), expectedVersion, name);
        renamed = true;
        return result;
      });
      return renamed;
    },
  });
  const tutorial = new Tutorial(document.querySelector<HTMLElement>('#tutorial')!, {
    onTab: (tab) => { void showTab(tab); },
  });

  function setStatus(text: string, kind: 'ok' | 'error' | 'busy' = 'ok'): void {
    status.className = kind === 'ok' ? 'status' : `status ${kind}`;
    status.textContent = text;
  }

  /**
   * 권위 시각(시간 단위)을 전황 일지처럼 읽히게 옮긴다(D-047).
   * `h459`는 서버 내부 표현이라 플레이어에게 아무 뜻이 없다. 같은 값을 일·시로만 바꾼다.
   */
  function gameClock(hour: number): string {
    const day = Math.floor(hour / 24) + 1;
    const clock = String(hour % 24).padStart(2, '0');
    return `작전 ${day}일차 · ${clock}00시`;
  }

  function paint(): void {
    renderResources(resources, snapshot);
    // 머리글에는 플레이어가 쓰는 정보만 둔다(D-047).
    // 도시 id와 version은 진단용이라 설정 탭으로 옮겼다 — 첫 화면에 UUID가 크게 떠 있으면
    // 게임이 아니라 관리 도구처럼 보인다.
    // 이름은 서버가 준 값만 쓴다(D-054). 아직 못 읽었으면 이름 자리를 비워 둔다.
    nameplate.update(snapshot?.name ?? '', snapshot === null ? '연결 중…' : gameClock(nowHour));
    if (activeTab === 'city') {
      renderArmy(document.querySelector<HTMLElement>('#army-list')!, snapshot, nowHour);
      // 도시 화면 위의 건설·회복 대기열(D-053).
      renderBuildQueue(document.querySelector<HTMLElement>('#build-queue')!, snapshot, nowHour);
      renderCitySelection(
        document.querySelector<HTMLElement>('#city-select')!,
        snapshot,
        selectedBuilding,
        nowHour,
      );
      scene?.update(snapshot ?? emptySnapshot(), nowHour);
    } else if (activeTab === 'operations') {
      const scenarioId = activeScenario();
      renderObjective(
        document.querySelector<HTMLElement>('#objective')!,
        snapshot,
        nowHour,
        scenarioId,
      );
      renderScenarios(document.querySelector<HTMLElement>('#scenarios')!, snapshot, scenarioId);
      renderDoctrines(document.querySelector<HTMLElement>('#doctrines')!, snapshot, activeDoctrine());
      renderMobilize(document.querySelector<HTMLElement>('#mobilize')!, snapshot, mobilizeOrder);
      renderFormation(document.querySelector<HTMLElement>('#formation')!, snapshot, deploymentRows);
      // 건설 목록도 도시 화면과 같은 구역으로 나눈다(D-052).
      renderBuildings(
        document.querySelector<HTMLElement>('#buildings-resource')!, snapshot, nowHour, 'resource',
      );
      renderBuildings(
        document.querySelector<HTMLElement>('#buildings-strategy')!, snapshot, nowHour, 'strategy',
      );
      renderResearch(document.querySelector<HTMLElement>('#research')!, snapshot);
      renderSteps(document.querySelector<HTMLElement>('#steps')!, snapshot);
      updateCommandAvailability();
    } else if (activeTab === 'reports') {
      renderRecon(document.querySelector<HTMLElement>('#recon')!, snapshot?.latestRecon ?? null, nowHour);
      renderBattle(document.querySelector<HTMLElement>('#battle')!, snapshot?.battleReports[0]);
    }
    // 설정 탭은 서버 상태에 따라 바뀌지 않으므로 여기서 다시 그리지 않는다.
    tutorial.update(snapshot);
  }

  function emptySnapshot(): OperationsSnapshot {
    return {
      cityId: session.cityId,
      name: '',
      ownerId: '',
      version: 0,
      lastServerHour: 0,
      resourcesMicro: { food: 0, steel: 0, oil: 0, supplies: 0, manpower: 0, scrip: 0 },
      buildings: {
        hq: 0, farm: 0, steel_mill: 0, refinery: 0, supply_depot: 0, housing: 0, warehouse: 0,
      },
      jobs: [],
      army: { ready: {}, wounded: {}, dead: {} },
      recoveries: [],
      recoveryInfo: { hours: 0, suppliesRate: 0, unitValues: {} },
      productionPerHour: {},
      latestRecon: null,
      battleReports: [],
      doctrines: [],
      units: [],
      research: [],
      buildingInfo: [],
      scenarios: [],
    };
  }

  function updateCommandAvailability(): void {
    const hasArmy = Object.values(snapshot?.army.ready ?? {}).some((count) => count > 0);
    const recon = snapshot?.latestRecon ?? null;
    // 정찰 보고서는 시나리오별이다. 고른 목표의 보고서가 아니면 공격할 수 없다.
    const reconValid = recon !== null
      && recon.scenarioId === activeScenario()
      && nowHour < recon.expiresAtHour;
    // 건설 가능 여부는 서버가 판정한다(사령부 게이트·비용을 화면이 복제하지 않는다).
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
      const command = button.dataset.command;
      button.disabled = busy
        || (command === 'attack' && (!hasArmy || !reconValid))
        || (command === 'recon' && !hasArmy);
    }
  }

  async function refresh(): Promise<void> {
    const [operations, health] = await Promise.all([api.operations(), api.health()]);
    snapshot = operations;
    nowHour = health.nowHour;
    paint();
  }

  /** 명령 실행: 항상 최신 version으로 보내고, 성공·실패 모두 서버 상태를 다시 읽는다. */
  async function runCommand(
    label: string,
    subject: EventSubject,
    action: (expectedVersion: number) => Promise<unknown>,
    sound: SoundName = 'tap',
  ): Promise<void> {
    if (busy) return;
    busy = true;
    updateCommandAvailability();
    telemetry.record('command_attempt', subject);
    setStatus(`${label} 명령을 보냈습니다…`, 'busy');
    try {
      await refresh();
      if (snapshot === null) throw new Error('도시 상태를 읽지 못했습니다.');
      try {
        await action(snapshot.version);
      } catch (error) {
        /**
         * 생산 정산이 매 시간 도시 version을 올리기 때문에(D-045), 상태를 읽은 순간과
         * 명령이 도착한 순간 사이에 version이 바뀔 수 있다. 그러면 플레이어는 아무 잘못 없이
         * "상태가 바뀌었습니다"를 본다. **STALE_VERSION은 서버가 아무것도 적용하지 않았다는 뜻이므로**
         * 최신 version으로 한 번 다시 보내는 것이 안전하다.
         */
        if (!(error instanceof ApiError) || error.code !== 'STALE_VERSION') throw error;
        await refresh();
        if (snapshot === null) throw error;
        await action(snapshot.version);
      }
      await refresh();
      telemetry.record('command_success', subject);
      play(sound);
      setStatus(`${label} 완료`);
    } catch (error) {
      telemetry.record(
        'command_rejected',
        subject,
        error instanceof ApiError ? error.code : 'UNEXPECTED',
      );
      play('reject');
      setStatus(`${label} 거부: ${guidanceFor(error)}`, 'error');
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
        // 세션이 무효가 되면 저장분을 버리고 기기 비밀값으로 다시 연다.
        clearSession();
        scene?.destroy();
        scene = null;
        setTimeout(() => void boot(), 1_200);
        return;
      }
      try {
        await refresh();
      } catch {
        // 재조회 실패는 위 메시지를 덮지 않는다.
      }
    } finally {
      busy = false;
      updateCommandAvailability();
    }
  }

  /**
   * 추천 편성을 우선순위 순으로 한 기씩 채운다. 자원이 모자라면 거기서 멈춘다.
   * 비용·잔량은 모두 서버 스냅샷에서 읽는다 — 부족한데 제안해서 거부당하는 일을 없앤다.
   */
  function fillRecommended(): void {
    if (snapshot === null) return;
    const units = new Map(snapshot.units.filter((unit) => unit.unlocked)
      .map((unit) => [unit.unitId, unit]));
    const left = new Map<string, number>(
      Object.entries(snapshot.resourcesMicro).map(([id, micro]) => [id, fromMicro(micro)]),
    );
    for (const entry of RECOMMENDED_FORCE) {
      const unit = units.get(entry.unitId);
      if (unit === undefined) continue;
      const cost = Object.entries(unit.trainCost);
      for (let added = 0; added < entry.count; added += 1) {
        if (!cost.every(([id, amount]) => (left.get(id) ?? 0) >= amount)) break;
        for (const [id, amount] of cost) left.set(id, (left.get(id) ?? 0) - amount);
        mobilizeOrder.set(entry.unitId, (mobilizeOrder.get(entry.unitId) ?? 0) + 1);
      }
    }
  }

  /** 가용 병력 전체를 고른 진형대로 배치한다. 고르지 않았으면 서버가 준 기본 열을 쓴다. */
  function deploymentFromArmy(): DeploymentEntry[] {
    const defaults = new Map((snapshot?.units ?? []).map((unit) => [unit.unitId, unit.defaultRow]));
    return Object.entries(snapshot?.army.ready ?? {})
      .filter(([, count]) => count > 0)
      .map(([unitId, count]) => ({
        unitId,
        count,
        row: deploymentRows.get(unitId) ?? defaults.get(unitId) ?? 'mid',
      }));
  }

  /**
   * 도시 화면의 구역을 바꾼다(D-052).
   *
   * **화면을 다시 만들지 않는다.** `showTab('city')`를 다시 부르면 `body.innerHTML`이 갈리면서
   * 캔버스 DOM이 사라지는데, 장면 객체는 살아 있어 다시 마운트되지 않는다 — 도시가 통째로 없어진다.
   * 바꿀 것은 장면의 구역과 탭 표시뿐이다.
   */
  function showDistrict(id: DistrictId): void {
    activeDistrict = id;
    // 구역을 바꾸면 이전 구역에서 고른 부지는 화면에 없다.
    selectedBuilding = null;
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-district]')) {
      button.setAttribute('aria-selected', String(button.dataset.district === id));
    }
    const hint = document.querySelector<HTMLElement>('#district-hint');
    if (hint !== null) hint.textContent = districtOf(id).hintKo;
    scene?.setDistrict(id);
    paint();
  }

  async function showTab(tab: TabId): Promise<void> {
    activeTab = tab;
    telemetry.record('screen_view', tab as EventSubject);
    if (tab === 'reports') telemetry.record('report_view', 'reports');
    for (const button of document.querySelectorAll<HTMLButtonElement>('button.tab[data-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    if (tab !== 'city' && scene !== null) {
      scene.destroy();
      scene = null;
    }
    if (tab === 'city') {
      // 구역 전환(D-052). 원작처럼 자원 짓는 땅과 전략 건물 짓는 땅을 나눈다.
      const districtTabs = DISTRICTS
        .map((district) => `<button class="district-tab" type="button" data-district="${district.id}"`
          + ` aria-selected="${String(district.id === activeDistrict)}">${district.nameKo}</button>`)
        .join('');
      body.innerHTML = `
        <section class="card">
          <div class="district-switch" role="tablist">${districtTabs}</div>
          <div id="city-canvas">
            <div class="build-queue" id="build-queue" hidden></div>
          </div>
          <div class="content" id="city-select"></div>
          <p class="content note" id="district-hint"></p>
        </section>
        <section class="card"><h2>가용 병력</h2><div class="content" id="army-list"></div></section>
      `;
      if (scene === null) {
        scene = new CityScene();
        await scene.mount(document.querySelector<HTMLElement>('#city-canvas')!);
        scene.onSelect = (buildingId) => {
          selectedBuilding = buildingId;
          paint();
        };
      }
      // 아트를 눈으로 확인할 창구. 개발 빌드에만 붙는다(D-047, D-049).
      if (import.meta.env.DEV) {
        const debug = window as unknown as {
          captureCity?: () => Promise<string>;
          captureCityAtLevel?: (level: number) => Promise<string>;
        };
        debug.captureCity = () => scene!.capture();
        /**
         * 모든 건물을 같은 레벨로 그려 성장 표현을 비교한다(D-049).
         * 서버 상태를 바꾸지 않고 **그리기 입력만** 갈아 끼운다 — 장면은 스냅샷의 순수 함수다.
         * 확인이 끝나면 원래 스냅샷으로 되돌린다.
         */
        debug.captureCityAtLevel = async (level) => {
          if (snapshot === null) throw new Error('스냅샷이 없습니다.');
          const buildings: Record<string, number> = {};
          for (const key of Object.keys(snapshot.buildings)) buildings[key] = level;
          scene!.update({ ...snapshot, buildings }, nowHour);
          const image = await scene!.capture();
          scene!.update(snapshot, nowHour);
          return image;
        };
      }
      for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-district]')) {
        button.addEventListener('click', () => {
          if (button.dataset.district === activeDistrict) return;
          play('tap');
          showDistrict(button.dataset.district as DistrictId);
        });
      }
      showDistrict(activeDistrict);
      scene.setSelected(selectedBuilding);
    } else if (tab === 'operations') {
      body.innerHTML = `
        <button class="objective" id="objective" type="button"></button>
        <section class="card"><h2>목표</h2><div class="content" id="scenarios"></div>
          <p class="content note">적 규모는 정찰로만 알 수 있습니다. 목록은 규모를 알려주지 않습니다.</p>
        </section>
        <section class="card"><h2>교리</h2><div class="content" id="doctrines"></div>
          <p class="content note">교리는 공격에만 적용됩니다. 데려가는 병종에 맞춰 고르십시오.</p>
        </section>
        <section class="card"><h2>부대 편성</h2><div class="content" id="mobilize"></div>
          <div class="content">
            <button class="action" type="button" data-command="mobilize"><span class="title">편성대로 동원</span><span class="hint">비용과 가능 여부는 서버가 판정합니다.</span></button>
            <button class="action" type="button" data-command="recommend"><span class="title">추천 편성 채우기</span><span class="hint">해금된 병종으로 기본 편성을 넣습니다.</span></button>
          </div>
        </section>
        <section class="card"><h2>진형</h2><div class="content" id="formation"></div>
          <p class="content note">앞 열이 먼저 맞고, 사거리가 짧은 병종은 앞에 둬야 때립니다.</p>
        </section>
        <section class="card"><h2>작전 명령</h2><div class="content">
          <button class="action" type="button" data-command="recon"><span class="title">선택한 목표 정찰</span><span class="hint">정확도·만료는 서버가 계산합니다.</span></button>
          <button class="action primary" type="button" data-command="attack"><span class="title">선택한 목표 공격</span><span class="hint">가용 병력 전체 배치 · 선택한 진형과 교리 적용</span></button>
        </div></section>
        <section class="card"><h2>자원 지구 건설</h2><div class="content" id="buildings-resource"></div></section>
        <section class="card"><h2>전략 지구 건설</h2><div class="content" id="buildings-strategy"></div>
          <p class="content note">사령부 레벨이 다른 건물의 상한입니다. 막히면 사령부를 먼저 증설하십시오.</p>
        </section>
        <section class="card"><h2>연구</h2><div class="content" id="research"></div>
          <p class="content note">군표로 영구 보정을 얻습니다. 연구소 레벨이 열 수 있는 연구를 정합니다.</p>
        </section>
        <section class="card"><h2>첫 루프 진행</h2><div class="content"><ul class="steps" id="steps"></ul></div></section>
      `;
    } else if (tab === 'reports') {
      body.innerHTML = `
        <section class="card"><h2>최신 정찰</h2><div class="content" id="recon"></div></section>
        <section class="card"><h2>최신 전투</h2><div class="content" id="battle"></div></section>
      `;
    } else {
      renderSettings();
    }
    paint();
  }

  /**
   * 설정 화면. 계정 삭제 경로를 앱 안에 두는 것은 스토어 요건이다 —
   * Apple은 계정 생성이 있으면 앱 내 삭제를 요구하고 Google도 삭제 경로를 요구한다.
   */
  function renderSettings(): void {
    body.innerHTML = `
      <section class="card"><h2>계정</h2><div class="content">
        <div class="rows">
          <div class="row"><span class="k">도시</span><span class="v" id="set-city"></span></div>
          <div class="row"><span class="k">서버</span><span class="v" id="set-server"></span></div>
          <div class="row"><span class="k">상태 번호</span><span class="v" id="set-version"></span></div>
        </div>
        <p class="hint-line" id="set-warning"></p>
      </div></section>
      <section class="card"><h2>개인정보</h2><div class="content">
        <p class="hint-line">
          이 게임은 이름·이메일·전화번호를 받지 않습니다. 계정은 이 기기가 만든 무작위 값으로만 구분되며,
          서버에는 그 값의 해시만 저장됩니다. 조작 기록은 화면 이름과 오류 코드 같은 정해진 값만 남깁니다.
        </p>
        <p class="hint-line" id="set-privacy"></p>
      </div></section>
      <section class="card"><h2>소리</h2><div class="content">
        <p class="hint-line">조작과 전투에 짧은 효과음이 납니다. 음악은 없습니다.</p>
        <button class="action" type="button" id="sound-toggle"></button>
      </div></section>
      <section class="card"><h2>도움말</h2><div class="content">
        <p class="hint-line">첫 안내를 다시 볼 수 있습니다.</p>
        <button class="action" type="button" id="tutorial-restart">튜토리얼 다시 보기</button>
      </div></section>
      <section class="card"><h2>계정 삭제</h2><div class="content">
        <p class="hint-line">
          계정과 도시 기록이 서버에서 지워집니다. 되돌릴 수 없고, 다음 실행에는 새 도시로 시작합니다.
        </p>
        <button class="action" type="button" id="delete-start">계정 삭제</button>
        <div id="delete-confirm"></div>
      </div></section>
    `;
    document.querySelector<HTMLElement>('#set-city')!.textContent = session.cityId;
    document.querySelector<HTMLElement>('#set-server')!.textContent = apiBaseUrl();
    // 진단용 값. 머리글에서 여기로 옮겼다(D-047) — 문의를 받을 때 필요하다.
    document.querySelector<HTMLElement>('#set-version')!.textContent =
      snapshot === null ? '—' : `version ${snapshot.version} · h${nowHour}`;
    document.querySelector<HTMLElement>('#set-warning')!.textContent = isInsecureApi()
      ? '평문 HTTP로 연결 중입니다. 배포 빌드는 HTTPS 주소로 만들어야 합니다.'
      : '';
    document.querySelector<HTMLElement>('#set-privacy')!.textContent
      = '개인정보 처리방침 주소는 아직 정해지지 않았습니다(스토어 심사 전 필수).';

    const soundButton = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
    const paintSound = (): void => {
      soundButton.textContent = soundEnabled() ? '효과음 켜짐 (누르면 끔)' : '효과음 꺼짐 (누르면 켬)';
    };
    paintSound();
    soundButton.addEventListener('click', () => {
      setSoundEnabled(!soundEnabled());
      paintSound();
      // 켠 직후에 한 번 들려준다 — 켜졌는지 확인할 방법이 필요하다.
      if (soundEnabled()) play('tap');
    });

    document.querySelector<HTMLButtonElement>('#tutorial-restart')!
      .addEventListener('click', () => {
        tutorial.restart();
        void showTab('city');
      });

    const confirmHost = document.querySelector<HTMLElement>('#delete-confirm')!;
    document.querySelector<HTMLButtonElement>('#delete-start')!.addEventListener('click', () => {
      confirmHost.innerHTML = `
        <p class="hint-line">정말 삭제하시겠습니까? 복구할 수 없습니다.</p>
        <button class="action" type="button" id="delete-cancel">취소</button>
        <button class="action danger" type="button" id="delete-confirmed">삭제합니다</button>
      `;
      document.querySelector<HTMLButtonElement>('#delete-cancel')!
        .addEventListener('click', () => confirmHost.replaceChildren());
      document.querySelector<HTMLButtonElement>('#delete-confirmed')!
        .addEventListener('click', () => void runDelete());
    });
  }

  async function runDelete(): Promise<void> {
    setStatus('계정을 삭제하는 중…', 'busy');
    try {
      await api.deleteAccount();
      scene?.destroy();
      scene = null;
      clearDevice();
      bootScreen('계정을 삭제했습니다. 앱을 다시 열면 새 도시로 시작합니다.', true);
    } catch (error) {
      setStatus(`계정 삭제 실패: ${guidanceFor(error)}`, 'error');
    }
  }

  /**
   * 명령 실행 진입점. 건물 목록은 새 상태마다 다시 그려지므로 개별 노드에 리스너를 붙이지 않고
   * 본문에 위임한다(재렌더로 리스너가 사라지는 문제를 없앤다).
   */
  async function dispatchCommand(button: HTMLElement): Promise<void> {
    switch (button.dataset.command) {
      case 'build': {
        const buildingId = (button.dataset.building ?? 'hq') as BuildingId;
        await runCommand(`${BUILDING_LABELS[buildingId]} 증설`, 'build', (version) =>
          api.startConstruction(newCommandId('construction'), version, buildingId), 'build');
        return;
      }
      case 'recover': {
        // 부상병 전원을 한 번에 예약한다. 부분 회복은 아직 필요하지 않다.
        const units = Object.entries(snapshot?.army.wounded ?? {})
          .filter(([, count]) => count > 0)
          .map(([unitId, count]) => ({ unitId, count }));
        if (units.length === 0) return;
        // "회복 완료"로 읽히지 않게 예약이라고 적는다 — 실제 복귀는 시간이 지나야 한다.
        await runCommand('부상병 회복 예약', 'build', (version) =>
          api.recoverUnits(newCommandId('recovery'), version, units), 'mobilize');
        return;
      }
      case 'recommend': {
        mobilizeOrder.clear();
        fillRecommended();
        paint();
        return;
      }
      case 'mobilize': {
        const units = [...mobilizeOrder.entries()]
          .filter(([, count]) => count > 0)
          .map(([unitId, count]) => ({ unitId, count }));
        if (units.length === 0) {
          setStatus('동원할 병종의 수량을 먼저 정하십시오.', 'error');
          return;
        }
        await runCommand('부대 동원', 'mobilize', (version) =>
          api.mobilize(newCommandId('mobilization'), version, units), 'mobilize');
        // 성공했으면 편성을 비운다. 실패했으면 다시 시도할 수 있게 남긴다.
        if (snapshot !== null && units.every((unit) => (snapshot!.army.ready[unit.unitId] ?? 0) > 0)) {
          mobilizeOrder.clear();
          paint();
        }
        return;
      }
      case 'recon': {
        const scenarioId = activeScenario();
        if (scenarioId === null) return;
        await runCommand('정찰', 'recon', (version) =>
          api.recon(newCommandId('recon'), version, scenarioId), 'recon');
        return;
      }
      case 'attack': {
        const scenarioId = activeScenario();
        if (scenarioId === null) return;
        await runCommand('공격', 'attack', (version) => {
          const deployment = deploymentFromArmy();
          if (deployment.length === 0) {
            return Promise.reject(new Error('배치할 가용 병력이 없습니다.'));
          }
          return api.attack(
            newCommandId('battle'),
            version,
            scenarioId,
            activeDoctrine(),
            deployment,
          );
        // 승패는 아래에서 보고서를 보고 낸다. 여기서는 명령 성공음을 내지 않는다.
        }, 'hit');
        const latest = snapshot?.battleReports[0];
        if (latest !== undefined) {
          play(latest.result.outcome === 'attacker_win' ? 'victory' : 'defeat');
        }
        return;
      }
      default:
        return;
    }
  }

  body.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>('button[data-scenario]');
    if (target !== null) {
      selectedScenario = target.dataset.scenario ?? null;
      play('tap');
      paint();
      return;
    }
    const step = event.target.closest<HTMLElement>('button[data-unit]');
    if (step !== null) {
      const unitId = step.dataset.unit!;
      const delta = Number(step.dataset.delta ?? '0');
      const next = Math.max(0, Math.min(999, (mobilizeOrder.get(unitId) ?? 0) + delta));
      if (next === 0) mobilizeOrder.delete(unitId);
      else mobilizeOrder.set(unitId, next);
      play('tap');
      paint();
      return;
    }
    const research = event.target.closest<HTMLElement>('button[data-research]');
    if (research !== null) {
      const researchId = research.dataset.research!;
      const targetLevel = Number(research.dataset.target ?? '0');
      if (targetLevel > 0) {
        void runCommand('연구', 'build', (version) =>
          api.advanceResearch(newCommandId('research'), version, researchId, targetLevel), 'research');
      }
      return;
    }
    const rowButton = event.target.closest<HTMLElement>('button[data-row-unit]');
    if (rowButton !== null) {
      deploymentRows.set(rowButton.dataset.rowUnit!, rowButton.dataset.row as Row);
      play('tap');
      paint();
      return;
    }
    const doctrine = event.target.closest<HTMLElement>('button[data-doctrine]');
    if (doctrine !== null) {
      selectedDoctrine = doctrine.dataset.doctrine ?? DEFAULT_DOCTRINE;
      localStorage.setItem(DOCTRINE_KEY, selectedDoctrine);
      play('tap');
      paint();
      return;
    }
    const button = event.target.closest<HTMLElement>('button[data-command]');
    if (button === null) return;
    void dispatchCommand(button);
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('button.tab[data-tab]')) {
    button.addEventListener('click', () => {
      void showTab(button.dataset.tab as TabId);
    });
  }

  await showTab('city');
  try {
    await refresh();
    setStatus('전황을 불러왔습니다.');
  } catch (error) {
    setStatus(guidanceFor(error), 'error');
  }
  // 압축 시계에서도 건설 완료가 보이도록 주기적으로 서버 상태를 다시 읽는다.
  setInterval(() => {
    if (busy) return;
    void refresh().catch(() => undefined);
  }, 3_000);
}

void boot();

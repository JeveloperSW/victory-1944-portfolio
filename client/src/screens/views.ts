import {
  BUILDING_LABELS,
  OUTCOME_LABELS,
  REASON_LABELS,
  RESOURCE_IDS,
  RESOURCE_LABELS,
  ROW_LABELS,
  ROW_ORDER,
  SIDE_LABELS,
  fromMicro,
  unitLabel,
  type AttackEvent,
  type Row,
  type BuildingId,
  type ConstructionJob,
  type OperationsSnapshot,
  type ReconReport,
  type BattleReport,
  type ResourceId,
  type Side,
  type SideReport,
} from '../api/contract.js';
import { CHEVRON, resourceIcon } from './icons.js';
import { districtIdOfBuilding, type DistrictId } from '../city/districts.js';

/** 순수 렌더 함수 모음. 서버 스냅샷을 DOM으로만 옮긴다(계산·판정 없음). */

/** 서버가 준 불가 사유 코드 → 화면 문구. 코드 자체는 서버가 정한다. */
const BLOCKED_REASON_LABELS: Readonly<Record<string, string>> = {
  MAX_LEVEL: '최대 레벨입니다.',
  BUILDING_ALREADY_PENDING: '이미 건설 중입니다.',
  BUILD_SLOT_FULL: '동시 건설 슬롯이 가득 찼습니다.',
  HQ_LEVEL_REQUIRED: '사령부를 먼저 증설해야 합니다.',
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 자원 잔액과 **시간당 생산량**(D-045).
 * 생산량이 없으면 건물을 올려도 무엇이 좋아졌는지 확인할 방법이 없다.
 * 값은 서버가 규칙에서 계산한 것을 그대로 쓴다.
 */
export function renderResources(host: HTMLElement, snapshot: OperationsSnapshot | null): void {
  host.replaceChildren();
  for (const resourceId of RESOURCE_IDS) {
    const cell = element('div', 'resource');
    const perHour = snapshot?.productionPerHour[resourceId] ?? 0;
    // 아이콘은 코드로 그린 SVG다(D-047). 좁은 칸에서 이름만으로는 훑어 읽기 어렵다.
    const icon = document.createElement('template');
    icon.innerHTML = resourceIcon(resourceId);
    if (icon.content.firstElementChild !== null) cell.append(icon.content.firstElementChild);
    cell.append(
      element('dt', undefined, RESOURCE_LABELS[resourceId]),
      element(
        'dd',
        undefined,
        snapshot === null ? '—' : formatAmount(fromMicro(snapshot.resourcesMicro[resourceId])),
      ),
    );
    if (perHour > 0) {
      // 소수 둘째 자리까지만 보인다(군표는 인력에 비례해 소수가 나온다).
      cell.append(element('dd', 'rate', `+${Math.round(perHour * 100) / 100}/시간`));
    }
    host.append(cell);
  }
}

/**
 * 자원 표시값. 소수는 첫째 자리까지만 남기고, 천 단위는 k로 줄인다.
 * 좁은 칸에서 `1550.125` 같은 값이 줄바꿈되면 막대 전체가 흔들린다.
 */
function formatAmount(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 목적격 조사. 마지막 글자의 받침 유무로 을/를을 고른다.
 * 한글 음절은 U+AC00부터 28개 종성 주기로 배열되므로 나머지가 0이면 받침이 없다.
 */
function objectParticle(word: string): string {
  const last = word.trim().at(-1);
  if (last === undefined) return '를';
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return '를';
  return (code - 0xac00) % 28 === 0 ? '를' : '을';
}

function row(key: string, value: string): HTMLElement {
  const line = element('div', 'row');
  line.append(element('span', 'k', key), element('span', 'v', value));
  return line;
}

/**
 * 병력 현황(D-045).
 *
 * 가용·부상·회복 중·전사를 나눠 보여준다. 예전에는 가용 병력이 있는 병종에만 부상 수를
 * 덧붙여서, **전멸에 가까운 병종의 부상병이 화면에서 사라졌다** — 회복할 수 있다는 사실 자체를
 * 알 수 없었다. 회복 비용은 서버가 준 전투가치·비율로 합산해 미리 보여준다.
 */
export function renderArmy(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  nowHour: number,
): void {
  host.replaceChildren();
  const ready = Object.entries(snapshot?.army.ready ?? {}).filter(([, count]) => count > 0);
  const wounded = Object.entries(snapshot?.army.wounded ?? {}).filter(([, count]) => count > 0);
  const dead = Object.entries(snapshot?.army.dead ?? {}).filter(([, count]) => count > 0);
  const recoveries = snapshot?.recoveries ?? [];

  if (ready.length === 0 && wounded.length === 0 && recoveries.length === 0) {
    host.append(element('p', 'empty', '가용 병력이 없습니다. 작전 탭에서 부대를 편성해 동원하십시오.'));
    return;
  }

  if (ready.length > 0) {
    host.append(element('h4', 'group', '가용'));
    const list = element('div', 'rows');
    for (const [unitId, count] of ready) list.append(row(unitLabel(unitId), String(count)));
    host.append(list);
  }

  if (wounded.length > 0 && snapshot !== null) {
    host.append(element('h4', 'group', '부상'));
    const list = element('div', 'rows');
    for (const [unitId, count] of wounded) list.append(row(unitLabel(unitId), String(count)));
    host.append(list);
    // 비용은 병종별로 나눠 올리지 않는다 — 서버가 전체 합에 한 번만 올림한다.
    const value = wounded.reduce(
      (sum, [unitId, count]) => sum + count * (snapshot.recoveryInfo.unitValues[unitId] ?? 0),
      0,
    );
    const cost = Math.ceil(value * snapshot.recoveryInfo.suppliesRate);
    const button = element('button', 'action primary');
    button.type = 'button';
    button.dataset.command = 'recover';
    button.append(element('span', 'title', '부상병 전원 회복'));
    button.append(element(
      'span',
      'hint',
      `보급품 ${cost} · ${snapshot.recoveryInfo.hours}시간 뒤 복귀`,
    ));
    host.append(button);
  }

  if (recoveries.length > 0) {
    host.append(element('h4', 'group', '회복 중'));
    const list = element('div', 'rows');
    for (const job of recoveries) {
      const remaining = Math.max(0, job.completesAtHour - nowHour);
      list.append(row(unitLabel(job.unitId), `${job.count}기 · 남은 ${remaining}시간`));
    }
    host.append(list);
  }

  if (dead.length > 0) {
    host.append(element('h4', 'group', '전사'));
    const list = element('div', 'rows dim');
    for (const [unitId, count] of dead) list.append(row(unitLabel(unitId), String(count)));
    host.append(list);
  }
}

export function renderSteps(host: HTMLElement, snapshot: OperationsSnapshot | null): void {
  const farmLevel = snapshot?.buildings.farm ?? 1;
  const hasArmy = Object.values(snapshot?.army.ready ?? {}).some((count) => count > 0);
  const steps: readonly [string, boolean][] = [
    ['도시 성장 (농장 증설)', farmLevel >= 2],
    ['병력 동원', hasArmy],
    ['정찰', snapshot?.latestRecon !== null && snapshot?.latestRecon !== undefined],
    ['첫 전투', (snapshot?.battleReports.length ?? 0) > 0],
  ];
  host.replaceChildren();
  for (const [label, done] of steps) {
    const item = element('li', 'step');
    item.dataset.done = String(done);
    item.append(
      element('span', 'mark', done ? '완료' : '대기'),
      element('span', 'label', label),
    );
    host.append(item);
  }
}

/**
 * 건설 대기열(D-053). 원작처럼 도시 화면 위에 진행 중인 건설을 걸어 둔다.
 *
 * 지금까지는 건설 진행을 보려면 작전 탭의 건물 목록까지 들어가야 했다.
 * 동시 건설이 여러 건이면 **무엇이 언제 끝나는지 한눈에 볼 곳이 없었다.**
 * 남은 시간은 서버의 권위 시각과 완료 시각의 차이이며 화면이 시간을 세지 않는다.
 */
export function renderBuildQueue(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  nowHour: number,
): void {
  host.replaceChildren();
  const jobs = (snapshot?.jobs ?? []).filter((job) => job.status === 'pending');
  const recoveries = snapshot?.recoveries ?? [];
  if (jobs.length === 0 && recoveries.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const job of [...jobs].sort((a, b) => a.completesAtHour - b.completesAtHour)) {
    const remaining = Math.max(0, job.completesAtHour - nowHour);
    const line = element('div', 'queue-item');
    line.append(
      element('span', 'queue-mark', '▲'),
      element('span', 'queue-name', BUILDING_LABELS[job.buildingId] ?? job.buildingId),
      element('span', 'queue-level', `Lv ${job.targetLevel}`),
      element('span', 'queue-time', `${remaining}시간`),
    );
    host.append(line);
  }
  for (const job of [...recoveries].sort((a, b) => a.completesAtHour - b.completesAtHour)) {
    const remaining = Math.max(0, job.completesAtHour - nowHour);
    const line = element('div', 'queue-item recovery');
    line.append(
      element('span', 'queue-mark', '✚'),
      element('span', 'queue-name', unitLabel(job.unitId)),
      element('span', 'queue-level', `${job.count}기`),
      element('span', 'queue-time', `${remaining}시간`),
    );
    host.append(line);
  }
}

/**
 * 건물 목록. 서버가 준 buildingInfo를 그대로 표시한다(D-043).
 * 다음 레벨 비용·시간·불가 사유가 이미 담겨 오므로 눌러 보지 않아도 알 수 있고,
 * 화면은 사령부 게이트나 슬롯 규칙을 복제하지 않는다.
 */
export function renderBuildings(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  nowHour: number,
  district?: DistrictId,
): void {
  host.replaceChildren();
  if (snapshot === null || snapshot.buildingInfo.length === 0) {
    host.append(element('p', 'empty', '도시 상태를 불러오는 중입니다.'));
    return;
  }
  const pending = new Map<string, ConstructionJob>();
  for (const job of snapshot.jobs) {
    if (job.status === 'pending') pending.set(job.buildingId, job);
  }
  // 구역을 주면 그 구역의 건물만 보인다(D-052). 주지 않으면 전부 보인다.
  const listed = district === undefined
    ? snapshot.buildingInfo
    : snapshot.buildingInfo.filter((info) => districtIdOfBuilding(info.buildingId) === district);
  if (listed.length === 0) {
    host.append(element('p', 'empty', '이 구역에는 지을 수 있는 건물이 없습니다.'));
    return;
  }
  for (const info of listed) {
    const job = pending.get(info.buildingId);
    const button = element('button', info.buildingId === 'hq' ? 'action primary' : 'action');
    button.type = 'button';
    button.dataset.command = 'build';
    button.dataset.building = info.buildingId;
    // 가능 여부는 서버가 판정한 blockedReason을 그대로 쓴다(규칙을 화면이 복제하지 않는다).
    button.disabled = job === undefined && info.blockedReason !== null;
    if (job !== undefined) button.dataset.pending = 'true';

    button.append(element('span', 'title', `${info.nameKo} Lv ${info.level}`));

    if (job !== undefined) {
      const remaining = Math.max(0, job.completesAtHour - nowHour);
      button.append(element('span', 'hint', `Lv ${job.targetLevel} 건설 중 · 남은 ${remaining}시간`));
    } else if (info.blockedReason === 'SYSTEM_NOT_IMPLEMENTED') {
      // 사유는 아래 inertReasonKo 한 줄이 이미 설명한다 — 코드를 덧붙이지 않는다.
      button.append(element('span', 'hint locked', '아직 지을 수 없습니다.'));
    } else if (info.blockedReason !== null) {
      button.append(element('span', 'hint locked', BLOCKED_REASON_LABELS[info.blockedReason]
        ?? info.blockedReason));
    } else {
      const cost = Object.entries(info.nextCost)
        .map(([id, amount]) => `${RESOURCE_LABELS[id as ResourceId] ?? id} ${amount}`)
        .join(' · ');
      button.append(element(
        'span',
        'hint',
        `Lv ${info.nextLevel} · ${cost} · ${info.nextHours}시간`,
      ));
    }
    if (info.inertReasonKo !== null) {
      button.append(element('span', 'hint inert', info.inertReasonKo));
    }
    host.append(button);
  }
}

/**
 * 도시 화면에서 부지를 탭했을 때 뜨는 패널.
 * 캔버스 한 번의 탭으로 자원이 나가지 않도록 선택과 실행을 나눈다.
 */
export function renderCitySelection(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  selected: BuildingId | null,
  nowHour: number,
): void {
  host.replaceChildren();
  if (selected === null || snapshot === null) {
    host.append(element('p', 'hint-line', '건물을 눌러 증설할 수 있습니다.'));
    return;
  }
  const level = snapshot.buildings[selected] ?? 1;
  const job = snapshot.jobs.find(
    (candidate) => candidate.status === 'pending' && candidate.buildingId === selected,
  );
  const card = element('div', 'selection');
  card.append(element('span', 'title', `${BUILDING_LABELS[selected]} Lv ${level}`));
  if (job === undefined) {
    const button = element('button', 'action primary');
    button.type = 'button';
    button.dataset.command = 'build';
    button.dataset.building = selected;
    button.append(
      element('span', 'title', `Lv ${level + 1}로 증설`),
      element('span', 'hint', '비용과 가능 여부는 서버가 판정합니다.'),
    );
    card.append(button);
  } else {
    const remaining = Math.max(0, job.completesAtHour - nowHour);
    card.append(element(
      'span',
      'hint-line',
      `Lv ${job.targetLevel} 건설 중 · 남은 ${remaining}시간`,
    ));
  }
  host.append(card);
}

/**
 * 진형 선택(D-045).
 *
 * 로드맵 1단계 기준이 "정찰·조합·**진형**이 의미 있는 차이를 만든다"인데, 지금까지 열은
 * 병종별로 고정돼 있어 선택지가 아니었다. 금지 조합은 없다 — 사거리와 피격 순서가 만드는
 * 대가만 있으므로, 서버가 규칙에서 만든 설명을 붙여 그대로 고르게 한다.
 */
export function renderFormation(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  rows: ReadonlyMap<string, Row>,
): void {
  host.replaceChildren();
  const ready = Object.entries(snapshot?.army.ready ?? {}).filter(([, count]) => count > 0);
  if (ready.length === 0) {
    host.append(element('p', 'empty', '동원한 병력이 있으면 배치 열을 정할 수 있습니다.'));
    return;
  }
  const byId = new Map((snapshot?.units ?? []).map((unit) => [unit.unitId, unit]));
  for (const [unitId, count] of ready) {
    const unit = byId.get(unitId);
    const line = element('div', 'unit-row formation-row');
    const label = element('div', 'unit-label');
    label.append(element('span', 'unit-name', `${unitLabel(unitId)} ${count}`));
    label.append(element('span', 'unit-cost', unit?.rowHintKo ?? ''));
    line.append(label);

    const picker = element('div', 'row-picker');
    const current = rows.get(unitId) ?? unit?.defaultRow ?? 'mid';
    for (const row of ROW_ORDER) {
      const button = element('button', 'row-button');
      button.type = 'button';
      button.dataset.rowUnit = unitId;
      button.dataset.row = row;
      button.textContent = ROW_LABELS[row];
      if (row === current) button.dataset.selected = 'true';
      picker.append(button);
    }
    line.append(picker);
    host.append(line);
  }
}

/**
 * 목표(NPC 시나리오) 목록. 잠긴 항목도 조건과 함께 보여줘서 다음에 무엇이 열리는지 알린다.
 * 해금 판정은 서버가 내려준 값을 그대로 쓴다(규칙을 화면이 복제하지 않는다).
 */
export function renderScenarios(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  selectedId: string | null,
): void {
  host.replaceChildren();
  const scenarios = snapshot?.scenarios ?? [];
  if (scenarios.length === 0) {
    host.append(element('p', 'empty', '목표를 불러오는 중입니다.'));
    return;
  }
  for (const scenario of scenarios) {
    const button = element('button', 'action scenario');
    button.type = 'button';
    button.dataset.scenario = scenario.id;
    button.disabled = !scenario.unlocked;
    if (scenario.id === selectedId) button.dataset.selected = 'true';
    if (scenario.cleared) button.dataset.cleared = 'true';

    const head = element('span', 'title');
    head.append(document.createTextNode(`${scenario.tier}. ${scenario.nameKo}`));
    if (scenario.cleared) head.append(element('span', 'badge good', '격파'));
    else if (!scenario.unlocked) head.append(element('span', 'badge', '잠김'));
    button.append(head);

    if (!scenario.unlocked) {
      button.append(element('span', 'hint', `${scenario.requiresNameKo ?? '앞 단계'} 격파 후 열립니다.`));
    } else {
      const reward = Object.entries(scenario.victoryReward)
        .map(([id, amount]) => `${RESOURCE_LABELS[id as ResourceId] ?? id} ${amount}`)
        .join(' · ');
      button.append(element('span', 'hint', scenario.briefKo));
      if (reward.length > 0) button.append(element('span', 'hint reward', `승리 보상 ${reward}`));
    }
    host.append(button);
  }
}

/**
 * 교리 선택(D-041). 효과 문구는 서버가 규칙 수치에서 만들어 보낸 것을 그대로 쓴다.
 * 교리는 공격에만 적용되므로 정찰과는 무관하다.
 */
export function renderDoctrines(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  selectedId: string | null,
): void {
  host.replaceChildren();
  const doctrines = snapshot?.doctrines ?? [];
  if (doctrines.length === 0) {
    host.append(element('p', 'empty', '교리를 불러오는 중입니다.'));
    return;
  }
  for (const doctrine of doctrines) {
    const button = element('button', 'action doctrine');
    button.type = 'button';
    button.dataset.doctrine = doctrine.id;
    if (doctrine.id === selectedId) button.dataset.selected = 'true';
    button.append(
      element('span', 'title', doctrine.nameKo),
      element('span', 'hint', doctrine.effectsKo.join(' · ')),
    );
    host.append(button);
  }
}

/**
 * 편성 선택(D-043). 병종별 수량을 직접 정한다.
 * 비용·해금은 서버가 준 값을 표시하고, 최종 판정도 서버가 한다.
 */
export function renderMobilize(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  order: ReadonlyMap<string, number>,
): void {
  host.replaceChildren();
  const units = snapshot?.units ?? [];
  if (units.length === 0) {
    host.append(element('p', 'empty', '병종을 불러오는 중입니다.'));
    return;
  }

  // 선택한 편성의 총비용을 서버가 준 단가로 합산해 보여준다(판정이 아니라 표시다).
  const total = new Map<ResourceId, number>();
  for (const unit of units) {
    const count = order.get(unit.unitId) ?? 0;
    if (count === 0) continue;
    for (const [resourceId, amount] of Object.entries(unit.trainCost)) {
      if (amount === undefined) continue;
      const id = resourceId as ResourceId;
      total.set(id, (total.get(id) ?? 0) + amount * count);
    }
  }

  for (const unit of units) {
    const count = order.get(unit.unitId) ?? 0;
    const line = element('div', 'unit-row');
    if (!unit.unlocked) line.dataset.locked = 'true';

    const label = element('div', 'unit-label');
    label.append(element('span', 'unit-name', unit.nameKo));
    if (unit.unlocked) {
      const cost = Object.entries(unit.trainCost)
        .map(([id, amount]) => `${RESOURCE_LABELS[id as ResourceId] ?? id} ${amount}`)
        .join(' · ');
      label.append(element('span', 'unit-cost', cost));
    } else {
      label.append(element(
        'span',
        'unit-cost locked',
        `${unit.requiresBuildingNameKo ?? '건물'} ${unit.requiresLevel ?? ''}레벨 필요`,
      ));
    }
    line.append(label);

    if (unit.unlocked) {
      const stepper = element('div', 'unit-stepper');
      for (const [delta, text] of [[-1, '−'], [1, '+']] as const) {
        const button = element('button', 'step-button');
        button.type = 'button';
        button.dataset.unit = unit.unitId;
        button.dataset.delta = String(delta);
        button.textContent = text;
        button.disabled = delta < 0 && count === 0;
        stepper.append(button);
      }
      const value = element('span', 'unit-count', String(count));
      stepper.insertBefore(value, stepper.lastChild);
      line.append(stepper);
    }
    host.append(line);
  }

  const summary = element('div', 'mobilize-summary');
  const picked = [...order.values()].reduce((sum, count) => sum + count, 0);
  if (picked === 0) {
    summary.append(element('span', 'hint-line', '동원할 병종의 수량을 정하십시오.'));
  } else {
    const costText = [...total.entries()]
      .map(([id, amount]) => `${RESOURCE_LABELS[id]} ${amount}`)
      .join(' · ');
    summary.append(element('span', 'hint-line', `총 ${picked}기 · ${costText}`));
  }
  host.append(summary);
}

/**
 * 연구 목록(D-044). 단계·비용·효과·불가 사유를 서버가 준 값으로 표시한다.
 * 효과 문구도 서버가 규칙 수치에서 만든 것이며 화면이 배수를 복제하지 않는다.
 */
export function renderResearch(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
): void {
  host.replaceChildren();
  const items = snapshot?.research ?? [];
  if (items.length === 0) {
    host.append(element('p', 'hint-line', '연구소를 세우면 연구를 할 수 있습니다.'));
    return;
  }
  for (const item of items) {
    const button = element('button', 'action research');
    button.type = 'button';
    button.dataset.research = item.researchId;
    button.dataset.target = String(item.nextLevel ?? 0);
    button.disabled = item.blockedReason !== null;

    const head = element('span', 'title');
    head.append(document.createTextNode(`${item.nameKo} ${item.level}/${item.maxLevel}`));
    head.append(element('span', 'badge', item.categoryKo));
    button.append(head);
    button.append(element('span', 'hint', item.descriptionKo));

    if (item.currentEffectKo.length > 0) {
      button.append(element('span', 'hint current', `현재 ${item.currentEffectKo}`));
    }
    if (item.blockedReason === 'MAX_LEVEL') {
      button.append(element('span', 'hint locked', '최대 단계입니다.'));
    } else if (item.blockedReason === 'RESEARCH_LAB_REQUIRED') {
      button.append(element('span', 'hint locked', `연구소 ${item.requiresLabLevel}레벨 필요`));
    } else if (item.blockedReason === 'RESEARCH_PREREQUISITE') {
      button.append(element(
        'span',
        'hint locked',
        `${item.requiresResearchNameKo ?? '선행 연구'} 먼저 필요`,
      ));
    } else {
      button.append(element(
        'span',
        'hint reward',
        `${item.nextLevel}단계 · 군표 ${item.nextScripCost} · ${item.effectKo}`,
      ));
    }
    host.append(button);
  }
}

export interface Objective {
  readonly command: 'build' | 'mobilize' | 'recon' | 'attack';
  readonly building?: BuildingId;
  readonly title: string;
  readonly why: string;
}

/**
 * 지금 할 일 하나를 서버 상태에서 고른다.
 * 순서는 로드맵의 통과 기준(기본 성장 → 첫 전투)을 따르고, 그 뒤에는 막고 있는 조건을 먼저 본다.
 * 비용·게이트 수치는 판단에 쓰지 않는다(서버 판정 대상).
 */
export function nextObjective(
  snapshot: OperationsSnapshot | null,
  nowHour: number,
  scenarioId: string | null,
): Objective {
  const hasArmy = Object.values(snapshot?.army.ready ?? {}).some((count) => count > 0);
  const target = snapshot?.scenarios.find((entry) => entry.id === scenarioId) ?? null;
  const targetName = target?.nameKo ?? '목표';
  // 정찰 보고서는 시나리오마다 따로다. 다른 목표의 보고서로는 공격할 수 없다.
  const recon = snapshot?.latestRecon ?? null;
  const reconValid = recon !== null
    && recon.scenarioId === scenarioId
    && nowHour < recon.expiresAtHour;
  const foughtBefore = (snapshot?.battleReports.length ?? 0) > 0;
  const anyPending = snapshot?.jobs.some((job) => job.status === 'pending') ?? false;

  // 성장을 한 번도 하지 않았고 건설 중인 것도 없으면 성장을 먼저 안내한다.
  if ((snapshot?.buildings.farm ?? 1) < 2 && !anyPending) {
    return {
      command: 'build',
      building: 'farm',
      title: '농장을 증설하십시오',
      why: '식량 생산을 늘리는 첫 성장 단계입니다. 건설은 서버가 시간에 맞춰 완료합니다.',
    };
  }
  if (!hasArmy) {
    // 부상병이 있으면 처음부터 다시 뽑는 것 말고 회복이라는 길이 있다는 걸 알린다(D-045).
    const woundedTotal = Object.values(snapshot?.army.wounded ?? {})
      .reduce((sum, count) => sum + count, 0);
    const recovering = (snapshot?.recoveries.length ?? 0) > 0;
    return {
      command: 'mobilize',
      title: '부대를 동원하십시오',
      why: recovering
        ? '회복 중인 부상병이 복귀하면 다시 싸울 수 있습니다. 기다리지 않으려면 새로 동원하십시오.'
        : woundedTotal > 0
          ? `부상병 ${woundedTotal}기가 있습니다. 도시 탭에서 보급품으로 회복시키거나 새로 동원하십시오.`
          : foughtBefore
            ? '지난 전투로 병력이 남지 않았습니다. 정찰과 공격에는 병력이 필요합니다.'
            : '정찰과 공격에는 병력이 필요합니다.',
    };
  }
  if (!reconValid) {
    return {
      command: 'recon',
      title: `${targetName}${objectParticle(targetName)} 정찰하십시오`,
      why: recon === null || recon.scenarioId !== scenarioId
        ? '적 규모를 모르면 공격할 수 없습니다.'
        : '정찰 보고서가 만료되었습니다. 다시 정찰해야 공격할 수 있습니다.',
    };
  }
  return {
    command: 'attack',
    title: `${targetName}${objectParticle(targetName)} 공격하십시오`,
    why: `정찰 보고서가 ${recon!.expiresAtHour - nowHour}시간 뒤 만료됩니다. 승리하면 자원을 얻습니다.`,
  };
}

export function renderObjective(
  host: HTMLElement,
  snapshot: OperationsSnapshot | null,
  nowHour: number,
  scenarioId: string | null,
): void {
  host.replaceChildren();
  if (snapshot === null) return;
  const objective = nextObjective(snapshot, nowHour, scenarioId);
  host.dataset.command = objective.command;
  // 이전 목표의 건물이 남지 않게 항상 덮거나 지운다.
  if (objective.building === undefined) delete host.dataset.building;
  else host.dataset.building = objective.building;
  // 본문을 감싸고 오른쪽에 화살표를 둔다 — 눌러서 실행되는 줄이라는 걸 모양으로 알린다.
  const body = element('div', 'objective-body');
  body.append(
    element('span', 'objective-tag', '다음'),
    element('span', 'objective-title', objective.title),
    element('span', 'objective-why', objective.why),
  );
  host.append(body);
  const chevron = document.createElement('template');
  chevron.innerHTML = CHEVRON;
  if (chevron.content.firstElementChild !== null) host.append(chevron.content.firstElementChild);
}

export function renderRecon(host: HTMLElement, recon: ReconReport | null, nowHour: number): void {
  host.replaceChildren();
  if (recon === null) {
    host.append(element('p', 'empty', '저장된 정찰 보고서가 없습니다.'));
    return;
  }
  const expired = nowHour >= recon.expiresAtHour;
  const badge = element('span', `badge ${expired ? 'bad' : 'good'}`, expired ? '만료' : '유효');
  const header = element('div', 'row');
  header.append(element('span', 'k', recon.scenarioNameKo), badge);

  const list = element('div', 'rows');
  list.append(
    row('정확도', `${(recon.accuracy * 100).toFixed(1)}%`),
    row('유효 시간', expired
      // 서버 내부 시각 표기(h545)는 플레이어에게 뜻이 없다. 남은 시간으로만 말한다(D-047).
      ? `${nowHour - recon.expiresAtHour}시간 전 만료`
      : `${recon.expiresAtHour - nowHour}시간 남음`),
  );
  for (const threat of recon.threats) {
    list.append(row(unitLabel(threat.unitId), `${threat.minimum}–${threat.maximum}`));
  }
  host.append(header, list);
}

/** 병종 단위 결과 한 덩어리. `initial → survivors`로 무엇이 줄었는지 보여준다. */
function sideBlock(title: string, side: SideReport): HTMLElement {
  const wrap = element('div', 'side-block');
  wrap.append(element(
    'div',
    'side-title',
    `${title} · 잔존 ${Math.round(side.remainingRatio * 100)}%`,
  ));
  const list = element('div', 'rows');
  for (const stack of side.stacks) {
    const lost: string[] = [];
    if (stack.dead > 0) lost.push(`전사 ${stack.dead}`);
    if (stack.wounded > 0) lost.push(`부상 ${stack.wounded}`);
    const suffix = lost.length === 0 ? ' (무손실)' : ` (${lost.join(' · ')})`;
    list.append(row(
      `${stack.nameKo} · 가한 피해 ${Math.round(stack.damageDealt)}`,
      `${stack.initial} → ${stack.survivors}${suffix}`,
    ));
  }
  if (side.stacks.length === 0) list.append(element('p', 'empty', '기록 없음'));
  wrap.append(list);
  return wrap;
}

/** 새 보고서만 순차로 등장시킨다. 3초 주기 재조회에서 애니메이션이 반복되지 않게 한다. */
let revealedReportId: string | null = null;

function reveal(blocks: readonly HTMLElement[], animate: boolean): void {
  for (const [index, block] of blocks.entries()) {
    if (!animate) {
      block.dataset.shown = 'true';
      continue;
    }
    block.dataset.shown = 'false';
    setTimeout(() => { block.dataset.shown = 'true'; }, 300 * index + 120);
  }
}

export function renderBattle(host: HTMLElement, report: BattleReport | undefined): void {
  host.replaceChildren();
  if (report === undefined) {
    host.append(element('p', 'empty', '저장된 전투 보고서가 없습니다.'));
    revealedReportId = null;
    return;
  }
  const animate = report.id !== revealedReportId;
  revealedReportId = report.id;
  const { result } = report;

  const head = element('div', 'battle-head');
  head.append(
    element(
      'span',
      `badge ${result.outcome === 'attacker_win' ? 'good' : 'bad'}`,
      OUTCOME_LABELS[result.outcome] ?? result.outcome,
    ),
    element(
      'span',
      'battle-sub',
      `${REASON_LABELS[result.reason] ?? result.reason} · ${result.rounds}라운드`,
    ),
  );
  if (result.initiative !== null) {
    head.append(element('span', 'battle-sub', `선제권 ${SIDE_LABELS[result.initiative]}`));
  }
  // 어떤 교리로 싸웠는지 남겨야 다음 편성을 바꿀 근거가 된다(D-042).
  if (report.doctrineNameKo.length > 0) {
    head.append(element('span', 'battle-sub doctrine-used', report.doctrineNameKo));
  }
  host.append(head);

  const byRound = new Map<number, AttackEvent[]>();
  for (const event of result.events) {
    const bucket = byRound.get(event.round);
    if (bucket === undefined) byRound.set(event.round, [event]);
    else bucket.push(event);
  }
  const timeline = element('div', 'timeline');
  const blocks: HTMLElement[] = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const block = element('div', 'round');
    block.append(element('div', 'round-no', `라운드 ${round}`));
    for (const event of byRound.get(round) ?? []) {
      const target: Side = event.side === 'attacker' ? 'defender' : 'attacker';
      const line = element('div', `strike ${event.side}`);
      line.append(
        element('span', 'who', `${SIDE_LABELS[event.side]} ${unitLabel(event.unitId)}`),
        element('span', 'arrow', '→'),
        element('span', 'whom', `${SIDE_LABELS[target]} ${unitLabel(event.targetUnitId)}`),
        element('span', 'dmg', event.damage.toFixed(1)),
      );
      if (event.counterMult !== 1) {
        line.append(element(
          'span',
          `mult ${event.counterMult > 1 ? 'up' : 'down'}`,
          `×${event.counterMult}`,
        ));
      }
      block.append(line);
    }
    blocks.push(block);
    timeline.append(block);
  }
  if (blocks.length === 0) timeline.append(element('p', 'empty', '교전 기록이 없습니다.'));
  host.append(timeline);
  reveal(blocks, animate);

  host.append(sideBlock('우리 부대', result.attacker), sideBlock('적 부대', result.defender));

  const reward = Object.entries(report.reward)
    .map(([id, amount]) => `${RESOURCE_LABELS[id as keyof typeof RESOURCE_LABELS] ?? id} ${amount}`)
    .join(', ');
  const summary = element('div', 'rows');
  summary.append(row('보상', reward.length > 0 ? reward : '없음'));
  for (const counter of result.counters.slice(0, 3)) {
    const target: Side = counter.side === 'attacker' ? 'defender' : 'attacker';
    summary.append(row(
      `상성 ${SIDE_LABELS[counter.side]} ${unitLabel(counter.unitId)}`
      + ` → ${SIDE_LABELS[target]} ${unitLabel(counter.targetUnitId)}`,
      `×${counter.multiplier} · 누적 ${Math.round(counter.totalDamage)}`,
    ));
  }
  host.append(summary);

  const recommendation = report.analysis.recommendationKo;
  if (typeof recommendation === 'string' && recommendation.length > 0) {
    host.append(element('p', 'empty', `개선: ${recommendation}`));
  }
  host.append(element('p', 'trace', `재현 정보 · seed ${report.seed} · hash ${result.hash}`));
}

export function buildingSummary(snapshot: OperationsSnapshot | null): string {
  if (snapshot === null) return '—';
  return Object.entries(snapshot.buildings)
    .map(([id, level]) => `${BUILDING_LABELS[id as keyof typeof BUILDING_LABELS] ?? id} ${level}`)
    .join(' · ');
}

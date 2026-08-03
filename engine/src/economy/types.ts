/** 경제 시뮬레이션 공개 타입. 권위 서버 경제 계약을 검증하기 위한 PoC 스키마다. */

export const RESOURCE_IDS = [
  'food',
  'steel',
  'oil',
  'supplies',
  'manpower',
  'scrip',
] as const;

export type ResourceId = (typeof RESOURCE_IDS)[number];

export type ResourceBundle = Record<ResourceId, number>;
export type PartialBundle = Partial<ResourceBundle>;
export type ReadonlyPartialBundle = Readonly<PartialBundle>;

/**
 * 알려진 모든 건물 id의 합집합(D-043).
 * **어떤 도시가 실제로 갖는 건물 집합은 그 도시의 경제 규칙이 정한다** —
 * 이 목록은 id 형식 검증에만 쓰고 "도시의 건물 수"로 쓰지 않는다.
 * 0.1.0 도시는 앞의 7종만 갖고, 0.2.0 도시는 14종을 갖는다.
 */
export const BUILDING_IDS = [
  'hq',
  'farm',
  'steel_mill',
  'refinery',
  'supply_depot',
  'housing',
  'warehouse',
  'barracks',
  'arsenal',
  'airfield',
  'research_lab',
  'radar',
  'defense_hq',
  'alliance_comms',
] as const;

export type BuildingId = (typeof BUILDING_IDS)[number];

export const ECONOMY_UNIT_IDS = [
  'rifle',
  'at_infantry',
  'scout',
  'medium_tank',
  'heavy_tank',
  'howitzer',
  'at_gun',
  'aa_gun',
  'fighter',
  'bomber',
  'engineer',
  'supply_truck',
] as const;

export type EconomyUnitId = (typeof ECONOMY_UNIT_IDS)[number];

export interface BuildingDef {
  readonly id: BuildingId;
  readonly nameKo: string;
  readonly maxLevel: number;
  /** 목표 레벨 n(>=2) 업그레이드 비용 = ceil(base * growth^(n-2)) */
  readonly baseCost: ReadonlyPartialBundle;
  readonly costGrowth: number;
  /** 목표 레벨 n 건설 시간 = ceil(baseHours * hourGrowth^(n-2)) */
  readonly baseHours: number;
  readonly hourGrowth: number;
  /** 시간당 생산량 = perHourPerLevel * 레벨 */
  readonly perHourPerLevel?: ReadonlyPartialBundle;
  /**
   * 이 건물이 쓰이는 시스템이 아직 없다는 표시(D-043, D-044).
   * 값이 있으면 **건설할 수 없다** — 효과가 없는 건물에 자원을 쓰게 두면 함정이 된다.
   * 해당 시스템이 구현되면 이 값을 지워 건설을 연다.
   */
  readonly inertReasonKo?: string;
}

/**
 * 연구 항목(D-044).
 *
 * 사양의 연구 분류(산업·보급·보병·기갑·포병·항공·정찰·방어·지휘) 중
 * **현재 시뮬레이션에 실제로 반영할 수 있는 것만** 정의한다.
 * 효과는 전투 입력 또는 경제 계산에 들어가는 값이며, 없는 시스템에 얹지 않는다.
 */
export interface ResearchDef {
  readonly id: string;
  readonly nameKo: string;
  readonly categoryKo: string;
  readonly descriptionKo: string;
  /** 최대 단계. 단계 n의 비용 = baseCost + costStep * (n - 1) 군표 */
  readonly maxLevel: number;
  readonly baseScripCost: number;
  readonly scripCostStep: number;
  /** 필요한 연구소 레벨 */
  readonly requiresLabLevel: number;
  /** 선행 연구 id */
  readonly requires?: string;
  /** 단계당 효과. 하나만 갖는다. */
  readonly effect: ResearchEffect;
}

/**
 * 연구 효과. 전부 이미 존재하는 계산에 들어가는 값이다 —
 * 새 전투 규칙이나 새 자원을 만들지 않는다.
 */
export type ResearchEffect =
  /** 해당 태그 병종의 공격 배수를 단계당 더한다(교리와 같은 경로로 들어간다). */
  | { readonly kind: 'attack'; readonly tag: string; readonly perLevel: number }
  /** 정찰 정확도를 단계당 permille로 더한다. */
  | { readonly kind: 'recon'; readonly perLevelPermille: number }
  /** 건설 비용을 단계당 비율로 줄인다. */
  | { readonly kind: 'build_cost'; readonly perLevelRate: number }
  /** 출정 비용을 단계당 비율로 줄인다. */
  | { readonly kind: 'sortie_cost'; readonly perLevelRate: number };

/**
 * 병종 해금 조건(D-043).
 * 건물 레벨이 병종을 연다. 값이 없는 병종은 처음부터 동원할 수 있다.
 */
export interface UnitUnlockDef {
  readonly buildingId: BuildingId;
  readonly level: number;
}

export interface UnitEconomyDef {
  readonly unitId: EconomyUnitId;
  readonly trainCost: ReadonlyPartialBundle;
  /** 유닛 1기당 시간당 식량 유지비 */
  readonly upkeepFoodPerHour: number;
}

export interface EconomyBalance {
  /** 창고 레벨별 저장 상한: capBase + capPerLevel * 레벨 */
  readonly warehouseCapBase: number;
  readonly warehouseCapPerLevel: number;
  /** 주거지 레벨별 인력 상한과 시간당 회복 */
  readonly housingCapBase: number;
  readonly housingCapPerLevel: number;
  readonly housingRegenBase: number;
  readonly housingRegenPerLevel: number;
  /** 군표 상한 = scripCapBase + scripCapPerHqLevel * 사령부 레벨 */
  readonly scripCapBase: number;
  readonly scripCapPerHqLevel: number;
  /** 시간당 군표 수입 = 가용 인력 * scripPerManpowerHour */
  readonly scripPerManpowerHour: number;
  /** 연구 비용 = researchBaseCost + researchCostStep * 완료 수 */
  readonly researchBaseCost: number;
  readonly researchCostStep: number;
  /** PvE 출정 비용 = base + ceil(현재 군사 가치 * perArmyValue) */
  readonly sortieBaseCost: ReadonlyPartialBundle;
  readonly sortieCostPerArmyValue: ReadonlyPartialBundle;
  readonly sortieReward: ReadonlyPartialBundle;
  /** 접속 횟수가 지급 횟수가 되지 않도록 일 단위로 충전한다. */
  readonly researchChargesPerDay: number;
  readonly sortieChargesPerDay: number;
  /** 훈련 시 남겨 두는 예비 자원 */
  readonly trainReserve: ReadonlyPartialBundle;
  /** 훈련 후 확보할 현재 부대 식량 유지 시간 */
  readonly upkeepReserveHours: number;
  /** 동시 건설 슬롯(GAME_DESIGN: 기본 2개) */
  readonly buildSlots: number;
  /** 비사령부 목표 레벨 <= 현재 사령부 레벨 + offset */
  readonly nonHqLevelOffset: number;
  /** 같은 레벨에서의 결정론적 건설 우선순위 */
  readonly buildPriority: readonly BuildingId[];
  readonly seasonDays: number;
  readonly maxSessionsPerDay: number;
  readonly maxTrainRatioWeight: number;
  readonly maxTrainRatioTotal: number;
  /**
   * 레이더 레벨당 정찰 정확도 가산(D-043). 없으면 레이더 효과가 없는 규칙이다.
   * 실제 정확도 상한은 서버가 적용한다.
   */
  readonly radarReconAccuracyPerLevel?: number;
  readonly startingResources: Readonly<ResourceBundle>;
  /** 규칙이 정의한 건물의 시작 레벨. 빠진 건물은 1로 본다. */
  readonly startingBuildings: Readonly<Partial<Record<BuildingId, number>>>;
}

export interface EconomyRuleset {
  readonly version: string;
  /** armyValue 산출에 사용한 전투 규칙 스냅샷 버전 */
  readonly combatRuleVersion: string;
  /**
   * 이 규칙이 정의한 건물. **이 집합이 곧 도시의 건물 집합이다** —
   * 전역 `BUILDING_IDS`가 아니라 여기 있는 키로 도시 건물 행을 시드·검증한다.
   */
  readonly buildings: Readonly<Partial<Record<BuildingId, BuildingDef>>>;
  readonly units: Readonly<Record<EconomyUnitId, UnitEconomyDef>>;
  /** 병종 해금 조건. 없는 병종은 제약이 없다(0.1.0은 전체가 비어 있다). */
  readonly unitUnlocks?: Readonly<Partial<Record<EconomyUnitId, UnitUnlockDef>>>;
  /** 연구 항목(D-044). 없으면 연구 시스템이 없는 규칙이다. */
  readonly research?: Readonly<Record<string, ResearchDef>>;
  readonly balance: EconomyBalance;
}

/**
 * 이 규칙에서 도시가 갖는 건물 id(D-043).
 * 선언 순서를 유지하므로 결정론이 보장된다. 전역 `BUILDING_IDS`를 직접 순회하면
 * 규칙이 정의하지 않은 건물까지 도는 버그가 된다.
 */
export function cityBuildingIds(rules: EconomyRuleset): readonly BuildingId[] {
  return BUILDING_IDS.filter((buildingId) => rules.buildings[buildingId] !== undefined);
}

/** 규칙에 없는 건물을 조회하면 즉시 실패한다. 조용히 undefined가 퍼지는 것을 막는다. */
export function buildingDef(rules: EconomyRuleset, buildingId: BuildingId): BuildingDef {
  const definition = rules.buildings[buildingId];
  if (definition === undefined) {
    throw new Error(`경제 규칙 ${rules.version}에 없는 건물입니다: ${buildingId}`);
  }
  return definition;
}

export interface ArchetypeInput {
  readonly id: string;
  readonly nameKo: string;
  /** 하루 접속 횟수(균등 간격) */
  readonly sessionsPerDay: number;
  /** 훈련 비율(양의 정수 가중치) */
  readonly trainRatio: Readonly<Partial<Record<EconomyUnitId, number>>>;
}

export type SortieMode = 'abstract' | 'disabled';

/**
 * 시즌 간 인계 상태(D-027 검토용).
 * 생략한 항목은 규칙의 시작값을 쓴다 — 즉 인계 없음이 기존 동작이다.
 * 이 입력은 모델 비교를 위한 것이며 어떤 초기화 정책도 확정하지 않는다.
 */
export interface SeasonCarryOver {
  /** 인계할 건물 레벨. 규칙 상한을 넘을 수 없다. */
  readonly buildings?: Readonly<Partial<Record<BuildingId, number>>>;
  /** 인계할 병력(ready 기준). */
  readonly army?: Readonly<Partial<Record<EconomyUnitId, number>>>;
  /** 인계할 자원. 저장 상한은 시뮬레이션이 적용한다. */
  readonly resources?: ReadonlyPartialBundle;
}

/** 맵 자원 영토에서 채취 가능한 자원(인력·군표는 채취 대상이 아니다). */
export const NODE_RESOURCE_IDS = ['food', 'steel', 'oil', 'supplies'] as const;
export type NodeResourceId = (typeof NODE_RESOURCE_IDS)[number];

/**
 * 맵 자원 영토 수입 모델(D-028 측정용).
 *
 * 중요: 자원지 확보에는 전투와 맵이 필요하지만 이 시뮬레이터에는 둘 다 없다.
 * 따라서 `heldNodes`는 측정 결과가 아니라 **명시적 가정**이다.
 * 기존과 신규에 서로 다른 값을 주어 확보력 차이를 표현한다.
 */
export interface ResourceNodeInput {
  /** 동시 보유 상한(D-028 결정 1). heldNodes는 이 값을 넘을 수 없다. */
  readonly holdLimit: number;
  /** 실제로 확보·유지한다고 가정하는 노드 수 */
  readonly heldNodes: number;
  /** 노드 1개의 시간당 산출량 */
  readonly yieldPerHour: number;
  /** 노드 1개의 총 매장량. 소진되면 다음 리셋까지 산출이 0이다. */
  readonly stockPerNode: number;
  /** 리셋 주기(시간). 매장량 리필과 종류 변경이 함께 일어난다(D-028 결정 3). */
  readonly resetIntervalHours: number;
  /** 리셋 직후 재확보까지 걸리는 시간. 이 동안 산출이 0이다. */
  readonly recaptureHours: number;
  /** 종류 변경을 결정론적으로 만드는 시드 */
  readonly typeSeed: number;
}

/**
 * 도시 인프라 따라잡기 보정(D-029 검토용).
 *
 * D-028 측정에서 신규의 병목이 자원이 아니라 도시 인프라(인력·저장 상한, 건설 슬롯)로
 * 드러났다. 이 보정은 기준 인프라보다 뒤처진 계정의 건설 비용·시간을 직접 줄인다.
 *
 * 규칙은 대칭이다 — 기준보다 낮으면 누구나 받는다. 기존 계정도 초기에는 받았고
 * 기준에 도달하면 사라진다. 신규에게만 주는 특혜가 아니다.
 */
export interface CatchUpInput {
  /** 기준 인프라 레벨 합. 서버 평균 또는 목표 곡선을 대리한다. */
  readonly referenceLevels: number;
  /** 뒤처진 레벨 1당 감소율 */
  readonly perLevelRate: number;
  /** 최대 감소율 0..0.9 */
  readonly maxReduction: number;
  /** 건설 비용에 적용 */
  readonly applyToCost: boolean;
  /** 건설 시간에 적용 */
  readonly applyToHours: boolean;
}

export interface SeasonInput {
  readonly ruleVersion: string;
  readonly archetype: ArchetypeInput;
  readonly days: number;
  /** 기존 경제 PoC의 추상 출정을 유지하거나, 실제 전투 결합을 위해 비활성화한다. */
  readonly sortieMode?: SortieMode;
  /** 이전 시즌에서 넘어온 상태. 생략 시 규칙의 시작값에서 출발한다. */
  readonly carryOver?: SeasonCarryOver;
  /** 맵 자원 영토 수입(D-028). 생략하면 자원지 수입이 없다. */
  readonly nodes?: ResourceNodeInput;
  /** 도시 인프라 따라잡기 보정(D-029). 생략하면 보정이 없다. */
  readonly catchUp?: CatchUpInput;
}

export type EconomyLedgerReason =
  | 'passive_production'
  | 'unit_upkeep'
  | 'research'
  | 'sortie_cost'
  | 'sortie_reward'
  | 'construction'
  | 'training'
  | 'node_income';

/**
 * 자원 변화 한 건. requestedDelta는 시도량, appliedDelta는 실제 잔액 변화다.
 * 생산 상한 초과는 overflow, 잔액 부족은 shortfall로 별도 보존한다.
 */
export interface EconomyLedgerEntry {
  readonly id: string;
  /** 시즌 시작 기준 0-based 정수 시간 */
  readonly hour: number;
  readonly day: number;
  readonly resourceId: ResourceId;
  readonly reason: EconomyLedgerReason;
  readonly causeId: string;
  readonly requestedDelta: number;
  readonly appliedDelta: number;
  readonly overflow: number;
  readonly shortfall: number;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
}

export interface DailyResourceLedger {
  readonly startBalance: number;
  readonly produced: number;
  readonly consumed: number;
  /** 저장 상한 초과로 소실된 양 */
  readonly overflow: number;
  readonly endBalance: number;
  readonly cap: number;
}

export interface DailyLedger {
  readonly day: number;
  readonly resources: Readonly<Record<ResourceId, DailyResourceLedger>>;
  readonly entries: readonly EconomyLedgerEntry[];
}

export interface ResourceTotals {
  readonly produced: number;
  readonly consumed: number;
  readonly overflow: number;
  /** overflow / max(1, produced) */
  readonly overflowRatio: number;
}

export interface PendingConstruction {
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly completeAtHour: number;
  readonly remainingHours: number;
}

export interface ConstructionEvent {
  readonly causeId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly startedAtHour: number;
  readonly completeAtHour: number;
}

export interface SeasonReport {
  readonly ruleVersion: string;
  readonly combatRuleVersion: string;
  readonly sortieMode: SortieMode;
  readonly archetypeId: string;
  readonly days: number;
  readonly sessionsPerDay: number;
  readonly totalSessions: number;
  readonly daily: readonly DailyLedger[];
  readonly finalResources: Readonly<ResourceBundle>;
  readonly finalBuildings: Readonly<Record<BuildingId, number>>;
  readonly constructions: readonly ConstructionEvent[];
  readonly pendingConstructions: readonly PendingConstruction[];
  readonly finalArmy: Readonly<Record<EconomyUnitId, number>>;
  /** 전투 규칙 v0.1.0의 병종 비용 합(군사 가치) */
  readonly armyValue: number;
  readonly totals: Readonly<Record<ResourceId, ResourceTotals>>;
  /** 식량 유지비를 전액 지불하지 못한 정수 시간 */
  readonly starvationHours: number;
  readonly unmetUpkeepFood: number;
  readonly researchCount: number;
  readonly sortieCount: number;
  readonly constructionStarted: number;
  readonly constructionCompleted: number;
  readonly trainedUnits: number;
  /** 자원지에서 실제로 유입된 총량(자원별). nodes 미지정 시 전부 0이다. */
  readonly nodeIncome: Readonly<ResourceBundle>;
  /** 자원지 수입이 전체 유입에서 차지한 비율 0..1 */
  readonly nodeIncomeShare: number;
  /** 따라잡기 보정으로 절약한 건설 비용 총액(자원 합계) */
  readonly catchUpSavedCost: number;
  /** 따라잡기 보정으로 단축한 건설 시간 총합 */
  readonly catchUpSavedHours: number;
}

/**
 * 서버 응답 계약 타입(D-025).
 * 서버가 권위이며 클라이언트는 이 형태를 "표시"만 한다 — 규칙·비용·판정을 복제하지 않는다.
 * 서버 `server/src/types.ts`의 스냅샷 계약을 화면에 필요한 범위만 반영한다.
 */

export const RESOURCE_IDS = ['food', 'steel', 'oil', 'supplies', 'manpower', 'scrip'] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];

export const RESOURCE_LABELS: Readonly<Record<ResourceId, string>> = {
  food: '식량',
  steel: '강철',
  oil: '석유',
  supplies: '보급품',
  manpower: '인력',
  scrip: '군표',
};

/**
 * 알려진 모든 건물 id(D-043).
 * **도시가 실제로 갖는 건물은 스냅샷의 `buildings` 키가 정한다** — 이 목록은 표시 순서와
 * 이름표를 위한 것이고, 규칙 버전이 낮은 도시는 앞의 7종만 갖는다.
 */
export const BUILDING_IDS = [
  'hq', 'farm', 'steel_mill', 'refinery', 'supply_depot', 'housing', 'warehouse',
  'barracks', 'arsenal', 'airfield', 'research_lab', 'radar', 'defense_hq', 'alliance_comms',
] as const;
export type BuildingId = (typeof BUILDING_IDS)[number];

export const BUILDING_LABELS: Readonly<Record<BuildingId, string>> = {
  hq: '사령부',
  farm: '농장',
  steel_mill: '제철소',
  refinery: '정유소',
  supply_depot: '물류센터',
  housing: '주거지',
  warehouse: '창고',
  barracks: '병영',
  arsenal: '군수공장',
  airfield: '비행장',
  research_lab: '연구소',
  radar: '레이더',
  defense_hq: '방어사령부',
  alliance_comms: '연맹 통신소',
};

/** 스냅샷에 실제로 들어 있는 건물만 표시 순서대로 돌려준다. */
export function presentBuildingIds(
  buildings: Readonly<Partial<Record<BuildingId, number>>>,
): readonly BuildingId[] {
  return BUILDING_IDS.filter((buildingId) => buildings[buildingId] !== undefined);
}

export const UNIT_LABELS: Readonly<Record<string, string>> = {
  rifle: '소총병',
  at_infantry: '대전차보병',
  scout: '정찰차량',
  medium_tank: '중형전차',
  heavy_tank: '중전차',
  howitzer: '야포',
  at_gun: '대전차포',
  aa_gun: '대공포',
  fighter: '전투기',
  bomber: '폭격기',
  engineer: '공병',
  supply_truck: '수송대',
};

export type Row = 'front' | 'mid' | 'back';

export const ROW_LABELS: Readonly<Record<Row, string>> = {
  front: '전열',
  mid: '중열',
  back: '후열',
};

export const ROW_ORDER: readonly Row[] = ['front', 'mid', 'back'];

export interface ConstructionJob {
  readonly id: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly startedAtHour: number;
  readonly completesAtHour: number;
  readonly status: 'pending' | 'completed';
}

export type ArmyInventory = Readonly<Record<string, number>>;

export interface ArmyState {
  readonly ready: ArmyInventory;
  readonly wounded: ArmyInventory;
  readonly dead: ArmyInventory;
}

export interface ReconThreat {
  readonly unitId: string;
  readonly minimum: number;
  readonly maximum: number;
}

export interface ReconReport {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioNameKo: string;
  readonly scoutCount: number;
  readonly accuracy: number;
  readonly createdAtHour: number;
  readonly expiresAtHour: number;
  readonly threats: readonly ReconThreat[];
}

export interface UnitCasualty {
  readonly unitId: string;
  readonly dead: number;
  readonly wounded: number;
}

export type Side = 'attacker' | 'defender';

export const SIDE_LABELS: Readonly<Record<Side, string>> = {
  attacker: '우리',
  defender: '적',
};

/**
 * 라운드별 공격 1건. 서버가 `result.events`로 이미 보내는 값이며 화면은 표시만 한다.
 * 데미지·상성 배수는 서버가 계산한 결과이고 클라이언트가 다시 계산하지 않는다.
 */
export interface AttackEvent {
  readonly round: number;
  readonly side: Side;
  readonly unitId: string;
  readonly targetUnitId: string;
  readonly damage: number;
  readonly counterMult: number;
}

/** 병종 단위 전투 결과. `initial`에서 `survivors`로 줄어든 과정이 events에 남는다. */
export interface StackReport {
  readonly unitId: string;
  readonly nameKo: string;
  readonly row: Row;
  readonly initial: number;
  readonly survivors: number;
  readonly dead: number;
  readonly wounded: number;
  readonly damageDealt: number;
  readonly damageTaken: number;
}

export interface SideReport {
  readonly stacks: readonly StackReport[];
  readonly remainingRatio: number;
}

/** 상성 교전 누적. 서버가 누적 피해 상위 항목만 골라 보낸다. */
export interface CounterReport {
  readonly side: Side;
  readonly unitId: string;
  readonly targetUnitId: string;
  readonly multiplier: number;
  readonly totalDamage: number;
}

export interface BattleReport {
  readonly id: string;
  readonly scenarioNameKo: string;
  readonly seed: number;
  readonly createdAtHour: number;
  readonly sortieCost: Readonly<Partial<Record<ResourceId, number>>>;
  readonly reward: Readonly<Partial<Record<ResourceId, number>>>;
  readonly casualties: readonly UnitCasualty[];
  readonly result: {
    readonly outcome: string;
    readonly reason: string;
    readonly rounds: number;
    readonly hash: string;
    readonly initiative: Side | null;
    readonly attacker: SideReport;
    readonly defender: SideReport;
    readonly counters: readonly CounterReport[];
    readonly events: readonly AttackEvent[];
  };
  readonly analysis: {
    readonly recommendationKo?: string;
    readonly [key: string]: unknown;
  };
  /** 이 전투에 쓴 교리(D-042). 서버가 전투 입력에서 꺼내 준다. */
  readonly doctrine: string;
  readonly doctrineNameKo: string;
}

export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  attacker_win: '승리',
  defender_win: '패배',
  draw: '무승부',
};

export const REASON_LABELS: Readonly<Record<string, string>> = {
  annihilation: '적 전멸',
  retreat: '적 퇴각',
  timeout: '시간 초과',
  mutual_retreat: '양측 퇴각',
};

/**
 * NPC 시나리오 목록 항목(D-040).
 * 해금·격파는 서버가 판정한 값이며 화면은 표시만 한다.
 * 방어 편성은 오지 않는다 — 적 규모를 아는 수단은 정찰이다.
 */
export interface ScenarioEntry {
  readonly id: string;
  readonly nameKo: string;
  readonly briefKo: string;
  readonly tier: number;
  readonly victoryReward: Readonly<Partial<Record<ResourceId, number>>>;
  readonly cleared: boolean;
  readonly unlocked: boolean;
  readonly requiresScenarioId: string | null;
  readonly requiresNameKo: string | null;
}

/**
 * 선택 가능한 전투 교리(D-041).
 * `effectsKo`는 서버가 규칙 수치에서 만든 설명이다 — 화면이 배수를 복제하지 않는다.
 */
export interface DoctrineEntry {
  readonly id: string;
  readonly nameKo: string;
  readonly effectsKo: readonly string[];
}

/**
 * 동원 가능한 병종(D-043).
 * 훈련 비용과 해금 조건은 서버가 판정해 내려준다 — 화면이 비용·게이트를 복제하지 않는다.
 */
export interface UnitEntry {
  readonly unitId: string;
  readonly nameKo: string;
  readonly trainCost: Readonly<Partial<Record<ResourceId, number>>>;
  readonly upkeepFoodPerHour: number;
  readonly unlocked: boolean;
  readonly requiresBuildingId: string | null;
  readonly requiresBuildingNameKo: string | null;
  readonly requiresLevel: number | null;
  /** 진형 선택용 규칙 값(D-045). 화면은 기본 열 표를 따로 갖지 않는다. */
  readonly defaultRow: Row;
  readonly rowHintKo: string;
}

/**
 * 건물별 증설 정보(D-043).
 * `blockedReason`은 서버 오류 코드와 같은 값이고, `inertReasonKo`는 효과가 없는 이유다.
 */
export interface BuildingInfo {
  readonly buildingId: BuildingId;
  readonly nameKo: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly nextLevel: number | null;
  readonly nextCost: Readonly<Partial<Record<ResourceId, number>>>;
  readonly nextHours: number;
  readonly blockedReason: string | null;
  readonly inertReasonKo: string | null;
}

/**
 * 연구 항목(D-044).
 * 다음 단계 비용·가능 여부·효과 문구를 서버가 판정해 내려준다.
 */
export interface ResearchEntry {
  readonly researchId: string;
  readonly nameKo: string;
  readonly categoryKo: string;
  readonly descriptionKo: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly nextLevel: number | null;
  readonly nextScripCost: number;
  readonly effectKo: string;
  readonly currentEffectKo: string;
  readonly blockedReason: string | null;
  readonly requiresLabLevel: number;
  readonly requiresResearchId: string | null;
  readonly requiresResearchNameKo: string | null;
}

/** 진행 중인 부상병 회복 1건(D-045). */
export interface RecoveryJob {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly unitId: string;
  readonly count: number;
  readonly startedAtHour: number;
  readonly completesAtHour: number;
  readonly status: 'pending' | 'completed';
}

/**
 * 회복 규칙 안내(D-045).
 * 비용은 `ceil(전투가치 합 × suppliesRate)`라 병종별로 나누어 떨어지지 않는다.
 * 그래서 서버가 병종별 전투가치와 비율을 주고, 화면은 그대로 합산만 한다.
 */
export interface RecoveryInfo {
  readonly hours: number;
  readonly suppliesRate: number;
  readonly unitValues: Readonly<Record<string, number>>;
}

/** GET /v1/cities/{id}/operations — 도시·병력·정찰·전투를 한 번에 준다. */
export interface OperationsSnapshot {
  readonly cityId: string;
  /** 플레이어가 정한 도시 이름(D-054). 서버가 정규화한 값이다. */
  readonly name: string;
  readonly ownerId: string;
  readonly version: number;
  readonly lastServerHour: number;
  readonly resourcesMicro: Readonly<Record<ResourceId, number>>;
  /** 이 도시가 가진 건물만 들어온다(규칙 버전에 따라 7종 또는 14종). */
  readonly buildings: Readonly<Partial<Record<BuildingId, number>>>;
  readonly jobs: readonly ConstructionJob[];
  readonly army: ArmyState;
  readonly recoveries: readonly RecoveryJob[];
  readonly recoveryInfo: RecoveryInfo;
  /** 현재 건물 기준 시간당 생산량(D-045). 서버가 규칙에서 계산한다. */
  readonly productionPerHour: Readonly<Partial<Record<ResourceId, number>>>;
  readonly latestRecon: ReconReport | null;
  readonly battleReports: readonly BattleReport[];
  readonly scenarios: readonly ScenarioEntry[];
  readonly doctrines: readonly DoctrineEntry[];
  readonly units: readonly UnitEntry[];
  readonly buildingInfo: readonly BuildingInfo[];
  readonly research: readonly ResearchEntry[];
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly nowHour: number;
}

/** 자원 잔액은 micro 정수로 저장된다(1 자원 = 1,000 micro). */
export const MICRO_SCALE = 1_000;

export function fromMicro(micro: number): number {
  return micro / MICRO_SCALE;
}

export function unitLabel(unitId: string): string {
  return UNIT_LABELS[unitId] ?? unitId;
}

/** 전투 시뮬레이터 공개 타입. 이 스키마는 이후 서버 전투 API 계약의 초안이다. */

export type Row = 'front' | 'mid' | 'back';

export type UnitTag =
  | 'infantry'
  | 'recon'
  | 'armor_medium'
  | 'armor_heavy'
  | 'artillery'
  | 'at'
  | 'aa'
  | 'air_fighter'
  | 'air_bomber'
  | 'support';

/**
 * 병종 분류의 한국어 표기(D-041).
 * 교리 효과 설명을 수치에서 생성할 때 쓴다 — 설명을 손으로 적으면 밸런스와 어긋난다.
 */
export const UNIT_TAG_LABELS_KO: Readonly<Record<UnitTag, string>> = {
  infantry: '보병',
  recon: '정찰',
  armor_medium: '중형전차',
  armor_heavy: '중전차',
  artillery: '포병',
  at: '대전차',
  aa: '대공',
  air_fighter: '전투기',
  air_bomber: '폭격기',
  support: '지원',
};

export type DoctrineId =
  | 'none'
  | 'armor_breakthrough'
  | 'artillery_support'
  | 'air_superiority'
  | 'defense'
  | 'logistics'
  | 'recon_mobility';

export interface UnitDef {
  id: string;
  nameKo: string;
  domain: 'ground' | 'air';
  tags: UnitTag[];
  cost: number;
  hp: number;
  /** 지상 목표 공격력 (0이면 지상 공격 불가) */
  attack: number;
  /** 공중 목표 공격력 (0이면 공중 공격 불가) */
  airAttack: number;
  /** 지상 유닛의 사거리: 1=최근접 열, 2=+차열, 3=전 열. 공중 유닛은 무시 */
  reach: number;
  /** 정찰 점수 기여(유닛 1기당) */
  reconValue: number;
  /** 목표 태그별 피해 배수 */
  counters: Partial<Record<UnitTag, number>>;
  /**
   * 화면이 처음 제안하는 배치 열(D-045). **시뮬레이션에 들어가지 않는다** —
   * 전투 입력의 열은 언제나 `StackOrder.row`이므로 이 값은 결과·해시에 영향이 없다.
   * 여기 두는 이유는 클라이언트가 병종별 기본 열 표를 따로 갖지 않게 하기 위해서다.
   */
  defaultRow?: Row;
  /** 광역 공격(열 단위 피해 분산) */
  area?: boolean;
  /** 보급 보정(유닛 1기당, 상한은 밸런스 상수) */
  supplyValue?: number;
}

export interface DoctrineDef {
  id: DoctrineId;
  nameKo: string;
  attackMult?: Partial<Record<UnitTag, number>>;
  attackMultAll?: number;
  incomingMultAll?: number;
  /** 특정 태그 유닛으로부터 받는 피해 배수 */
  incomingFromTag?: Partial<Record<UnitTag, number>>;
  supplyBonus?: number;
  reconBonus?: number;
}

export interface BalanceConfig {
  maxRounds: number;
  /** 피해 난수 범위: [min, min+span] 배수 */
  varianceMin: number;
  varianceSpan: number;
  /** 손실 중 부상 비율(나머지는 전사) — D-005 회복 가능한 패배 */
  woundedRatio: number;
  /** 보급 0일 때의 공격 배수 하한: mult = floor + (1-floor)*supply */
  supplyFloor: number;
  /** 선제·정보 우위로 인정하는 정찰 점수 차 */
  infoAdvantageGap: number;
  /** 선제권 측의 피해 보너스(전투는 동시 해결이므로 순서가 아닌 배수로 반영) */
  initiativeBonus: number;
  /** 장교 정보 능력치 1당 정찰 점수 */
  intelWeight: number;
  /** 정찰 정확도(0..1)의 정찰 점수 환산 배수 */
  reconAccuracyWeight: number;
  /** 장교 지휘 1당 공격 보정 */
  commandWeight: number;
  /** 장교 전술 1당 상성 보정 */
  tacticsWeight: number;
  /** 장교 군수 1당 보급 보정 */
  logisticsWeight: number;
  /** 밀집 판정 기준(같은 열의 유닛 수)과 포병 보너스 */
  denseRowUnits: number;
  denseBonus: number;
  /** 수송대 등 보급 유닛의 보정 상한 */
  supplyUnitCap: number;
  /** 스택당 최대 수량, 진영당 최대 스택 수 */
  maxStackCount: number;
  maxStacks: number;
}

export interface Ruleset {
  version: string;
  units: Record<string, UnitDef>;
  doctrines: Record<DoctrineId, DoctrineDef>;
  balance: BalanceConfig;
}

export interface OfficerSnapshot {
  name: string;
  /** 지휘: 부대 공격력 */
  command: number;
  /** 전술: 상성 효과 증폭 */
  tactics: number;
  /** 행정: 전투 외 효율(PoC 미사용) */
  admin: number;
  /** 정보: 정찰 점수 */
  intel: number;
  /** 군수: 보급 페널티 완화 */
  logistics: number;
}

export interface StackOrder {
  unitId: string;
  count: number;
  row: Row;
  /** 이 라운드부터 참전(기본 1 = 즉시). 예비대 지정용 */
  reserveRound?: number;
}

export interface ArmySnapshot {
  stacks: StackOrder[];
  officer?: OfficerSnapshot;
  doctrine: DoctrineId;
  /** 보급 수준 0..1 */
  supply: number;
  /** 사전 정찰 정확도 0..1 */
  reconAccuracy: number;
  /** 잔존 전투력 비율이 이 값 미만이면 철수. 0..0.9 */
  retreatThreshold: number;
  /**
   * 태그별 공격 배수 가산(D-044). 연구 등 교리 밖의 영구 보정을 넣는 자리다.
   * 생략하면 보정이 없다 — 이 항목이 없던 저장 입력은 도입 전과 완전히 같은 결과를 낸다.
   */
  attackMultByTag?: Partial<Record<UnitTag, number>>;
}

export interface BattleInput {
  ruleVersion: string;
  /** 0 이상 2^32-1 이하 정수 */
  seed: number;
  attacker: ArmySnapshot;
  defender: ArmySnapshot;
}

export type Side = 'attacker' | 'defender';

export interface AttackEvent {
  round: number;
  side: Side;
  unitId: string;
  targetUnitId: string;
  damage: number;
  counterMult: number;
}

export interface StackReport {
  unitId: string;
  nameKo: string;
  row: Row;
  initial: number;
  survivors: number;
  dead: number;
  wounded: number;
  damageDealt: number;
  damageTaken: number;
}

export interface CounterReport {
  side: Side;
  unitId: string;
  targetUnitId: string;
  multiplier: number;
  totalDamage: number;
}

export interface SideReport {
  stacks: StackReport[];
  reconScore: number;
  infoAdvantage: boolean;
  effectiveSupply: number;
  attackMultiplier: number;
  /** 잔존 전투력 비율 0..1 */
  remainingRatio: number;
  totalCost: number;
}

export type BattleOutcome = 'attacker_win' | 'defender_win' | 'draw';
export type OutcomeReason = 'annihilation' | 'retreat' | 'timeout' | 'mutual_retreat';

export interface BattleResult {
  ruleVersion: string;
  seed: number;
  outcome: BattleOutcome;
  reason: OutcomeReason;
  rounds: number;
  initiative: Side | null;
  attacker: SideReport;
  defender: SideReport;
  counters: CounterReport[];
  events: AttackEvent[];
  /** 재현 검증용 결과 해시(FNV-1a 64) */
  hash: string;
}

export type BattleFindingCode =
  | 'BATTLE_STALEMATE'
  | 'COUNTER_VULNERABILITY'
  | 'ATTRITION_DEFEAT';

export type BattleRecommendationCode =
  | 'BREAK_STALEMATE'
  | 'COUNTER_DECISIVE_UNIT'
  | 'ADD_COUNTER_COVERAGE';

export interface BattleFinding {
  readonly code: BattleFindingCode;
  readonly side: Side | null;
  readonly messageKo: string;
}

export interface BattleRecommendation {
  readonly code: BattleRecommendationCode;
  readonly side: Side | null;
  readonly messageKo: string;
}

export interface BattleCounterFact {
  readonly side: Side;
  readonly unitId: string;
  readonly unitNameKo: string;
  readonly targetUnitId: string;
  readonly targetUnitNameKo: string;
  readonly multiplier: number;
  readonly totalDamage: number;
}

export interface BattleCasualtyFact {
  readonly side: Side;
  readonly initial: number;
  readonly survivors: number;
  readonly wounded: number;
  readonly dead: number;
  readonly losses: number;
  /** 초기 병력 대비 전사+부상 비율. 소수점 셋째 자리까지 고정한다. */
  readonly lossRate: number;
}

/** 영속 보고서와 UI가 공통으로 소비할 수 있는 구조화 전투 분석 계약. */
export interface BattleAnalysis {
  readonly ruleVersion: string;
  readonly resultHash: string;
  readonly outcome: BattleOutcome;
  readonly losingSide: Side | null;
  readonly casualties: Readonly<Record<Side, BattleCasualtyFact>>;
  /** 누적 상성 피해 기준 상위 3개. 동률이면 코드 단위 순서로 고정한다. */
  readonly keyCounters: readonly BattleCounterFact[];
  readonly issues: readonly BattleFinding[];
  readonly recommendations: readonly BattleRecommendation[];
}

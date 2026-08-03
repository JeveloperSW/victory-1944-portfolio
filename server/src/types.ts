import type {
  BattleAnalysis,
  BattleResult,
  BuildingId,
  DoctrineId,
  EconomyUnitId,
  PartialBundle,
  ResourceBundle,
  ResourceId,
  Row,
  StackOrder,
} from '../../engine/src/index.js';

export const CONSTRUCTION_WORKER_ID = 'system:construction-worker';

/**
 * claim 주체(워커 인스턴스) ID 접두. 인증 계층 도입 전까지의 PoC 역할 구분이다.
 * 완료 명령의 권위 주체는 여전히 CONSTRUCTION_WORKER_ID이며 claim은 중복 작업 방지 장치다.
 */
export const WORKER_ID_PREFIX = 'worker:';

export interface CommandContext {
  /** 인증 계층이 확정한 주체이며 클라이언트 payload에서 읽지 않는다. */
  readonly actorId: string;
  /** 권위 서버 시각을 정수 시간으로 변환한 값이다. */
  readonly nowHour: number;
}

export interface StartConstructionCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly buildingId: BuildingId;
}

export interface CompleteConstructionCommand {
  readonly commandId: string;
  readonly jobId: string;
}

export interface StartConstructionResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly jobId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly startedAtHour: number;
  readonly completesAtHour: number;
  readonly cost: Readonly<PartialBundle>;
  readonly ruleVersion: string;
}

export interface CompleteConstructionResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly jobId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly effectiveAtHour: number;
  readonly processedAtHour: number;
  readonly ruleVersion: string;
}

export interface CommandExecution<TResponse> {
  readonly response: TResponse;
  /** 저장 receipt 또는 이미 적용된 job effect를 반환했으면 true다. */
  readonly replayed: boolean;
}

export interface SeedCityInput {
  readonly cityId: string;
  readonly ownerId: string;
  readonly ruleVersion?: string;
  readonly campaignRuleVersion?: string;
  readonly resources?: Readonly<Partial<ResourceBundle>>;
  readonly buildings?: Readonly<Partial<Record<BuildingId, number>>>;
  readonly version?: number;
  readonly lastServerHour?: number;
}

export interface ConstructionJobSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly ruleVersion: string;
  readonly startedAtHour: number;
  readonly completesAtHour: number;
  readonly effectiveAtHour: number | null;
  readonly processedAtHour: number | null;
  readonly status: 'pending' | 'completed';
}

export interface LedgerSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly resourceId: ResourceId;
  readonly reason: 'construction_start';
  readonly deltaMicro: number;
  readonly balanceBeforeMicro: number;
  readonly balanceAfterMicro: number;
  readonly createdAtHour: number;
}

export interface ReceiptSnapshot {
  readonly actorId: string;
  readonly commandId: string;
  readonly cityId: string;
  readonly commandKind: 'start_construction' | 'complete_construction';
  readonly payloadSha256: string;
  readonly payloadJson: string;
  readonly responseJson: string;
  readonly createdAtHour: number;
}

export interface CitySnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
  readonly version: number;
  readonly lastServerHour: number;
  readonly resourcesMicro: Readonly<Record<ResourceId, number>>;
  readonly buildings: Readonly<Record<BuildingId, number>>;
  readonly jobs: readonly ConstructionJobSnapshot[];
  readonly ledger: readonly LedgerSnapshot[];
  readonly receipts: readonly ReceiptSnapshot[];
  readonly completionEffectCount: number;
}

export interface UnitQuantity {
  readonly unitId: EconomyUnitId;
  readonly count: number;
}

export type ArmyInventorySnapshot = Readonly<Record<EconomyUnitId, number>>;

export interface ArmyStateSnapshot {
  readonly ready: ArmyInventorySnapshot;
  readonly wounded: ArmyInventorySnapshot;
  readonly dead: ArmyInventorySnapshot;
}

/**
 * 예약된 부상병 회복 1건(D-045).
 * 보급품은 예약 시 이미 지불했으므로 완료는 자원을 옮기지 않는다.
 */
export interface RecoveryJobSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly unitId: EconomyUnitId;
  readonly count: number;
  readonly startedAtHour: number;
  readonly completesAtHour: number;
  readonly status: 'pending' | 'completed';
}

export interface RecoverUnitsCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly units: readonly UnitQuantity[];
}

export interface RecoverUnitsResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly units: readonly UnitQuantity[];
  readonly cost: Readonly<PartialBundle>;
  readonly completesAtHour: number;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

/**
 * 회복 비용 안내(D-045). 비용은 `ceil(전투가치 합 × rate)`이라 병종별 단가로 나누어 떨어지지 않는다.
 * 화면이 올림을 흉내 내지 않도록 병종별 전투가치와 비율을 그대로 준다.
 */
export interface RecoveryInfoSnapshot {
  readonly hours: number;
  readonly suppliesRate: number;
  readonly unitValues: Readonly<Partial<Record<EconomyUnitId, number>>>;
}

/**
 * 시간당 생산 정산(D-045).
 * `fromHour` 다음 시간부터 `toHour`까지를 한 번에 정산한다. commandId는 두 값으로 결정되므로
 * 같은 구간을 두 번 정산하면 영수증 재생이 된다.
 */
export interface CreditProductionCommand {
  readonly cityId: string;
  readonly toHour: number;
}

export interface CreditProductionResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly fromHour: number;
  readonly toHour: number;
  readonly credited: Readonly<PartialBundle>;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

/**
 * 도시 이름 변경(D-054).
 * 이름은 서버가 보관하는 권위 상태이며, 정규화·검증도 서버가 한다.
 */
export interface RenameCityCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly name: string;
}

export interface RenameCityResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  /** 서버가 정규화한 최종 이름. 클라이언트가 보낸 것과 다를 수 있다. */
  readonly name: string;
}

export interface CompleteRecoveryCommand {
  readonly jobId: string;
}

export interface CompleteRecoveryResponse {
  readonly jobId: string;
  readonly cityId: string;
  readonly unitId: EconomyUnitId;
  readonly count: number;
  readonly effectiveAtHour: number;
}

export interface MobilizeUnitsCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly units: readonly UnitQuantity[];
}

export interface MobilizeUnitsResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly units: readonly UnitQuantity[];
  readonly cost: Readonly<PartialBundle>;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

export interface ReconNpcCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly scenarioId: string;
}

export interface ReconThreatEstimate {
  readonly unitId: EconomyUnitId;
  readonly row: Row;
  readonly minimum: number;
  readonly maximum: number;
}

export interface ReconReportSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly scenarioId: string;
  readonly scenarioNameKo: string;
  readonly campaignRuleVersion: string;
  readonly scoutCount: number;
  readonly accuracy: number;
  readonly createdAtHour: number;
  readonly expiresAtHour: number;
  /**
   * 보고서를 만든 시점의 레이더 레벨(D-043).
   * 정확도 재검증에 쓴다 — 현재 레벨로 다시 계산하면 레이더를 올린 뒤 옛 보고서가 깨진다.
   * 레이더 도입 전 보고서에는 저장되어 있지 않으며 그 경우 0으로 읽는다.
   */
  readonly radarLevel: number;
  /**
   * 보고서를 만든 시점의 연구 정찰 보정(permille, D-044).
   * 레이더와 같은 이유로 저장한다 — 연구가 올라도 옛 보고서 재검증이 흔들리지 않는다.
   * 도입 전 보고서에는 없으며 그 경우 0으로 읽는다.
   */
  readonly researchReconPermille: number;
  readonly threats: readonly ReconThreatEstimate[];
}

export interface ReconNpcResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly cost: Readonly<PartialBundle>;
  readonly report: ReconReportSnapshot;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

export interface AttackNpcCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly scenarioId: string;
  readonly deployment: readonly StackOrder[];
  readonly doctrine: DoctrineId;
}

export interface UnitCasualtySnapshot {
  readonly unitId: EconomyUnitId;
  readonly deployed: number;
  readonly survivors: number;
  readonly wounded: number;
  readonly dead: number;
}

export interface NpcBattleReportSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly scenarioId: string;
  readonly scenarioNameKo: string;
  readonly campaignRuleVersion: string;
  readonly seed: number;
  readonly createdAtHour: number;
  readonly reconReportId: string;
  readonly sortieCost: Readonly<PartialBundle>;
  readonly reward: Readonly<PartialBundle>;
  readonly casualties: readonly UnitCasualtySnapshot[];
  readonly result: BattleResult;
  readonly analysis: BattleAnalysis;
  /**
   * 이 전투에 쓴 교리(D-042).
   * 저장된 보고서 JSON이 아니라 전투 입력에서 꺼낸 파생 항목이다 — 저장 형태는 그대로다.
   */
  readonly doctrine: DoctrineId;
  readonly doctrineNameKo: string;
}

/**
 * DB에 실제로 저장되는 전투 보고서의 정확한 형태.
 * **여기에 항목을 더하면 기존 기록의 canonical 검증이 깨진다** —
 * 파생 항목은 `NpcBattleReportSnapshot`에만 두고 읽을 때 붙인다.
 */
export type StoredNpcBattleReport = Omit<
  NpcBattleReportSnapshot,
  'doctrine' | 'doctrineNameKo'
>;

export interface AttackNpcResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly report: NpcBattleReportSnapshot;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

export type OperationCommandKind =
  | 'mobilize_units' | 'recon_npc' | 'attack_npc' | 'advance_research' | 'recover_units'
  | 'credit_production' | 'rename_city';
export type OperationLedgerReason =
  | 'mobilization' | 'recon' | 'sortie' | 'victory_reward' | 'research' | 'recovery' | 'production';

export interface OperationLedgerSnapshot {
  readonly id: string;
  readonly cityId: string;
  readonly commandId: string;
  readonly resourceId: ResourceId;
  readonly reason: OperationLedgerReason;
  readonly deltaMicro: number;
  readonly balanceBeforeMicro: number;
  readonly balanceAfterMicro: number;
  readonly createdAtHour: number;
}

export interface OperationReceiptSnapshot {
  readonly actorId: string;
  readonly commandId: string;
  readonly cityId: string;
  readonly commandKind: OperationCommandKind;
  readonly payloadSha256: string;
  readonly payloadJson: string;
  readonly responseJson: string;
  readonly createdAtHour: number;
}

export interface OperationSnapshot {
  readonly cityId: string;
  /** 플레이어가 정한 도시 이름(D-054). */
  readonly name: string;
  readonly ownerId: string;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
  readonly version: number;
  readonly lastServerHour: number;
  readonly resourcesMicro: Readonly<Record<ResourceId, number>>;
  readonly buildings: Readonly<Record<BuildingId, number>>;
  readonly jobs: readonly ConstructionJobSnapshot[];
  readonly army: ArmyStateSnapshot;
  /** 진행 중인 회복 예약(D-045). 완료된 것은 담지 않는다. */
  readonly recoveries: readonly RecoveryJobSnapshot[];
  /** 현재 건물 기준 시간당 생산량(D-045). 화면이 생산식을 복제하지 않게 서버가 계산한다. */
  readonly productionPerHour: Readonly<PartialBundle>;
  /** 부상병 1기당 회복 보급품 비용과 소요 시간. 화면이 규칙을 복제하지 않게 서버가 준다. */
  readonly recoveryInfo: RecoveryInfoSnapshot;
  readonly latestRecon: ReconReportSnapshot | null;
  readonly battleReports: readonly NpcBattleReportSnapshot[];
  readonly scenarios: readonly ScenarioSnapshot[];
  readonly doctrines: readonly DoctrineSnapshot[];
  readonly units: readonly UnitSnapshot[];
  readonly buildingInfo: readonly BuildingInfoSnapshot[];
  readonly research: readonly ResearchSnapshot[];
  readonly ledger: readonly OperationLedgerSnapshot[];
  readonly receipts: readonly OperationReceiptSnapshot[];
}

/**
 * 화면에 보여줄 NPC 시나리오(D-040).
 * 해금·격파는 서버가 판정한 결과이며 클라이언트는 표시만 한다.
 * 방어 편성은 담지 않는다 — 적 규모를 아는 수단은 정찰이다.
 */
/**
 * 선택 가능한 전투 교리(D-041).
 * `effectsKo`는 규칙 수치에서 생성한 설명이며 서버가 만든다 — 클라이언트가 배수를 복제하지 않는다.
 */
export interface DoctrineSnapshot {
  readonly id: string;
  readonly nameKo: string;
  readonly effectsKo: readonly string[];
}

/**
 * 동원 가능한 병종(D-043).
 * 훈련 비용·해금 조건을 서버가 판정해 내려준다. 화면은 표시만 한다.
 */
/**
 * 건물별 증설 정보(D-043).
 * `blockedReason`은 서버 오류 코드와 같은 값이다(MAX_LEVEL·BUILD_SLOT_FULL 등).
 * `inertReasonKo`는 사양의 건물이지만 그 시스템이 미구현이라 효과가 없다는 뜻이다.
 */
export interface BuildingInfoSnapshot {
  readonly buildingId: BuildingId;
  readonly nameKo: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly nextLevel: number | null;
  readonly nextCost: Readonly<PartialBundle>;
  readonly nextHours: number;
  readonly blockedReason: string | null;
  readonly inertReasonKo: string | null;
}

/**
 * 연구 항목의 현재 상태(D-044).
 * 다음 단계 비용·가능 여부를 서버가 판정해 내려준다. 화면은 표시만 한다.
 */
export interface ResearchSnapshot {
  readonly researchId: string;
  readonly nameKo: string;
  readonly categoryKo: string;
  readonly descriptionKo: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly nextLevel: number | null;
  readonly nextScripCost: number;
  /** 단계당 효과를 규칙 수치에서 만든 문구. 손으로 적지 않는다. */
  readonly effectKo: string;
  /** 현재까지 누적된 효과 문구. 0단계면 빈 문자열이다. */
  readonly currentEffectKo: string;
  readonly blockedReason: string | null;
  readonly requiresLabLevel: number;
  readonly requiresResearchId: string | null;
  readonly requiresResearchNameKo: string | null;
}

export interface AdvanceResearchCommand {
  readonly commandId: string;
  readonly cityId: string;
  readonly expectedVersion: number;
  readonly researchId: string;
  /** 올릴 목표 단계. 현재 단계 + 1이어야 한다(한 단계씩 올린다). */
  readonly targetLevel: number;
}

export interface AdvanceResearchResponse {
  readonly cityId: string;
  readonly cityVersion: number;
  readonly researchId: string;
  readonly level: number;
  readonly cost: Readonly<PartialBundle>;
  readonly ruleVersion: string;
  readonly campaignRuleVersion: string;
}

export interface UnitSnapshot {
  readonly unitId: EconomyUnitId;
  readonly nameKo: string;
  readonly trainCost: Readonly<PartialBundle>;
  readonly upkeepFoodPerHour: number;
  readonly unlocked: boolean;
  readonly requiresBuildingId: BuildingId | null;
  readonly requiresBuildingNameKo: string | null;
  readonly requiresLevel: number | null;
  /**
   * 배치 열 선택에 필요한 규칙 값(D-045).
   * 화면이 병종별 기본 열 표나 사거리 설명을 따로 갖지 않게 서버가 규칙에서 만들어 준다.
   */
  readonly defaultRow: Row;
  readonly rowHintKo: string;
}

export interface ScenarioSnapshot {
  readonly id: string;
  readonly nameKo: string;
  readonly briefKo: string;
  readonly tier: number;
  readonly victoryReward: Readonly<PartialBundle>;
  readonly cleared: boolean;
  readonly unlocked: boolean;
  readonly requiresScenarioId: string | null;
  readonly requiresNameKo: string | null;
}

export type FaultPoint =
  | 'start:after_first_debit'
  | 'start:after_ledger'
  | 'start:after_job'
  | 'start:after_version'
  | 'start:after_receipt'
  | 'complete:after_building'
  | 'complete:after_job'
  | 'complete:after_effect'
  | 'complete:after_version'
  | 'complete:after_claim_delete'
  | 'complete:after_receipt'
  | 'claim:after_dead_letter'
  | 'claim:after_upsert'
  | 'mobilize:after_ledger'
  | 'mobilize:after_first_debit'
  | 'mobilize:after_army'
  | 'mobilize:after_version'
  | 'mobilize:after_receipt'
  | 'recon:after_ledger'
  | 'recon:after_first_debit'
  | 'recon:after_report'
  | 'recon:after_version'
  | 'recon:after_receipt'
  | 'battle:after_ledger'
  | 'battle:after_first_debit'
  | 'battle:after_army'
  | 'battle:before_reward'
  | 'battle:after_report'
  | 'battle:after_version'
  | 'battle:after_receipt';

export interface JobDispatchPolicy {
  /** 이 횟수의 시도가 모두 소진되면 dead letter로 전환한다. 1..100, 기본 5 */
  readonly maxAttempts?: number;
  /** claim 시 부여하는 lease 길이(시간). 1..168, 기본 1 */
  readonly defaultLeaseHours?: number;
  /** 실패 백오프 상한(시간). 백오프 = min(상한, 2^(시도-1)). 1..720, 기본 24 */
  readonly maxBackoffHours?: number;
}

export interface ConstructionServerOptions {
  readonly busyTimeoutMs?: number;
  readonly jobPolicy?: JobDispatchPolicy;
  /** 서버 권위 전투 seed(uint32) 생성기. 테스트 외에는 CSPRNG 기본값을 사용한다. */
  readonly seedGenerator?: () => number;
  /** 통합 테스트가 트랜잭션 중간 예외를 강제하기 위한 hook이다. */
  readonly faultInjector?: (point: FaultPoint) => void;
}

export interface ClaimDueJobsCommand {
  /** 한 번의 스캔에서 검토할 최대 due job 수. 1..100 */
  readonly limit: number;
  /** 이번 claim의 lease 길이(시간). 생략 시 정책 기본값 */
  readonly leaseHours?: number;
}

export interface ClaimedJob {
  readonly jobId: string;
  readonly cityId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly ruleVersion: string;
  readonly completesAtHour: number;
  readonly attempt: number;
  readonly leaseUntilHour: number;
}

export interface ClaimDueJobsResult {
  readonly claimed: readonly ClaimedJob[];
  /** 이번 스캔에서 최대 시도 소진으로 dead letter로 전환된 job ID */
  readonly deadLettered: readonly string[];
}

export interface FailClaimedJobCommand {
  readonly jobId: string;
  /** 실패 사유(1..200자). 원문 그대로 last_error에 보존한다. */
  readonly error: string;
}

export interface FailClaimedJobResult {
  readonly jobId: string;
  readonly state: 'retry_scheduled' | 'dead';
  readonly attempt: number;
  /** retry_scheduled일 때 재claim 가능 시각, dead면 null */
  readonly nextEligibleHour: number | null;
}

export interface ReleaseClaimCommand {
  readonly jobId: string;
}

export interface ReleaseClaimResult {
  readonly jobId: string;
  /** claim이 이미 없으면(완료 등) false */
  readonly released: boolean;
}

export interface JobClaimSnapshot {
  readonly jobId: string;
  readonly workerId: string;
  readonly state: 'leased' | 'dead';
  readonly attemptCount: number;
  readonly claimedAtHour: number;
  readonly leaseUntilHour: number;
  readonly lastError: string | null;
}

/** 운영 조치 주체 접두. 감사 대상이며 requeue·토큰 발급 권한을 가진다. */
export const ADMIN_ID_PREFIX = 'admin:';

export interface RequeueDeadJobCommand {
  readonly jobId: string;
  /** 감사 기록에 남는 조치 사유(1..200자) */
  readonly reason: string;
}

export interface RequeueDeadJobResult {
  readonly jobId: string;
  /** 재가동 전 dead claim의 누적 시도 수 */
  readonly priorAttempts: number;
  /** 다음 스캔부터 attempt 1로 재claim 가능 */
  readonly requeued: true;
}

/** dead letter 운영 조회: claim + job 문맥 */
export interface DeadJobSnapshot extends JobClaimSnapshot {
  readonly cityId: string;
  readonly buildingId: BuildingId;
  readonly targetLevel: number;
  readonly completesAtHour: number;
}

export type AdminActionKind = 'requeue_dead_job' | 'issue_token' | 'revoke_token';

export interface AdminActionSnapshot {
  readonly id: number;
  readonly actorId: string;
  readonly action: AdminActionKind;
  readonly target: string;
  readonly reason: string;
  readonly atHour: number;
  readonly priorState: string | null;
}

export type TokenRole = 'player' | 'admin' | 'worker';

export interface IssueTokenCommand {
  readonly actorId: string;
  readonly role: TokenRole;
  readonly reason: string;
}

export interface IssueTokenResult {
  /** 토큰 원문 — 이 응답에서만 반환되고 저장되지 않는다. */
  readonly token: string;
  readonly tokenSha256: string;
  readonly actorId: string;
  readonly role: TokenRole;
}

/**
 * 기기 계정 세션(D-039).
 * `token`은 이 응답에서만 반환되고 DB에는 sha256만 남는다.
 * `created`는 이번 호출로 계정이 새로 만들어졌는지다(재로그인이면 false).
 */
export interface DeviceSessionResult {
  readonly actorId: string;
  readonly cityId: string;
  readonly token: string;
  readonly created: boolean;
}

export interface AccountSnapshot {
  readonly actorId: string;
  readonly cityId: string;
  readonly createdAtHour: number;
}

export interface DeleteAccountResult {
  readonly actorId: string;
  readonly cityId: string;
  readonly deleted: true;
}

export interface RevokeTokenCommand {
  readonly tokenSha256: string;
  readonly reason: string;
}

export interface RevokeTokenResult {
  readonly tokenSha256: string;
  readonly revoked: true;
}

/** HTTP 계층이 토큰에서 유도하는 인증 주체. payload의 주체 주장은 절대 믿지 않는다. */
export interface AuthenticatedActor {
  readonly actorId: string;
  readonly role: TokenRole;
  readonly tokenSha256: string;
}

/** 첫 루프 계측(schema v6). 열거값만 저장하며 개인정보를 받지 않는다. */
export const CLIENT_EVENT_NAMES = [
  'session_start', 'screen_view', 'command_attempt', 'command_success', 'command_rejected', 'report_view',
] as const;
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export const CLIENT_EVENT_SUBJECTS = [
  'city', 'operations', 'reports', 'connect', 'build', 'mobilize', 'recon', 'attack',
] as const;
export type ClientEventSubject = (typeof CLIENT_EVENT_SUBJECTS)[number];

export interface ClientEventInput {
  /** 클라이언트 생성 ID. 같은 ID 재전송은 한 번만 저장된다. */
  readonly id: string;
  readonly sessionId: string;
  readonly name: ClientEventName;
  readonly subject?: ClientEventSubject;
  /** 거부 사유 등 대문자·밑줄 코드. 자유 텍스트를 넣지 않는다. */
  readonly outcome?: string;
  /** 세션 내 단조 증가 순서. 클라이언트 시각은 신뢰하지 않으므로 순서만 쓴다. */
  readonly clientSeq: number;
}

export interface RecordEventsResult {
  readonly received: number;
  /** 중복 ID를 제외하고 실제로 저장된 수 */
  readonly stored: number;
}

export interface FunnelRow {
  readonly name: ClientEventName;
  readonly subject: ClientEventSubject | null;
  readonly outcome: string | null;
  readonly events: number;
  readonly sessions: number;
}

import { createHash, randomBytes } from 'node:crypto';
import {
  BUILDING_IDS,
  buildingDef,
  cityBuildingIds,
  CAMPAIGN_RULESETS,
  ECONOMY_RULESETS,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
  RULESETS,
  UNIT_TAG_LABELS_KO,
  analyzeBattle,
  constructionCost,
  constructionHours,
  hourlyProduction,
  npcSortieCost,
  simulateBattle,
  stableStringify,
} from '../../engine/src/index.js';
import type {
  BattleInput,
  BuildingId,
  CampaignRuleset,
  DoctrineId,
  EconomyRuleset,
  DoctrineDef,
  EconomyUnitId,
  NpcScenario,
  PartialBundle,
  ResearchDef,
  ResourceId,
  Row,
  StackOrder,
  UnitDef,
  UnitTag,
  UnitUnlockDef,
} from '../../engine/src/index.js';
import type { SqlAdapter, SqlExecutor } from './db/adapter.js';
import { ServerError } from './errors.js';
import type {
  ArmyInventorySnapshot,
  ArmyStateSnapshot,
  AttackNpcCommand,
  AttackNpcResponse,
  CommandContext,
  CommandExecution,
  ConstructionJobSnapshot,
  ConstructionServerOptions,
  MobilizeUnitsCommand,
  MobilizeUnitsResponse,
  NpcBattleReportSnapshot,
  OperationCommandKind,
  OperationLedgerReason,
  OperationLedgerSnapshot,
  DoctrineSnapshot,
  BuildingInfoSnapshot,
  ResearchSnapshot,
  AdvanceResearchCommand,
  AdvanceResearchResponse,
  RecoverUnitsCommand,
  RecoverUnitsResponse,
  CreditProductionCommand,
  CreditProductionResponse,
  RenameCityCommand,
  RenameCityResponse,
  CompleteRecoveryCommand,
  CompleteRecoveryResponse,
  RecoveryJobSnapshot,
  RecoveryInfoSnapshot,
  ScenarioSnapshot,
  UnitSnapshot,
  StoredNpcBattleReport,
  OperationReceiptSnapshot,
  OperationSnapshot,
  ReconNpcCommand,
  ReconNpcResponse,
  ReconReportSnapshot,
  ReconThreatEstimate,
  UnitCasualtySnapshot,
  UnitQuantity,
} from './types.js';

const SCALE = 1000;
const MAX_CITY_VERSION = 2_147_483_647;
const MAX_CITY_HOUR = 10_000_000;
const MAX_UNIT_COUNT = 100_000;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROWS: readonly Row[] = ['front', 'mid', 'back'];
/**
 * 작전 원장이 허용하는 reason. **여기 한 곳에서만 정의한다** —
 * D-044에서 이 목록이 코드 두 곳에 하드코딩돼 있어 새 reason이 조용히 거부됐다.
 */
const OPERATION_LEDGER_REASONS: readonly string[] = Object.freeze([
  'mobilization', 'recon', 'sortie', 'victory_reward', 'research', 'recovery', 'production',
]);
/** 자원을 넣는 reason. 나머지는 빼는 reason이다. 부호 검증이 이 목록을 쓴다. */
const CREDIT_LEDGER_REASONS: readonly string[] = Object.freeze(['victory_reward', 'production']);
const RECON_COST: Readonly<PartialBundle> = Object.freeze({ oil: 5, supplies: 10 });
const RECON_VALID_HOURS = 6;

interface CityRow {
  id: string;
  owner_id: string;
  rule_version: string;
  campaign_rule_version: string;
  version: number;
  last_server_hour: number;
  /** 마지막으로 생산을 정산한 시각(D-045). NULL이면 아직 정산한 적이 없다. */
  last_production_hour: number | null;
  /** 플레이어가 정한 도시 이름(D-054). */
  name: string;
}

interface ResourceRow {
  resource_id: string;
  balance_micro: number;
}

interface BuildingRow {
  building_id: string;
  level: number;
}

interface ArmyRow {
  unit_id: string;
  ready: number;
  wounded: number;
  dead: number;
}

interface ConstructionJobRow {
  id: string;
  city_id: string;
  building_id: string;
  target_level: number;
  rule_version: string;
  started_at_hour: number;
  completes_at_hour: number;
  effective_at_hour: number | null;
  processed_at_hour: number | null;
  status: 'pending' | 'completed';
}

interface RecoveryJobRow {
  id: string;
  city_id: string;
  command_id: string;
  unit_id: string;
  count: number;
  started_at_hour: number;
  completes_at_hour: number;
  status: 'pending' | 'completed';
  completed_at_hour: number | null;
  completed_city_version: number | null;
}

interface OperationReceiptRow {
  actor_id: string;
  command_id: string;
  city_id: string;
  command_kind: OperationCommandKind;
  payload_sha256: string;
  payload_json: string;
  response_json: string;
  created_at_hour: number;
}

interface OperationLedgerRow {
  id: string;
  city_id: string;
  command_id: string;
  resource_id: string;
  reason: OperationLedgerReason;
  delta_micro: number;
  balance_before_micro: number;
  balance_after_micro: number;
  created_at_hour: number;
}

interface ConstructionLedgerHistoryRow {
  id: string;
  city_id: string;
  command_id: string;
  job_id: string;
  resource_id: string;
  reason: 'construction_start';
  delta_micro: number;
  balance_before_micro: number;
  balance_after_micro: number;
  created_at_hour: number;
}

interface ConstructionReceiptHistoryRow {
  actor_id: string;
  command_id: string;
  city_id: string;
  command_kind: 'start_construction';
  payload_sha256: string;
  payload_json: string;
  response_json: string;
  created_at_hour: number;
}

interface ReconReportRow {
  id: string;
  city_id: string;
  command_id: string;
  scenario_id: string;
  accuracy_permille: number;
  created_at_hour: number;
  expires_at_hour: number;
  report_json: string;
}

interface BattleReportRow {
  id: string;
  city_id: string;
  command_id: string;
  scenario_id: string;
  recon_report_id: string;
  seed: number;
  result_hash: string;
  input_json: string;
  report_json: string;
  created_at_hour: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ServerError('INVALID_INPUT', `${label}에 허용되지 않은 필드가 있다.`);
  }
}

/**
 * 저장 형태의 키 집합을 정확히 검증한다.
 *
 * `optional`은 확장 전용 항목이다 — 나중에 추가한 항목이 옛 기록에는 없으므로
 * 있어도 되고 없어도 되지만, 그 밖의 키는 하나도 허용하지 않는다.
 */
function assertStoredExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const optionalSet = new Set(optional);
  const actual = Object.keys(value).filter((key) => !optionalSet.has(key)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ServerError('DATA_INTEGRITY', `${label} 저장 스키마가 다르다.`);
  }
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ServerError('INVALID_ID', `${label}은 영문·숫자·콜론·밑줄·대시 1..64자여야 한다.`);
  }
  return value;
}

function validateInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ServerError('INVALID_INPUT', `${label}은 ${minimum}..${maximum} 안전한 정수여야 한다.`);
  }
  return value as number;
}

function validateContext(value: unknown): CommandContext {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '명령 context는 객체여야 한다.');
  assertExactKeys(value, ['actorId', 'nowHour'], 'context');
  return {
    actorId: validateId(value.actorId, 'actorId'),
    nowHour: validateInteger(value.nowHour, 'nowHour', 0, MAX_CITY_HOUR),
  };
}

function normalizeUnitQuantities(value: unknown): readonly UnitQuantity[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ECONOMY_UNIT_IDS.length) {
    throw new ServerError('INVALID_INPUT', `units는 1..${ECONOMY_UNIT_IDS.length}개 배열이어야 한다.`);
  }
  const byUnit = new Map<EconomyUnitId, number>();
  for (const entry of value) {
    if (!isPlainRecord(entry)) throw new ServerError('INVALID_INPUT', 'units 항목은 객체여야 한다.');
    assertExactKeys(entry, ['unitId', 'count'], 'units 항목');
    if (typeof entry.unitId !== 'string'
      || !ECONOMY_UNIT_IDS.includes(entry.unitId as EconomyUnitId)) {
      throw new ServerError('UNKNOWN_UNIT', `알 수 없는 병종: ${String(entry.unitId)}`);
    }
    const unitId = entry.unitId as EconomyUnitId;
    if (byUnit.has(unitId)) {
      throw new ServerError('INVALID_INPUT', `병종이 중복됐다: ${unitId}`);
    }
    byUnit.set(unitId, validateInteger(entry.count, `${unitId}.count`, 1, MAX_UNIT_COUNT));
  }
  return ECONOMY_UNIT_IDS
    .filter((unitId) => byUnit.has(unitId))
    .map((unitId) => ({ unitId, count: byUnit.get(unitId)! }));
}

function validateMobilizeCommand(value: unknown): MobilizeUnitsCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '동원 명령은 객체여야 한다.');
  assertExactKeys(value, ['commandId', 'cityId', 'expectedVersion', 'units'], 'mobilizeUnits');
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(
      value.expectedVersion,
      'expectedVersion',
      0,
      MAX_CITY_VERSION,
    ),
    units: normalizeUnitQuantities(value.units),
  };
}

function validateRecoverCommand(value: unknown): RecoverUnitsCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '회복 명령은 객체여야 한다.');
  assertExactKeys(value, ['commandId', 'cityId', 'expectedVersion', 'units'], 'recoverUnits');
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(
      value.expectedVersion,
      'expectedVersion',
      0,
      MAX_CITY_VERSION,
    ),
    units: normalizeUnitQuantities(value.units),
  };
}

/** 이름 길이 상한. DB CHECK와 같은 값이어야 한다 — 어긋나면 통과한 값이 저장에서 튕긴다. */
const MAX_CITY_NAME_LENGTH = 24;

/**
 * 도시 이름 정규화(D-054). **서버가 정규화하고 서버가 판정한다.**
 *
 * 화면에서 다듬어 보내는 것을 믿으면 안 된다. 다른 클라이언트가 무엇이든 보낼 수 있다.
 *
 * 막는 것과 이유
 * - 제어문자·줄바꿈: 한 줄짜리 표시 자리에 들어가면 화면이 깨진다.
 * - 양끝 공백과 연속 공백: `  강남  `과 `강남`이 다른 이름으로 보이면 사칭에 쓰인다.
 * - 보이지 않는 문자(zero width, 방향 제어): 같은 글자로 보이는 다른 이름을 만들 수 있다.
 * - `[`로 시작: 시스템 메시지가 `[시스템]` 꼴이라 그 자리를 흉내 낼 수 있다.
 *
 * **금칙어 목록은 여기 두지 않는다.** 욕설·상표 필터는 정책이고 운영이 바뀌면 함께 바뀐다.
 * 코드에 박으면 갱신할 때마다 배포해야 한다 — 운영 항목으로 남긴다(D-054 남은 것).
 */
function normalizeCityName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ServerError('INVALID_INPUT', '도시 이름은 문자열이어야 한다.');
  }
  // 유니코드 정규화. 합성·분해가 다른 같은 글자를 한 형태로 모은다.
  const normalized = value.normalize('NFC');
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new ServerError('INVALID_CITY_NAME', '도시 이름에 보이지 않는 문자를 쓸 수 없다.');
  }
  const collapsed = normalized.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) {
    throw new ServerError('INVALID_CITY_NAME', '도시 이름이 비어 있다.');
  }
  // 길이는 코드 포인트로 센다. 서로게이트 쌍을 두 글자로 세면 이모지 이름이 억울하게 잘린다.
  if ([...collapsed].length > MAX_CITY_NAME_LENGTH) {
    throw new ServerError('INVALID_CITY_NAME', `도시 이름은 ${MAX_CITY_NAME_LENGTH}자를 넘을 수 없다.`);
  }
  if (collapsed.startsWith('[')) {
    throw new ServerError('INVALID_CITY_NAME', '도시 이름은 대괄호로 시작할 수 없다.');
  }
  return collapsed;
}

function validateRenameCommand(value: unknown): RenameCityCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '이름 변경 명령은 객체여야 한다.');
  assertExactKeys(value, ['commandId', 'cityId', 'expectedVersion', 'name'], 'renameCity');
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(value.expectedVersion, 'expectedVersion', 0, MAX_CITY_VERSION),
    name: normalizeCityName(value.name),
  };
}

function validateScenarioId(value: unknown): string {
  return validateId(value, 'scenarioId');
}

function validateReconCommand(value: unknown): ReconNpcCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '정찰 명령은 객체여야 한다.');
  assertExactKeys(value, ['commandId', 'cityId', 'expectedVersion', 'scenarioId'], 'reconNpc');
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(
      value.expectedVersion,
      'expectedVersion',
      0,
      MAX_CITY_VERSION,
    ),
    scenarioId: validateScenarioId(value.scenarioId),
  };
}

function normalizeDeployment(
  value: unknown,
  combatRuleVersion: string,
): readonly StackOrder[] {
  const combatRules = RULESETS[combatRuleVersion];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > combatRules.balance.maxStacks) {
    throw new ServerError(
      'INVALID_INPUT',
      `deployment는 1..${combatRules.balance.maxStacks}개 배열이어야 한다.`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new ServerError('INVALID_INPUT', `deployment[${index}]는 객체여야 한다.`);
    }
    const expected = entry.reserveRound === undefined
      ? ['unitId', 'count', 'row']
      : ['unitId', 'count', 'row', 'reserveRound'];
    assertExactKeys(entry, expected, `deployment[${index}]`);
    if (typeof entry.unitId !== 'string'
      || !ECONOMY_UNIT_IDS.includes(entry.unitId as EconomyUnitId)
      || !combatRules.units[entry.unitId]) {
      throw new ServerError('UNKNOWN_UNIT', `알 수 없는 병종: ${String(entry.unitId)}`);
    }
    if (typeof entry.row !== 'string' || !ROWS.includes(entry.row as Row)) {
      throw new ServerError('INVALID_INPUT', `deployment[${index}].row가 유효하지 않다.`);
    }
    const normalized: StackOrder = {
      unitId: entry.unitId,
      count: validateInteger(
        entry.count,
        `deployment[${index}].count`,
        1,
        combatRules.balance.maxStackCount,
      ),
      row: entry.row as Row,
    };
    if (entry.reserveRound !== undefined) {
      return {
        ...normalized,
        reserveRound: validateInteger(
          entry.reserveRound,
          `deployment[${index}].reserveRound`,
          1,
          combatRules.balance.maxRounds,
        ),
      };
    }
    return normalized;
  });
}

function validateAttackCommand(value: unknown, combatRuleVersion: string): AttackNpcCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', 'NPC 공격 명령은 객체여야 한다.');
  assertExactKeys(
    value,
    ['commandId', 'cityId', 'expectedVersion', 'scenarioId', 'deployment', 'doctrine'],
    'attackNpc',
  );
  const combatRules = RULESETS[combatRuleVersion];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  if (typeof value.doctrine !== 'string'
    || !Object.hasOwn(combatRules.doctrines, value.doctrine)) {
    throw new ServerError('UNKNOWN_DOCTRINE', `알 수 없는 교리: ${String(value.doctrine)}`);
  }
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(
      value.expectedVersion,
      'expectedVersion',
      0,
      MAX_CITY_VERSION,
    ),
    scenarioId: validateScenarioId(value.scenarioId),
    deployment: normalizeDeployment(value.deployment, combatRuleVersion),
    doctrine: value.doctrine as DoctrineId,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toMicro(value: number): number {
  const scaled = Math.round(value * SCALE);
  if (!Number.isSafeInteger(scaled) || scaled < 0) {
    throw new ServerError('DATA_INTEGRITY', '규칙 금액을 micro 단위로 변환할 수 없다.');
  }
  return scaled;
}

function fromMicro(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServerError('DATA_INTEGRITY', '저장 자원 잔액이 안전한 정수가 아니다.');
  }
  return value / SCALE;
}

function rulesFor(ruleVersion: string): EconomyRuleset {
  const rules = ECONOMY_RULESETS[ruleVersion];
  if (!rules) throw new ServerError('DATA_INTEGRITY', `알 수 없는 경제 규칙 버전: ${ruleVersion}`);
  return rules;
}

function campaignFor(ruleVersion: string) {
  const rules = (CAMPAIGN_RULESETS as Readonly<Record<string, CampaignRuleset>>)[ruleVersion];
  if (!rules) throw new ServerError('DATA_INTEGRITY', `알 수 없는 캠페인 규칙 버전: ${ruleVersion}`);
  return rules;
}

/**
 * 이 도시가 격파한 시나리오 집합(D-040).
 * 해금 판정과 목록 표시가 같은 값을 쓰도록 한 곳에서만 계산한다.
 */
async function clearedScenarios(tx: SqlExecutor, cityId: string): Promise<Set<string>> {
  // 결과는 별도 열이 아니라 보고서 JSON 안에 있다. 스키마를 늘리지 않고 json_extract로 읽는다.
  const rows = await tx.all(`
    SELECT DISTINCT scenario_id FROM npc_battle_reports
    WHERE city_id = ? AND json_extract(report_json, '$.result.outcome') = 'attacker_win'
  `, cityId) as unknown as { scenario_id: string }[];
  return new Set(rows.map((row) => row.scenario_id));
}

/**
 * 해금 여부. 선행 시나리오를 이겨야 다음이 열린다.
 * 클라이언트는 이 판정을 복제하지 않고 서버가 준 값을 표시만 한다.
 */
function isScenarioUnlocked(scenario: NpcScenario, cleared: ReadonlySet<string>): boolean {
  return scenario.unlockAfter === undefined || cleared.has(scenario.unlockAfter);
}

/** 잠긴 시나리오의 정찰·공격을 막는다. 정찰과 공격 두 경로에서 같은 함수를 쓴다. */
function assertScenarioUnlocked(
  campaign: CampaignRuleset,
  scenario: NpcScenario,
  cleared: ReadonlySet<string>,
): void {
  if (isScenarioUnlocked(scenario, cleared)) return;
  const required = campaign.scenarios[scenario.unlockAfter!];
  throw new ServerError(
    'SCENARIO_LOCKED',
    `${required?.nameKo ?? scenario.unlockAfter}을(를) 먼저 격파해야 한다.`,
  );
}

/**
 * 정찰 정확도(D-043). 정찰차량 수와 레이더 레벨로 결정한다.
 *
 * 레이더 항은 **보고서에 저장된 레이더 레벨**로 계산한다 — 현재 레벨로 다시 계산하면
 * 레이더를 올린 뒤 옛 보고서의 재검증이 깨진다. 레이더 계수가 없는 규칙(0.1.0)에서는
 * radarLevel이 0이므로 기존 식과 완전히 같다.
 */
function reconAccuracyPermille(
  rules: EconomyRuleset,
  scoutCount: number,
  radarLevel: number,
): number {
  const perLevel = rules.balance.radarReconAccuracyPerLevel ?? 0;
  const radarBonus = Math.round(perLevel * 1000) * radarLevel;
  return Math.min(950, 550 + scoutCount * 50 + radarBonus);
}

/** 도시의 현재 건물 레벨. 해금 판정과 건물 목록이 같은 값을 쓰도록 한 곳에서 읽는다. */
async function readBuildingLevels(
  tx: SqlExecutor,
  cityId: string,
): Promise<Map<BuildingId, number>> {
  const rows = await tx.all(
    'SELECT building_id, level FROM city_buildings WHERE city_id = ?',
    cityId,
  ) as unknown as BuildingRow[];
  return new Map(rows.map((row) => [row.building_id as BuildingId, row.level]));
}

/**
 * 병종 해금 판정(D-043).
 * 규칙에 조건이 없는 병종은 제약이 없다(경제 0.1.0 도시는 전부 열려 있다).
 */
function unitUnlockState(
  rules: EconomyRuleset,
  levels: ReadonlyMap<BuildingId, number>,
  unitId: EconomyUnitId,
): { unlocked: boolean; requirement: UnitUnlockDef | null } {
  const requirement = rules.unitUnlocks?.[unitId];
  if (requirement === undefined) return { unlocked: true, requirement: null };
  return {
    unlocked: (levels.get(requirement.buildingId) ?? 0) >= requirement.level,
    requirement,
  };
}

/** 잠긴 병종의 동원을 막는다. 자원을 빼기 전에 호출해야 한다. */
async function assertUnitsUnlocked(
  tx: SqlExecutor,
  city: CityRow,
  rules: EconomyRuleset,
  units: readonly { readonly unitId: EconomyUnitId; readonly count: number }[],
): Promise<void> {
  if (rules.unitUnlocks === undefined) return;
  const levels = await readBuildingLevels(tx, city.id);
  for (const order of units) {
    const state = unitUnlockState(rules, levels, order.unitId);
    if (state.unlocked) continue;
    const requirement = state.requirement!;
    const buildingName = buildingDef(rules, requirement.buildingId).nameKo;
    throw new ServerError(
      'UNIT_LOCKED',
      `${rules.units[order.unitId].unitId}는 ${buildingName} ${requirement.level}레벨이 필요하다.`,
    );
  }
}

/** 배수를 증감 표기로 바꾼다. 1.15 → "+15%", 0.9 → "-10%". */
function percentDelta(multiplier: number): string {
  const delta = Math.round((multiplier - 1) * 100);
  return `${delta >= 0 ? '+' : ''}${delta}%`;
}

/**
 * 교리 효과 설명을 규칙 수치에서 만든다(D-041).
 * 문구를 손으로 적어두면 밸런스를 바꿀 때 조용히 거짓말이 된다.
 */
function doctrineEffects(doctrine: DoctrineDef): string[] {
  const lines: string[] = [];
  for (const [tag, multiplier] of Object.entries(doctrine.attackMult ?? {})) {
    if (multiplier === undefined) continue;
    lines.push(`${UNIT_TAG_LABELS_KO[tag as UnitTag]} 공격 ${percentDelta(multiplier)}`);
  }
  if (doctrine.attackMultAll !== undefined) {
    lines.push(`모든 공격 ${percentDelta(doctrine.attackMultAll)}`);
  }
  if (doctrine.incomingMultAll !== undefined) {
    lines.push(`받는 피해 ${percentDelta(doctrine.incomingMultAll)}`);
  }
  for (const [tag, multiplier] of Object.entries(doctrine.incomingFromTag ?? {})) {
    if (multiplier === undefined) continue;
    lines.push(
      `${UNIT_TAG_LABELS_KO[tag as UnitTag]}에게 받는 피해 ${percentDelta(multiplier)}`,
    );
  }
  if (doctrine.supplyBonus !== undefined) {
    lines.push(`보급 +${doctrine.supplyBonus.toFixed(2)}`);
  }
  if (doctrine.reconBonus !== undefined) {
    lines.push(`정찰 점수 +${doctrine.reconBonus}`);
  }
  if (lines.length === 0) lines.push('보정 없음');
  return lines;
}

/** 도시의 연구 단계. 행이 없으면 0단계다. */
async function readResearchLevels(
  tx: SqlExecutor,
  cityId: string,
): Promise<Map<string, number>> {
  const rows = await tx.all(
    'SELECT research_id, level FROM city_research WHERE city_id = ?',
    cityId,
  ) as unknown as { research_id: string; level: number }[];
  return new Map(rows.map((row) => [row.research_id, row.level]));
}

/** 단계 n의 군표 비용. 단계가 오를수록 비싸진다. */
function researchScripCost(definition: ResearchDef, level: number): number {
  return definition.baseScripCost + definition.scripCostStep * (level - 1);
}

/**
 * 연구 효과 문구를 규칙 수치에서 만든다(D-044).
 * 교리 설명과 같은 원칙이다 — 문구를 손으로 적으면 밸런스와 어긋난다.
 */
function researchEffectKo(definition: ResearchDef, levels: number): string {
  const effect = definition.effect;
  if (levels <= 0) return '';
  switch (effect.kind) {
    case 'attack':
      return `${UNIT_TAG_LABELS_KO[effect.tag as UnitTag] ?? effect.tag} 공격 `
        + `+${Math.round(effect.perLevel * levels * 100)}%`;
    case 'recon':
      return `정찰 정확도 +${effect.perLevelPermille * levels}‰`;
    case 'build_cost':
      return `건설 비용 -${Math.round(effect.perLevelRate * levels * 100)}%`;
    case 'sortie_cost':
      return `출정 비용 -${Math.round(effect.perLevelRate * levels * 100)}%`;
    default:
      return '';
  }
}

/** 연구 목록. 다음 단계 비용과 불가 사유를 서버가 확정해 내려준다. */
async function listResearch(tx: SqlExecutor, city: CityRow): Promise<ResearchSnapshot[]> {
  const rules = rulesFor(city.rule_version);
  const catalog = rules.research;
  if (catalog === undefined) return [];
  const levels = await readResearchLevels(tx, city.id);
  const labLevel = (await readBuildingLevels(tx, city.id)).get('research_lab') ?? 0;
  return Object.values(catalog).map((definition): ResearchSnapshot => {
    const level = levels.get(definition.id) ?? 0;
    const atMax = level >= definition.maxLevel;
    const nextLevel = atMax ? null : level + 1;
    const prerequisite = definition.requires;
    let blockedReason: string | null = null;
    if (atMax) blockedReason = 'MAX_LEVEL';
    else if (labLevel < definition.requiresLabLevel) blockedReason = 'RESEARCH_LAB_REQUIRED';
    else if (prerequisite !== undefined
      && (levels.get(prerequisite) ?? 0) < 1) blockedReason = 'RESEARCH_PREREQUISITE';
    return {
      researchId: definition.id,
      nameKo: definition.nameKo,
      categoryKo: definition.categoryKo,
      descriptionKo: definition.descriptionKo,
      level,
      maxLevel: definition.maxLevel,
      nextLevel,
      nextScripCost: atMax ? 0 : researchScripCost(definition, level + 1),
      effectKo: `단계당 ${researchEffectKo(definition, 1)}`,
      currentEffectKo: researchEffectKo(definition, level),
      blockedReason,
      requiresLabLevel: definition.requiresLabLevel,
      requiresResearchId: prerequisite ?? null,
      requiresResearchNameKo: prerequisite === undefined
        ? null
        : catalog[prerequisite]?.nameKo ?? prerequisite,
    };
  });
}

/**
 * 완료된 연구가 만드는 보정값(D-044).
 * 전부 이미 존재하는 계산에 들어간다 — 새 전투 규칙을 만들지 않는다.
 */
interface ResearchModifiers {
  /** 태그별 공격 배수 가산. 교리와 같은 경로로 전투 입력에 들어간다. */
  readonly attackByTag: ReadonlyMap<string, number>;
  readonly reconPermille: number;
  readonly buildCostRate: number;
  readonly sortieCostRate: number;
}

const NO_RESEARCH: ResearchModifiers = {
  attackByTag: new Map(),
  reconPermille: 0,
  buildCostRate: 0,
  sortieCostRate: 0,
};

async function readResearchModifiers(
  tx: SqlExecutor,
  city: CityRow,
): Promise<ResearchModifiers> {
  const rules = rulesFor(city.rule_version);
  const catalog = rules.research;
  if (catalog === undefined) return NO_RESEARCH;
  const levels = await readResearchLevels(tx, city.id);
  const attackByTag = new Map<string, number>();
  let reconPermille = 0;
  let buildCostRate = 0;
  let sortieCostRate = 0;
  for (const definition of Object.values(catalog)) {
    const level = levels.get(definition.id) ?? 0;
    if (level <= 0) continue;
    const effect = definition.effect;
    if (effect.kind === 'attack') {
      attackByTag.set(effect.tag, (attackByTag.get(effect.tag) ?? 0) + effect.perLevel * level);
    } else if (effect.kind === 'recon') {
      reconPermille += effect.perLevelPermille * level;
    } else if (effect.kind === 'build_cost') {
      buildCostRate += effect.perLevelRate * level;
    } else {
      sortieCostRate += effect.perLevelRate * level;
    }
  }
  return { attackByTag, reconPermille, buildCostRate, sortieCostRate };
}

/** 정산 1회가 처리할 수 있는 최대 시간. 오래 비운 도시가 한 번에 과도한 계산을 하지 않게 자른다. */
const MAX_PRODUCTION_HOURS_PER_COMMAND = 720;

/**
 * `hours`시간치 생산을 **시간 단위로** 누적한다(D-045).
 *
 * 군표는 그 시각의 인력에 비례하고 인력도 매시간 늘기 때문에, 한 번에 곱하면 시뮬레이터와
 * 값이 갈라진다. 상한 절단도 매시간 일어나므로 여기서 함께 반영한다 —
 * 결과는 DB에 한 번만 쓰지만 계산은 시간별 정산과 같다.
 */
function accumulateProduction(
  rules: EconomyRuleset,
  levels: ReadonlyMap<BuildingId, number>,
  balances: ReadonlyMap<ResourceId, number>,
  caps: ReadonlyMap<ResourceId, number>,
  hours: number,
): PartialBundle {
  const levelRecord: Partial<Record<BuildingId, number>> = {};
  for (const [buildingId, level] of levels) levelRecord[buildingId] = level;
  const current = new Map<ResourceId, number>(balances);
  for (let hour = 0; hour < hours; hour += 1) {
    const produced = hourlyProduction(rules, levelRecord, fromMicro(current.get('manpower') ?? 0));
    for (const resourceId of RESOURCE_IDS) {
      const amount = produced[resourceId] ?? 0;
      if (amount <= 0) continue;
      const cap = caps.get(resourceId) ?? 0;
      const next = Math.min(cap, (current.get(resourceId) ?? 0) + toMicro(amount));
      current.set(resourceId, next);
    }
  }
  const credited: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const delta = (current.get(resourceId) ?? 0) - (balances.get(resourceId) ?? 0);
    if (delta > 0) credited[resourceId] = fromMicro(delta);
  }
  return credited;
}

/**
 * 부상병 회복 비용(D-045).
 *
 * `GAME_DESIGN.md`와 캠페인 규칙이 정한 식을 그대로 쓴다:
 * **선택 병력 전투가치 합 × recoverySupplyCostRatio 를 올림한 보급품.**
 * 병종별로 나눠 올림하지 않는다 — 엔진 캠페인 시뮬레이터와 같은 값이어야 한다.
 */
function recoveryValue(campaign: CampaignRuleset, units: readonly UnitQuantity[]): number {
  const combatRules = RULESETS[campaign.combatRuleVersion as keyof typeof RULESETS];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  return units.reduce(
    (sum, order) => sum + order.count * (combatRules.units[order.unitId]?.cost ?? 0),
    0,
  );
}

function recoverySuppliesCost(campaign: CampaignRuleset, units: readonly UnitQuantity[]): number {
  return Math.ceil(recoveryValue(campaign, units) * campaign.recoverySupplyCostRatio);
}

/** 회복 안내. 화면이 올림 규칙을 흉내 내지 않도록 병종별 전투가치와 비율을 그대로 준다. */
function recoveryInfo(city: CityRow): RecoveryInfoSnapshot {
  const campaign = campaignForCity(city);
  const combatRules = RULESETS[campaign.combatRuleVersion as keyof typeof RULESETS];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  const unitValues: Partial<Record<EconomyUnitId, number>> = {};
  for (const unitId of ECONOMY_UNIT_IDS) {
    unitValues[unitId] = combatRules.units[unitId]?.cost ?? 0;
  }
  return {
    hours: campaign.recoveryHours,
    suppliesRate: campaign.recoverySupplyCostRatio,
    unitValues,
  };
}

async function readRecoveryJobs(tx: SqlExecutor, cityId: string): Promise<RecoveryJobRow[]> {
  return await tx.all(`
    SELECT id, city_id, command_id, unit_id, count, started_at_hour,
           completes_at_hour, status, completed_at_hour, completed_city_version
    FROM recovery_jobs
    WHERE city_id = ?
    ORDER BY started_at_hour, id
  `, cityId) as unknown as RecoveryJobRow[];
}

function recoveryJobSnapshot(row: RecoveryJobRow): RecoveryJobSnapshot {
  const unitId = row.unit_id as EconomyUnitId;
  if (!ECONOMY_UNIT_IDS.includes(unitId)
    || !Number.isSafeInteger(row.count)
    || row.count <= 0
    || !['pending', 'completed'].includes(row.status)) {
    throw new ServerError('DATA_INTEGRITY', '회복 job 행이 유효하지 않다.');
  }
  return {
    id: row.id,
    cityId: row.city_id,
    commandId: row.command_id,
    unitId,
    count: row.count,
    startedAtHour: row.started_at_hour,
    completesAtHour: row.completes_at_hour,
    status: row.status,
  };
}

/**
 * 건물별 증설 정보(D-043).
 * 다음 레벨 비용·소요 시간·가능 여부·불가 사유를 서버가 판정해 내려준다 —
 * 눌러 보고 거부를 받아야 알 수 있던 상태를 없앤다. 화면은 게이트 규칙을 복제하지 않는다.
 */
async function listBuildings(tx: SqlExecutor, city: CityRow): Promise<BuildingInfoSnapshot[]> {
  const rules = rulesFor(city.rule_version);
  const levels = await readBuildingLevels(tx, city.id);
  const pendingRows = await tx.all(`
    SELECT building_id FROM construction_jobs WHERE city_id = ? AND status = 'pending'
  `, city.id) as unknown as { building_id: string }[];
  const pending = new Set(pendingRows.map((row) => row.building_id));
  const slotsFull = pending.size >= rules.balance.buildSlots;
  const hqLevel = levels.get('hq') ?? 0;

  return cityBuildingIds(rules).map((buildingId): BuildingInfoSnapshot => {
    const definition = buildingDef(rules, buildingId);
    const level = levels.get(buildingId) ?? 0;
    const targetLevel = level + 1;
    const atMax = targetLevel > definition.maxLevel;
    const cost = atMax ? {} : constructionCost(rules, buildingId, targetLevel);
    const hours = atMax ? 0 : constructionHours(rules, buildingId, targetLevel);
    // 불가 사유는 서버 오류 코드와 같은 값을 쓴다. 화면이 새 문자열을 해석하지 않게 한다.
    let blockedReason: string | null = null;
    // 시스템이 없는 건물은 아예 못 짓게 한다(D-044) — 효과 없이 자원만 먹으면 함정이다.
    if (definition.inertReasonKo !== undefined) blockedReason = 'SYSTEM_NOT_IMPLEMENTED';
    else if (atMax) blockedReason = 'MAX_LEVEL';
    else if (pending.has(buildingId)) blockedReason = 'BUILDING_ALREADY_PENDING';
    else if (slotsFull) blockedReason = 'BUILD_SLOT_FULL';
    else if (buildingId !== 'hq'
      && targetLevel > hqLevel + rules.balance.nonHqLevelOffset) blockedReason = 'HQ_LEVEL_REQUIRED';
    return {
      buildingId,
      nameKo: definition.nameKo,
      level,
      maxLevel: definition.maxLevel,
      nextLevel: atMax ? null : targetLevel,
      nextCost: cost,
      nextHours: hours,
      blockedReason,
      inertReasonKo: definition.inertReasonKo ?? null,
    };
  });
}

/**
 * 배치 열 선택을 돕는 설명(D-045). **규칙 수치에서 만든다** — 손으로 적으면 규칙과 어긋난다.
 * 진형에는 금지 조합이 없다. 사거리와 피격 순서가 만드는 대가만 있으므로 그것을 알려준다.
 */
function rowHintKo(unit: UnitDef | undefined): string {
  if (unit === undefined) return '';
  if (unit.domain === 'air') return '항공 — 배치 열과 무관하게 싸웁니다.';
  const reach = unit.reach >= 3
    ? '모든 열을 때립니다'
    : unit.reach === 2
      ? '앞의 두 열까지 때립니다'
      : '가장 가까운 열만 때립니다';
  return `사거리 ${unit.reach} — ${reach}. 앞에 둘수록 먼저 맞습니다.`;
}

/**
 * 동원 가능한 병종 목록(D-043).
 * 훈련 비용과 해금 조건을 서버가 확정해 내려준다 — 화면이 비용·게이트를 복제하지 않는다.
 */
async function listUnits(tx: SqlExecutor, city: CityRow): Promise<UnitSnapshot[]> {
  const rules = rulesFor(city.rule_version);
  const combatRules = RULESETS[campaignForCity(city).combatRuleVersion as keyof typeof RULESETS];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  const levels = await readBuildingLevels(tx, city.id);
  return ECONOMY_UNIT_IDS.map((unitId): UnitSnapshot => {
    const state = unitUnlockState(rules, levels, unitId);
    const requirement = state.requirement;
    return {
      unitId,
      nameKo: combatRules.units[unitId]?.nameKo ?? unitId,
      // 기본 열과 사거리 설명은 전투 규칙에서 만든다(D-045) — 화면이 표를 복제하지 않는다.
      defaultRow: combatRules.units[unitId]?.defaultRow ?? 'mid',
      rowHintKo: rowHintKo(combatRules.units[unitId]),
      trainCost: rules.units[unitId].trainCost,
      upkeepFoodPerHour: rules.units[unitId].upkeepFoodPerHour,
      unlocked: state.unlocked,
      requiresBuildingId: requirement?.buildingId ?? null,
      requiresBuildingNameKo: requirement === null
        ? null
        : buildingDef(rules, requirement.buildingId).nameKo,
      requiresLevel: requirement?.level ?? null,
    };
  });
}

/** 이 도시의 전투 규칙이 제공하는 교리 목록. 효과는 규칙 수치에서 생성한다. */
function listDoctrines(city: CityRow): DoctrineSnapshot[] {
  const combatRules = RULESETS[campaignForCity(city).combatRuleVersion as keyof typeof RULESETS];
  if (!combatRules) throw new ServerError('DATA_INTEGRITY', '도시의 전투 규칙 버전을 찾을 수 없다.');
  return Object.values(combatRules.doctrines).map((doctrine): DoctrineSnapshot => ({
    id: doctrine.id,
    nameKo: doctrine.nameKo,
    effectsKo: doctrineEffects(doctrine),
  }));
}

/**
 * 화면에 보여줄 시나리오 목록. 해금·격파 판정을 서버가 확정해서 내려준다.
 * 표시 순서는 tier이며, 같으면 id로 고정한다(로케일에 의존하지 않게 코드 단위 비교).
 */
async function listScenarios(tx: SqlExecutor, city: CityRow): Promise<ScenarioSnapshot[]> {
  const campaign = campaignForCity(city);
  const cleared = await clearedScenarios(tx, city.id);
  return Object.values(campaign.scenarios)
    .slice()
    .sort((a, b) => (a.tier ?? 999) - (b.tier ?? 999)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((scenario): ScenarioSnapshot => ({
      id: scenario.id,
      nameKo: scenario.nameKo,
      briefKo: scenario.briefKo ?? '',
      tier: scenario.tier ?? 0,
      victoryReward: scenario.victoryReward,
      // 방어 편성은 싣지 않는다. 적 규모를 아는 수단은 정찰이며, 목록이 그것을 대신하면 안 된다.
      cleared: cleared.has(scenario.id),
      unlocked: isScenarioUnlocked(scenario, cleared),
      requiresScenarioId: scenario.unlockAfter ?? null,
      requiresNameKo: scenario.unlockAfter === undefined
        ? null
        : campaign.scenarios[scenario.unlockAfter]?.nameKo ?? scenario.unlockAfter,
    }));
}

function campaignForCity(city: CityRow): CampaignRuleset {
  const campaign = campaignFor(city.campaign_rule_version);
  if (campaign.economyRuleVersion !== city.rule_version) {
    throw new ServerError(
      'DATA_INTEGRITY',
      `도시의 경제·캠페인 규칙 버전이 호환되지 않는다: ${city.rule_version}/${city.campaign_rule_version}`,
    );
  }
  return campaign;
}

async function cityRow(tx: SqlExecutor, cityId: string): Promise<CityRow | undefined> {
  return await tx.get(`
    SELECT id, owner_id, rule_version, campaign_rule_version, version, last_server_hour,
           last_production_hour, name
    FROM cities WHERE id = ?
  `, cityId) as unknown as CityRow | undefined;
}

async function receiptRow(
  tx: SqlExecutor,
  actorId: string,
  commandId: string,
): Promise<OperationReceiptRow | undefined> {
  return await tx.get(`
    SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
           payload_json, response_json, created_at_hour
    FROM operation_receipts
    WHERE actor_id = ? AND command_id = ?
  `, actorId, commandId) as unknown as OperationReceiptRow | undefined;
}

async function assertNoConstructionReceipt(
  tx: SqlExecutor,
  actorId: string,
  commandId: string,
): Promise<void> {
  const conflicting = await tx.get(`
    SELECT 1 AS present
    FROM command_receipts
    WHERE actor_id = ? AND command_id = ?
  `, actorId, commandId);
  if (conflicting) {
    throw new ServerError(
      'IDEMPOTENCY_KEY_REUSED',
      '같은 commandId가 이미 다른 명령 종류에 사용됐다.',
    );
  }
}

function assertCityCommand(
  city: CityRow,
  context: CommandContext,
  expectedVersion: number,
): void {
  if (city.owner_id !== context.actorId) {
    throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
  }
  if (city.version !== expectedVersion) {
    throw new ServerError(
      'STALE_VERSION',
      `도시 version 불일치: expected=${expectedVersion}, actual=${city.version}`,
    );
  }
  if (city.version >= MAX_CITY_VERSION) {
    throw new ServerError('VERSION_EXHAUSTED', '도시 version 상한에 도달했다.');
  }
  if (context.nowHour < city.last_server_hour) {
    throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
  }
}

function assertReceipt(
  row: OperationReceiptRow,
  kind: OperationCommandKind,
  cityId: string,
  payloadJson: string,
  payloadSha256: string,
): void {
  if (!SHA256_PATTERN.test(row.payload_sha256)
    || sha256(row.payload_json) !== row.payload_sha256) {
    throw new ServerError('DATA_INTEGRITY', '저장 작전 영수증 payload hash가 손상됐다.');
  }
  parseCanonicalStored(row.payload_json, '작전 payload');
  if (row.command_kind !== kind
    || row.city_id !== cityId
    || row.payload_json !== payloadJson
    || row.payload_sha256 !== payloadSha256) {
    throw new ServerError(
      'IDEMPOTENCY_KEY_REUSED',
      '같은 commandId가 다른 작전 payload에 사용됐다.',
    );
  }
}

function parseCanonicalStored(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ServerError('DATA_INTEGRITY', `${label} JSON이 손상됐다.`);
  }
  if (stableStringify(parsed) !== value) {
    throw new ServerError('DATA_INTEGRITY', `${label} JSON이 canonical 형식이 아니다.`);
  }
  return parsed;
}

function validateStoredBundle(value: unknown, label: string): Readonly<PartialBundle> {
  if (!isPlainRecord(value)) throw new ServerError('DATA_INTEGRITY', `${label}가 객체가 아니다.`);
  const bundle: PartialBundle = {};
  for (const [key, amount] of Object.entries(value)) {
    /**
     * micro 단위(1/1000)의 배수여야 한다. 다만 **부동소수 왕복을 그대로 비교하면 안 된다** —
     * 생산 정산은 micro 정수를 1000으로 나눠 돌려주므로 `26.859` 같은 값이 나오는데,
     * `26.859 * 1000`은 이진수로 26858.999999999996이라 등식 비교가 실패한다(D-047).
     * 비용처럼 정수 금액만 오던 때는 드러나지 않던 문제다.
     */
    const scaled = typeof amount === 'number' ? amount * SCALE : Number.NaN;
    if (!RESOURCE_IDS.includes(key as ResourceId)
      || typeof amount !== 'number'
      || !Number.isFinite(amount)
      || amount <= 0
      || Math.abs(Math.round(scaled) - scaled) > 1e-6) {
      throw new ServerError('DATA_INTEGRITY', `${label}의 저장 금액이 유효하지 않다.`);
    }
    bundle[key as ResourceId] = amount;
  }
  return bundle;
}

function validateStoredUnitQuantities(value: unknown): readonly UnitQuantity[] {
  try {
    return normalizeUnitQuantities(value);
  } catch (error) {
    throw new ServerError('DATA_INTEGRITY', '저장 동원 병력 스키마가 유효하지 않다.', { cause: error });
  }
}

function validateReconReport(value: unknown, row?: ReconReportRow): ReconReportSnapshot {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 보고서가 객체가 아니다.');
  }
  assertStoredExactKeys(value, [
    'id',
    'cityId',
    'commandId',
    'scenarioId',
    'scenarioNameKo',
    'campaignRuleVersion',
    'scoutCount',
    'accuracy',
    'createdAtHour',
    'expiresAtHour',
    'threats',
  ], '정찰 보고서', ['radarLevel', 'researchReconPermille']);
  if (typeof value.id !== 'string'
    || typeof value.cityId !== 'string'
    || typeof value.commandId !== 'string'
    || typeof value.scenarioId !== 'string'
    || typeof value.scenarioNameKo !== 'string'
    || typeof value.campaignRuleVersion !== 'string'
    || !Number.isSafeInteger(value.scoutCount)
    || typeof value.accuracy !== 'number'
    || !Number.isInteger(value.createdAtHour)
    || !Number.isInteger(value.expiresAtHour)
    || !Array.isArray(value.threats)) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 보고서 필드 형식이 다르다.');
  }
  const threats: ReconThreatEstimate[] = value.threats.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new ServerError('DATA_INTEGRITY', '저장 정찰 위협 항목이 객체가 아니다.');
    }
    assertStoredExactKeys(entry, ['unitId', 'row', 'minimum', 'maximum'], '정찰 위협');
    if (typeof entry.unitId !== 'string'
      || !ECONOMY_UNIT_IDS.includes(entry.unitId as EconomyUnitId)
      || typeof entry.row !== 'string'
      || !ROWS.includes(entry.row as Row)
      || !Number.isInteger(entry.minimum)
      || !Number.isInteger(entry.maximum)
      || (entry.minimum as number) < 0
      || (entry.maximum as number) < (entry.minimum as number)) {
      throw new ServerError('DATA_INTEGRITY', '저장 정찰 위협 값이 유효하지 않다.');
    }
    return {
      unitId: entry.unitId as EconomyUnitId,
      row: entry.row as Row,
      minimum: entry.minimum as number,
      maximum: entry.maximum as number,
    };
  });
  const report: ReconReportSnapshot = {
    id: value.id,
    cityId: value.cityId,
    commandId: value.commandId,
    scenarioId: value.scenarioId,
    scenarioNameKo: value.scenarioNameKo,
    campaignRuleVersion: value.campaignRuleVersion,
    scoutCount: value.scoutCount as number,
    accuracy: value.accuracy,
    createdAtHour: value.createdAtHour as number,
    expiresAtHour: value.expiresAtHour as number,
    // 레이더 도입 전 보고서에는 이 항목이 없다. 없으면 0으로 보면 기존 식과 같아진다.
    radarLevel: (value.radarLevel as number | undefined) ?? 0,
    researchReconPermille: (value.researchReconPermille as number | undefined) ?? 0,
    threats,
  };
  if (!Number.isInteger(report.radarLevel) || report.radarLevel < 0
    || !Number.isInteger(report.researchReconPermille) || report.researchReconPermille < 0) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 보고서의 보정값이 유효하지 않다.');
  }
  const expectedAccuracy = Math.min(950, reconAccuracyPermille(
    rulesFor(campaignFor(report.campaignRuleVersion).economyRuleVersion),
    report.scoutCount,
    report.radarLevel,
  ) + report.researchReconPermille);
  if (report.scoutCount < 1
    || Math.round(report.accuracy * 1000) !== expectedAccuracy
    || report.expiresAtHour !== report.createdAtHour + RECON_VALID_HOURS) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 보고서 범위가 유효하지 않다.');
  }
  if (row && (
    row.id !== report.id
    || row.city_id !== report.cityId
    || row.command_id !== report.commandId
    || row.scenario_id !== report.scenarioId
    || row.accuracy_permille !== Math.round(report.accuracy * 1000)
    || row.created_at_hour !== report.createdAtHour
    || row.expires_at_hour !== report.expiresAtHour
  )) {
    throw new ServerError('DATA_INTEGRITY', '정찰 보고서 JSON과 DB 열이 일치하지 않는다.');
  }
  return report;
}

function assertReconSemantics(report: ReconReportSnapshot, campaignRuleVersion: string): void {
  if (report.campaignRuleVersion !== campaignRuleVersion) {
    throw new ServerError('DATA_INTEGRITY', '정찰 보고서의 캠페인 규칙 버전이 도시와 다르다.');
  }
  const scenario = campaignFor(campaignRuleVersion).scenarios[report.scenarioId];
  if (!scenario || scenario.nameKo !== report.scenarioNameKo) {
    throw new ServerError('DATA_INTEGRITY', '정찰 보고서의 시나리오가 규칙과 다르다.');
  }
  const accuracyPermille = Math.round(report.accuracy * 1000);
  const expected: ReconThreatEstimate[] = scenario.defender.stacks.map((stack) => ({
    unitId: stack.unitId as EconomyUnitId,
    row: stack.row,
    minimum: Math.floor(stack.count * accuracyPermille / 1000),
    maximum: Math.ceil(stack.count * (2000 - accuracyPermille) / 1000),
  }));
  if (stableStringify(expected) !== stableStringify(report.threats)) {
    throw new ServerError('DATA_INTEGRITY', '정찰 위협 범위가 규칙 계산과 다르다.');
  }
}

function validateCasualties(value: unknown): readonly UnitCasualtySnapshot[] {
  if (!Array.isArray(value)) {
    throw new ServerError('DATA_INTEGRITY', '전투 사상자 보고서가 배열이 아니다.');
  }
  return value.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new ServerError('DATA_INTEGRITY', '전투 사상자 항목이 객체가 아니다.');
    }
    assertStoredExactKeys(
      entry,
      ['unitId', 'deployed', 'survivors', 'wounded', 'dead'],
      '전투 사상자',
    );
    if (typeof entry.unitId !== 'string'
      || !ECONOMY_UNIT_IDS.includes(entry.unitId as EconomyUnitId)) {
      throw new ServerError('DATA_INTEGRITY', '전투 사상자의 병종이 유효하지 않다.');
    }
    const numbers = ['deployed', 'survivors', 'wounded', 'dead'] as const;
    for (const key of numbers) {
      if (!Number.isSafeInteger(entry[key]) || (entry[key] as number) < 0) {
        throw new ServerError('DATA_INTEGRITY', `전투 사상자 ${key}가 유효하지 않다.`);
      }
    }
    if ((entry.survivors as number) + (entry.wounded as number) + (entry.dead as number)
      !== entry.deployed) {
      throw new ServerError('DATA_INTEGRITY', '전투 사상자 합계가 투입 수량과 다르다.');
    }
    return {
      unitId: entry.unitId as EconomyUnitId,
      deployed: entry.deployed as number,
      survivors: entry.survivors as number,
      wounded: entry.wounded as number,
      dead: entry.dead as number,
    };
  });
}

function validateBattleReport(value: unknown, row: BattleReportRow): NpcBattleReportSnapshot {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 보고서가 객체가 아니다.');
  }
  assertStoredExactKeys(value, [
    'id',
    'cityId',
    'commandId',
    'scenarioId',
    'scenarioNameKo',
    'campaignRuleVersion',
    'seed',
    'createdAtHour',
    'reconReportId',
    'sortieCost',
    'reward',
    'casualties',
    'result',
    'analysis',
  ], '전투 보고서');
  const input = parseCanonicalStored(row.input_json, '전투 입력');
  let replayed;
  try {
    replayed = simulateBattle(input as BattleInput);
  } catch (error) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 입력을 재현할 수 없다.', { cause: error });
  }
  if (stableStringify(replayed) !== stableStringify(value.result)) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 결과가 입력 재현 결과와 다르다.');
  }
  if (typeof value.id !== 'string'
    || typeof value.cityId !== 'string'
    || typeof value.commandId !== 'string'
    || typeof value.scenarioId !== 'string'
    || typeof value.scenarioNameKo !== 'string'
    || typeof value.campaignRuleVersion !== 'string'
    || typeof value.seed !== 'number'
    || !Number.isInteger(value.createdAtHour)
    || typeof value.reconReportId !== 'string'
    || !isPlainRecord(value.analysis)
    || value.id !== row.id
    || value.cityId !== row.city_id
    || value.commandId !== row.command_id
    || value.scenarioId !== row.scenario_id
    || value.reconReportId !== row.recon_report_id
    || value.seed !== row.seed
    || value.createdAtHour !== row.created_at_hour
    || replayed.hash !== row.result_hash) {
    throw new ServerError('DATA_INTEGRITY', '전투 보고서 JSON과 DB 열이 일치하지 않는다.');
  }
  const expectedAnalysis = analyzeBattle(replayed);
  if (stableStringify(expectedAnalysis) !== stableStringify(value.analysis)) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 분석이 재현 결과와 다르다.');
  }
  if (stableStringify(value) !== row.report_json) {
    throw new ServerError('DATA_INTEGRITY', '전투 보고서 JSON 열이 canonical 보고서와 다르다.');
  }
  // 교리는 이미 전투 입력에 저장되어 있다(D-042). 저장 형태를 바꾸지 않고 여기서 꺼내
  // 파생 항목으로 내려준다 — 위의 canonical 비교는 모두 저장 원본을 대상으로 하므로 영향이 없다.
  const doctrineId = (input as BattleInput).attacker.doctrine;
  const combatRules = RULESETS[replayed.ruleVersion as keyof typeof RULESETS];
  const doctrineDef = combatRules?.doctrines[doctrineId];
  if (!doctrineDef) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투의 교리를 규칙에서 찾을 수 없다.');
  }
  return {
    doctrine: doctrineId,
    doctrineNameKo: doctrineDef.nameKo,
    id: value.id,
    cityId: value.cityId,
    commandId: value.commandId,
    scenarioId: value.scenarioId,
    scenarioNameKo: value.scenarioNameKo,
    campaignRuleVersion: value.campaignRuleVersion,
    seed: value.seed,
    createdAtHour: value.createdAtHour as number,
    reconReportId: value.reconReportId,
    sortieCost: validateStoredBundle(value.sortieCost, '출정 비용'),
    reward: validateStoredBundle(value.reward, '전투 보상'),
    casualties: validateCasualties(value.casualties),
    result: replayed,
    analysis: expectedAnalysis,
  };
}

async function readResourceMap(
  tx: SqlExecutor,
  cityId: string,
): Promise<Map<ResourceId, number>> {
  const rows = await tx.all(`
    SELECT resource_id, balance_micro
    FROM city_resources WHERE city_id = ?
  `, cityId) as unknown as ResourceRow[];
  if (rows.length !== RESOURCE_IDS.length) {
    throw new ServerError('DATA_INTEGRITY', '도시 자원 행 수가 규칙과 다르다.');
  }
  const result = new Map<ResourceId, number>();
  for (const row of rows) {
    if (!RESOURCE_IDS.includes(row.resource_id as ResourceId)
      || result.has(row.resource_id as ResourceId)
      || !Number.isSafeInteger(row.balance_micro)
      || row.balance_micro < 0) {
      throw new ServerError('DATA_INTEGRITY', '도시 자원 행이 유효하지 않다.');
    }
    result.set(row.resource_id as ResourceId, row.balance_micro);
  }
  return result;
}

async function readArmy(
  tx: SqlExecutor,
  cityId: string,
): Promise<{ rows: Map<EconomyUnitId, ArmyRow>; snapshot: ArmyStateSnapshot }> {
  const source = await tx.all(`
    SELECT unit_id, ready, wounded, dead
    FROM city_armies WHERE city_id = ?
  `, cityId) as unknown as ArmyRow[];
  if (source.length !== ECONOMY_UNIT_IDS.length) {
    throw new ServerError('DATA_INTEGRITY', '도시 병력 행 수가 규칙과 다르다.');
  }
  const rows = new Map<EconomyUnitId, ArmyRow>();
  const ready = {} as Record<EconomyUnitId, number>;
  const wounded = {} as Record<EconomyUnitId, number>;
  const dead = {} as Record<EconomyUnitId, number>;
  for (const row of source) {
    const unitId = row.unit_id as EconomyUnitId;
    if (!ECONOMY_UNIT_IDS.includes(unitId)
      || rows.has(unitId)
      || !Number.isSafeInteger(row.ready)
      || !Number.isSafeInteger(row.wounded)
      || !Number.isSafeInteger(row.dead)
      || row.ready < 0
      || row.wounded < 0
      || row.dead < 0) {
      throw new ServerError('DATA_INTEGRITY', '도시 병력 행이 유효하지 않다.');
    }
    rows.set(unitId, row);
    ready[unitId] = row.ready;
    wounded[unitId] = row.wounded;
    dead[unitId] = row.dead;
  }
  return { rows, snapshot: { ready, wounded, dead } };
}

function assertBundlesEqual(
  actual: Readonly<PartialBundle>,
  expected: Readonly<PartialBundle>,
  label: string,
): void {
  const normalize = (bundle: Readonly<PartialBundle>): PartialBundle => {
    const result: PartialBundle = {};
    for (const resourceId of RESOURCE_IDS) {
      const amount = bundle[resourceId] ?? 0;
      if (amount > 0) result[resourceId] = amount;
    }
    return result;
  };
  if (stableStringify(normalize(actual)) !== stableStringify(normalize(expected))) {
    throw new ServerError('DATA_INTEGRITY', `${label}가 규칙·원장과 일치하지 않는다.`);
  }
}

async function ledgerBundle(
  tx: SqlExecutor,
  cityId: string,
  commandId: string,
  reason: OperationLedgerReason,
): Promise<Readonly<PartialBundle>> {
  const rows = await tx.all(`
    SELECT id, city_id, command_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM operation_ledger
    WHERE city_id = ? AND command_id = ? AND reason = ?
    ORDER BY resource_id
  `, cityId, commandId, reason) as unknown as OperationLedgerRow[];
  const bundle: PartialBundle = {};
  for (const row of rows) {
    const resourceId = row.resource_id as ResourceId;
    const expectedSign = CREDIT_LEDGER_REASONS.includes(reason) ? 1 : -1;
    if (!RESOURCE_IDS.includes(resourceId)
      || row.city_id !== cityId
      || row.command_id !== commandId
      || row.reason !== reason
      || Math.sign(row.delta_micro) !== expectedSign
      || row.balance_after_micro !== row.balance_before_micro + row.delta_micro
      || bundle[resourceId] !== undefined) {
      throw new ServerError('DATA_INTEGRITY', '작전 원장 의미가 유효하지 않다.');
    }
    bundle[resourceId] = fromMicro(Math.abs(row.delta_micro));
  }
  return bundle;
}

function totalMobilizationCost(
  rules: EconomyRuleset,
  units: readonly UnitQuantity[],
): Readonly<PartialBundle> {
  const totals: PartialBundle = {};
  for (const order of units) {
    const definition = rules.units[order.unitId];
    if (!definition) throw new ServerError('DATA_INTEGRITY', `병종 규칙이 없다: ${order.unitId}`);
    for (const resourceId of RESOURCE_IDS) {
      const unitCost = definition.trainCost[resourceId] ?? 0;
      const next = (totals[resourceId] ?? 0) + unitCost * order.count;
      if (!Number.isSafeInteger(next * SCALE) || next < 0) {
        throw new ServerError('DATA_INTEGRITY', '동원 비용이 안전한 범위를 넘는다.');
      }
      if (next > 0) totals[resourceId] = next;
    }
  }
  return totals;
}

async function debitBundle(
  tx: SqlExecutor,
  cityId: string,
  commandId: string,
  context: CommandContext,
  bundle: Readonly<PartialBundle>,
  reason: Exclude<OperationLedgerReason, 'victory_reward'>,
  afterFirstDebit?: () => void,
): Promise<Readonly<PartialBundle>> {
  const balances = await readResourceMap(tx, cityId);
  for (const resourceId of RESOURCE_IDS) {
    const required = toMicro(bundle[resourceId] ?? 0);
    if ((balances.get(resourceId) ?? -1) < required) {
      throw new ServerError('INSUFFICIENT_RESOURCES', `${resourceId} 자원이 부족하다.`);
    }
  }
  const applied: PartialBundle = {};
  let debitCount = 0;
  for (const resourceId of RESOURCE_IDS) {
    const required = toMicro(bundle[resourceId] ?? 0);
    if (required === 0) continue;
    const before = balances.get(resourceId)!;
    const after = before - required;
    const update = await tx.run(`
      UPDATE city_resources SET balance_micro = ?
      WHERE city_id = ? AND resource_id = ? AND balance_micro = ?
    `, after, cityId, resourceId, before);
    if (update.changes !== 1) {
      throw new ServerError('DATA_INTEGRITY', '자원 차감 조건부 갱신이 실패했다.');
    }
    const id = `op-ledger:${sha256(`${cityId}:${commandId}:${reason}:${resourceId}`).slice(0, 64)}`;
    await tx.run(`
      INSERT INTO operation_ledger(
        id, city_id, command_id, resource_id, reason, delta_micro,
        balance_before_micro, balance_after_micro, created_at_hour
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, cityId, commandId, resourceId, reason, -required, before, after, context.nowHour);
    applied[resourceId] = fromMicro(required);
    debitCount += 1;
    if (debitCount === 1) afterFirstDebit?.();
  }
  return applied;
}

async function resourceCapMicro(
  tx: SqlExecutor,
  cityId: string,
  rules: EconomyRuleset,
  resourceId: ResourceId,
): Promise<number> {
  const rows = await tx.all(`
    SELECT building_id, level FROM city_buildings
    WHERE city_id = ? AND building_id IN ('warehouse','housing','hq')
  `, cityId) as unknown as BuildingRow[];
  const levels = new Map<BuildingId, number>();
  for (const row of rows) levels.set(row.building_id as BuildingId, row.level);
  const warehouse = levels.get('warehouse');
  const housing = levels.get('housing');
  const hq = levels.get('hq');
  if (warehouse === undefined || housing === undefined || hq === undefined) {
    throw new ServerError('DATA_INTEGRITY', '자원 상한 계산에 필요한 건물 행이 없다.');
  }
  if (resourceId === 'manpower') {
    return toMicro(
      rules.balance.housingCapBase + rules.balance.housingCapPerLevel * housing,
    );
  }
  if (resourceId === 'scrip') {
    return toMicro(
      rules.balance.scripCapBase + rules.balance.scripCapPerHqLevel * hq,
    );
  }
  return toMicro(
    rules.balance.warehouseCapBase + rules.balance.warehouseCapPerLevel * warehouse,
  );
}

/** 자원을 넣는 유일한 경로. 상한 절단과 원장 기록이 한 곳에만 있어야 한다(D-045). */
async function creditReward(
  tx: SqlExecutor,
  cityId: string,
  commandId: string,
  context: CommandContext,
  rules: EconomyRuleset,
  bundle: Readonly<PartialBundle>,
  reason: Extract<OperationLedgerReason, 'victory_reward' | 'production'> = 'victory_reward',
): Promise<Readonly<PartialBundle>> {
  const balances = await readResourceMap(tx, cityId);
  const applied: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const requested = toMicro(bundle[resourceId] ?? 0);
    if (requested === 0) continue;
    const before = balances.get(resourceId)!;
    const cap = await resourceCapMicro(tx, cityId, rules, resourceId);
    const after = Math.min(cap, before + requested);
    const delta = after - before;
    if (delta === 0) continue;
    const update = await tx.run(`
      UPDATE city_resources SET balance_micro = ?
      WHERE city_id = ? AND resource_id = ? AND balance_micro = ?
    `, after, cityId, resourceId, before);
    if (update.changes !== 1) {
      throw new ServerError('DATA_INTEGRITY', '보상 자원 조건부 갱신이 실패했다.');
    }
    const id = `op-ledger:${sha256(
      `${cityId}:${commandId}:${reason}:${resourceId}`,
    ).slice(0, 64)}`;
    await tx.run(`
      INSERT INTO operation_ledger(
        id, city_id, command_id, resource_id, reason, delta_micro,
        balance_before_micro, balance_after_micro, created_at_hour
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, cityId, commandId, resourceId, reason, delta, before, after, context.nowHour);
    applied[resourceId] = fromMicro(delta);
  }
  return applied;
}

async function bumpCity(
  tx: SqlExecutor,
  city: CityRow,
  context: CommandContext,
): Promise<number> {
  const nextVersion = city.version + 1;
  const result = await tx.run(`
    UPDATE cities
    SET version = ?, last_server_hour = ?
    WHERE id = ? AND version = ? AND last_server_hour <= ?
  `, nextVersion, context.nowHour, city.id, city.version, context.nowHour);
  if (result.changes !== 1) {
    throw new ServerError('DATA_INTEGRITY', '도시 version 조건부 갱신이 실패했다.');
  }
  return nextVersion;
}

async function insertReceipt(
  tx: SqlExecutor,
  context: CommandContext,
  commandId: string,
  cityId: string,
  kind: OperationCommandKind,
  payloadJson: string,
  payloadSha256: string,
  responseJson: string,
): Promise<void> {
  await tx.run(`
    INSERT INTO operation_receipts(
      actor_id, command_id, city_id, command_kind, payload_sha256,
      payload_json, response_json, created_at_hour
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, context.actorId, commandId, cityId, kind, payloadSha256,
  payloadJson, responseJson, context.nowHour);
}

function validateStoredMobilizeResponse(
  value: unknown,
  city: CityRow,
): MobilizeUnitsResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 동원 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'units', 'cost', 'ruleVersion', 'campaignRuleVersion'],
    '동원 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 동원 응답이 도시와 일치하지 않는다.');
  }
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    units: validateStoredUnitQuantities(value.units),
    cost: validateStoredBundle(value.cost, '동원 비용'),
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

function validateStoredReconResponse(
  value: unknown,
  city: CityRow,
  reportRow: ReconReportRow,
): ReconNpcResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'cost', 'report', 'ruleVersion', 'campaignRuleVersion'],
    '정찰 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 정찰 응답이 도시와 일치하지 않는다.');
  }
  // **저장 원문끼리** 비교한다. 파생 항목이 붙은 스냅샷과 비교하면
  // 나중에 파생 항목을 더할 때마다 옛 기록이 전부 깨진다(radarLevel 추가에서 실제로 깨졌다).
  if (stableStringify(value.report) !== reportRow.report_json) {
    throw new ServerError('DATA_INTEGRITY', '정찰 응답과 정찰 보고서 행이 다르다.');
  }
  const report = validateReconReport(value.report, reportRow);
  assertReconSemantics(report, city.campaign_rule_version);
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    cost: validateStoredBundle(value.cost, '정찰 비용'),
    report,
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

function validateStoredAttackResponse(
  value: unknown,
  city: CityRow,
  reportRow: BattleReportRow,
): AttackNpcResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'report', 'ruleVersion', 'campaignRuleVersion'],
    '전투 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 응답이 도시와 일치하지 않는다.');
  }
  if (stableStringify(value.report) !== reportRow.report_json) {
    throw new ServerError('DATA_INTEGRITY', '전투 응답과 전투 보고서 행이 다르다.');
  }
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    report: validateBattleReport(value.report, reportRow),
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

function casualtiesFromResult(
  deployment: readonly StackOrder[],
  result: NpcBattleReportSnapshot['result'],
): readonly UnitCasualtySnapshot[] {
  const deployed = new Map<EconomyUnitId, number>();
  for (const stack of deployment) {
    const unitId = stack.unitId as EconomyUnitId;
    deployed.set(unitId, (deployed.get(unitId) ?? 0) + stack.count);
  }
  const totals = new Map<EconomyUnitId, UnitCasualtySnapshot>();
  for (const unitId of ECONOMY_UNIT_IDS) {
    const count = deployed.get(unitId) ?? 0;
    if (count > 0) {
      totals.set(unitId, { unitId, deployed: count, survivors: 0, wounded: 0, dead: 0 });
    }
  }
  for (const stack of result.attacker.stacks) {
    const unitId = stack.unitId as EconomyUnitId;
    const prior = totals.get(unitId);
    if (!prior) throw new ServerError('DATA_INTEGRITY', '전투 결과에 미투입 병종이 있다.');
    totals.set(unitId, {
      ...prior,
      survivors: prior.survivors + stack.survivors,
      wounded: prior.wounded + stack.wounded,
      dead: prior.dead + stack.dead,
    });
  }
  const resultRows = [...totals.values()];
  for (const casualty of resultRows) {
    if (casualty.survivors + casualty.wounded + casualty.dead !== casualty.deployed) {
      throw new ServerError('DATA_INTEGRITY', '전투 사상자 합계가 투입 수량과 다르다.');
    }
  }
  return resultRows;
}

async function assertAttackSemantics(
  tx: SqlExecutor,
  city: CityRow,
  command: AttackNpcCommand,
  response: AttackNpcResponse,
  reportRow: BattleReportRow,
): Promise<void> {
  const campaign = campaignForCity(city);
  if (response.report.campaignRuleVersion !== city.campaign_rule_version) {
    throw new ServerError('DATA_INTEGRITY', '전투 보고서의 캠페인 규칙 버전이 도시와 다르다.');
  }
  const scenario = campaign.scenarios[command.scenarioId];
  if (!scenario || scenario.nameKo !== response.report.scenarioNameKo) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 시나리오가 규칙과 다르다.');
  }
  const reconRow = await tx.get(`
    SELECT id, city_id, command_id, scenario_id, accuracy_permille,
           created_at_hour, expires_at_hour, report_json
    FROM recon_reports WHERE id = ? AND city_id = ?
  `, reportRow.recon_report_id, city.id) as unknown as ReconReportRow | undefined;
  if (!reconRow) throw new ServerError('DATA_INTEGRITY', '전투가 참조한 정찰 보고서가 없다.');
  const recon = validateReconReport(
    parseCanonicalStored(reconRow.report_json, '전투 참조 정찰 보고서'),
    reconRow,
  );
  assertReconSemantics(recon, city.campaign_rule_version);
  if (recon.id !== response.report.reconReportId
    || recon.scenarioId !== command.scenarioId
    || recon.createdAtHour > response.report.createdAtHour
    || response.report.createdAtHour >= recon.expiresAtHour) {
    throw new ServerError('DATA_INTEGRITY', '전투와 정찰 보고서의 시간·시나리오 결속이 다르다.');
  }
  const input = parseCanonicalStored(reportRow.input_json, '전투 입력') as BattleInput;
  if (input.ruleVersion !== campaign.combatRuleVersion
    || input.seed !== response.report.seed
    || stableStringify(input.attacker.stacks) !== stableStringify(command.deployment)
    || input.attacker.doctrine !== command.doctrine
    || input.attacker.reconAccuracy !== recon.accuracy
    || input.attacker.supply !== campaign.attackerDefaults.supply
    || input.attacker.retreatThreshold !== campaign.attackerDefaults.retreatThreshold
    || stableStringify(input.defender) !== stableStringify(scenario.defender)) {
    throw new ServerError('DATA_INTEGRITY', '저장 전투 입력이 명령·정찰·규칙과 다르다.');
  }
  const expectedCasualties = casualtiesFromResult(command.deployment, response.report.result);
  if (stableStringify(expectedCasualties) !== stableStringify(response.report.casualties)) {
    throw new ServerError('DATA_INTEGRITY', '저장 사상자가 전투 결과와 다르다.');
  }
  const expectedSortie = npcSortieCost(city.campaign_rule_version, command.deployment);
  assertBundlesEqual(response.report.sortieCost, expectedSortie, '저장 출정 비용');
  assertBundlesEqual(
    response.report.sortieCost,
    await ledgerBundle(tx, city.id, command.commandId, 'sortie'),
    '저장 출정 원장',
  );
  const rewardLedger = await ledgerBundle(tx, city.id, command.commandId, 'victory_reward');
  assertBundlesEqual(response.report.reward, rewardLedger, '저장 승리 보상 원장');
  if (response.report.result.outcome !== 'attacker_win'
    && Object.keys(response.report.reward).length > 0) {
    throw new ServerError('DATA_INTEGRITY', '승리하지 않은 전투에 보상이 기록됐다.');
  }
  for (const resourceId of RESOURCE_IDS) {
    if ((response.report.reward[resourceId] ?? 0)
      > (scenario.victoryReward[resourceId] ?? 0)) {
      throw new ServerError('DATA_INTEGRITY', '저장 승리 보상이 규칙 요청량을 넘는다.');
    }
  }
}

const RESEARCH_COMMAND_KEYS = [
  'commandId', 'cityId', 'expectedVersion', 'researchId', 'targetLevel',
] as const;

function validateResearchCommand(value: unknown): AdvanceResearchCommand {
  if (!isPlainRecord(value)) {
    throw new ServerError('INVALID_INPUT', '연구 명령은 객체여야 한다.');
  }
  assertExactKeys(value, RESEARCH_COMMAND_KEYS, 'advanceResearch');
  if (typeof value.researchId !== 'string'
    || value.researchId.length < 1
    || value.researchId.length > 64) {
    throw new ServerError('INVALID_INPUT', 'researchId는 1..64자 문자열이어야 한다.');
  }
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateInteger(value.expectedVersion, 'expectedVersion', 0, MAX_CITY_VERSION),
    researchId: value.researchId,
    targetLevel: validateInteger(value.targetLevel, 'targetLevel', 1, 100),
  };
}

function validateStoredResearchResponse(
  value: unknown,
  city: CityRow,
  command: AdvanceResearchCommand,
): AdvanceResearchResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 연구 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'researchId', 'level', 'cost', 'ruleVersion', 'campaignRuleVersion'],
    '연구 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || value.researchId !== command.researchId
    || value.level !== command.targetLevel
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 연구 응답이 도시·명령과 일치하지 않는다.');
  }
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    researchId: command.researchId,
    level: command.targetLevel,
    cost: validateStoredBundle(value.cost, '연구 비용'),
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

function validateStoredRenameResponse(
  value: unknown,
  city: CityRow,
  command: RenameCityCommand,
): RenameCityResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 이름 변경 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(value, ['cityId', 'cityVersion', 'name'], '이름 변경 응답');
  if (value.cityId !== city.id
    || value.name !== command.name
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 이름 변경 응답이 도시·명령과 일치하지 않는다.');
  }
  return { cityId: city.id, cityVersion: value.cityVersion as number, name: command.name };
}

function validateStoredProductionResponse(
  value: unknown,
  city: CityRow,
  fromHour: number,
  toHour: number,
): CreditProductionResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 생산 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'fromHour', 'toHour', 'credited', 'ruleVersion', 'campaignRuleVersion'],
    '생산 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || value.fromHour !== fromHour
    || value.toHour !== toHour
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 생산 응답이 도시·구간과 일치하지 않는다.');
  }
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    fromHour,
    toHour,
    credited: validateStoredBundle(value.credited, '생산 정산'),
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

function validateStoredRecoverResponse(
  value: unknown,
  city: CityRow,
  command: RecoverUnitsCommand,
): RecoverUnitsResponse {
  if (!isPlainRecord(value)) {
    throw new ServerError('DATA_INTEGRITY', '저장 회복 응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    value,
    ['cityId', 'cityVersion', 'units', 'cost', 'completesAtHour', 'ruleVersion', 'campaignRuleVersion'],
    '회복 응답',
  );
  if (value.cityId !== city.id
    || value.ruleVersion !== city.rule_version
    || value.campaignRuleVersion !== city.campaign_rule_version
    || stableStringify(value.units) !== stableStringify(command.units)
    || !Number.isInteger(value.completesAtHour)
    || !Number.isInteger(value.cityVersion)
    || (value.cityVersion as number) < 1
    || (value.cityVersion as number) > city.version) {
    throw new ServerError('DATA_INTEGRITY', '저장 회복 응답이 도시·명령과 일치하지 않는다.');
  }
  return {
    cityId: city.id,
    cityVersion: value.cityVersion as number,
    units: command.units,
    cost: validateStoredBundle(value.cost, '회복 비용'),
    completesAtHour: value.completesAtHour as number,
    ruleVersion: city.rule_version,
    campaignRuleVersion: city.campaign_rule_version,
  };
}

type StoredOperationEvent =
  | {
      readonly kind: 'mobilize_units';
      readonly command: MobilizeUnitsCommand;
      readonly response: MobilizeUnitsResponse;
    }
  | {
      readonly kind: 'recover_units';
      readonly command: RecoverUnitsCommand;
      readonly response: RecoverUnitsResponse;
    }
  | {
      readonly kind: 'rename_city';
      readonly command: RenameCityCommand;
      readonly response: RenameCityResponse;
    }
  | {
      readonly kind: 'credit_production';
      readonly command: { readonly commandId: string; readonly cityId: string };
      readonly response: CreditProductionResponse;
    }
  | {
      readonly kind: 'recon_npc';
      readonly command: ReconNpcCommand;
      readonly response: ReconNpcResponse;
    }
  | {
      readonly kind: 'attack_npc';
      readonly command: AttackNpcCommand;
      readonly response: AttackNpcResponse;
    }
  | {
      readonly kind: 'advance_research';
      readonly command: AdvanceResearchCommand;
      readonly response: AdvanceResearchResponse;
    };

interface StoredResourceCommand {
  readonly cityVersion: number;
  readonly createdAtHour: number;
}

function storedCommand(
  receipt: OperationReceiptRow,
  city: CityRow,
): MobilizeUnitsCommand | ReconNpcCommand | AttackNpcCommand | AdvanceResearchCommand
  | RecoverUnitsCommand | RenameCityCommand {
  const parsed = parseCanonicalStored(receipt.payload_json, '작전 payload');
  if (!isPlainRecord(parsed) || parsed.kind !== receipt.command_kind) {
    throw new ServerError('DATA_INTEGRITY', '작전 영수증 종류와 payload가 다르다.');
  }
  try {
    if (receipt.command_kind === 'mobilize_units') {
      assertStoredExactKeys(
        parsed,
        ['kind', 'commandId', 'cityId', 'expectedVersion', 'units'],
        '동원 payload',
      );
      return validateMobilizeCommand({
        commandId: parsed.commandId,
        cityId: parsed.cityId,
        expectedVersion: parsed.expectedVersion,
        units: parsed.units,
      });
    }
    if (receipt.command_kind === 'recon_npc') {
      assertStoredExactKeys(
        parsed,
        ['kind', 'commandId', 'cityId', 'expectedVersion', 'scenarioId'],
        '정찰 payload',
      );
      return validateReconCommand({
        commandId: parsed.commandId,
        cityId: parsed.cityId,
        expectedVersion: parsed.expectedVersion,
        scenarioId: parsed.scenarioId,
      });
    }
    if (receipt.command_kind === 'rename_city') {
      assertStoredExactKeys(
        parsed,
        ['kind', 'commandId', 'cityId', 'expectedVersion', 'name'],
        '이름 변경 payload',
      );
      return validateRenameCommand({
        commandId: parsed.commandId,
        cityId: parsed.cityId,
        expectedVersion: parsed.expectedVersion,
        name: parsed.name,
      });
    }
    if (receipt.command_kind === 'recover_units') {
      assertStoredExactKeys(
        parsed,
        ['kind', 'commandId', 'cityId', 'expectedVersion', 'units'],
        '회복 payload',
      );
      return validateRecoverCommand({
        commandId: parsed.commandId,
        cityId: parsed.cityId,
        expectedVersion: parsed.expectedVersion,
        units: parsed.units,
      });
    }
    if (receipt.command_kind === 'advance_research') {
      assertStoredExactKeys(
        parsed,
        ['kind', 'commandId', 'cityId', 'expectedVersion', 'researchId', 'targetLevel'],
        '연구 payload',
      );
      return validateResearchCommand({
        commandId: parsed.commandId,
        cityId: parsed.cityId,
        expectedVersion: parsed.expectedVersion,
        researchId: parsed.researchId,
        targetLevel: parsed.targetLevel,
      });
    }
    assertStoredExactKeys(
      parsed,
      ['kind', 'commandId', 'cityId', 'expectedVersion', 'scenarioId', 'deployment', 'doctrine'],
      '전투 payload',
    );
    return validateAttackCommand({
      commandId: parsed.commandId,
      cityId: parsed.cityId,
      expectedVersion: parsed.expectedVersion,
      scenarioId: parsed.scenarioId,
      deployment: parsed.deployment,
      doctrine: parsed.doctrine,
    }, campaignForCity(city).combatRuleVersion);
  } catch (error) {
    if (error instanceof ServerError && error.code === 'DATA_INTEGRITY') throw error;
    throw new ServerError('DATA_INTEGRITY', '저장 작전 payload 스키마가 유효하지 않다.', {
      cause: error,
    });
  }
}

async function validateOperationHistory(
  tx: SqlExecutor,
  city: CityRow,
  army: ArmyStateSnapshot,
  receipts: readonly OperationReceiptRow[],
  ledgers: readonly OperationLedgerRow[],
  reconRows: readonly ReconReportRow[],
  battleRows: readonly BattleReportRow[],
  recoveryRows: readonly RecoveryJobRow[],
): Promise<ReadonlyMap<string, StoredResourceCommand>> {
  const reconByCommand = new Map(reconRows.map((row) => [row.command_id, row]));
  const battleByCommand = new Map(battleRows.map((row) => [row.command_id, row]));
  const receiptByCommand = new Map<string, OperationReceiptRow>();
  const events: StoredOperationEvent[] = [];

  for (const receipt of receipts) {
    if (receipt.actor_id !== city.owner_id
      || receipt.city_id !== city.id
      || receiptByCommand.has(receipt.command_id)
      || !SHA256_PATTERN.test(receipt.payload_sha256)
      || sha256(receipt.payload_json) !== receipt.payload_sha256) {
      throw new ServerError('DATA_INTEGRITY', '작전 영수증의 소유자·키·hash가 유효하지 않다.');
    }
    receiptByCommand.set(receipt.command_id, receipt);
    const responseValue = parseCanonicalStored(receipt.response_json, '작전 응답');
    if (receipt.command_kind === 'credit_production') {
      // 생산은 플레이어 명령이 아니라 시간 정산이라 명령 스키마가 없다. payload를 여기서 직접 읽는다.
      const parsed = parseCanonicalStored(receipt.payload_json, '생산 payload');
      if (!isPlainRecord(parsed)) {
        throw new ServerError('DATA_INTEGRITY', '생산 payload가 객체가 아니다.');
      }
      assertStoredExactKeys(parsed, ['kind', 'commandId', 'cityId', 'fromHour', 'toHour'], '생산 payload');
      if (parsed.cityId !== city.id
        || parsed.commandId !== receipt.command_id
        || !Number.isInteger(parsed.fromHour)
        || !Number.isInteger(parsed.toHour)
        || (parsed.toHour as number) <= (parsed.fromHour as number)) {
        throw new ServerError('DATA_INTEGRITY', '생산 payload가 영수증·도시와 다르다.');
      }
      const response = validateStoredProductionResponse(
        responseValue,
        city,
        parsed.fromHour as number,
        parsed.toHour as number,
      );
      assertBundlesEqual(
        response.credited,
        await ledgerBundle(tx, city.id, receipt.command_id, 'production'),
        '생산 원장',
      );
      events.push({
        kind: 'credit_production',
        command: { commandId: receipt.command_id, cityId: city.id },
        response,
      });
      continue;
    }
    const parsedCommand = storedCommand(receipt, city);
    if (parsedCommand.commandId !== receipt.command_id || parsedCommand.cityId !== city.id) {
      throw new ServerError('DATA_INTEGRITY', '작전 payload가 영수증 키·도시와 다르다.');
    }
    if (receipt.command_kind === 'mobilize_units') {
      const command = parsedCommand as MobilizeUnitsCommand;
      const response = validateStoredMobilizeResponse(responseValue, city);
      if (response.cityVersion !== command.expectedVersion + 1
        || stableStringify(response.units) !== stableStringify(command.units)) {
        throw new ServerError('DATA_INTEGRITY', '동원 응답이 payload version·병력과 다르다.');
      }
      const expectedCost = totalMobilizationCost(rulesFor(city.rule_version), command.units);
      assertBundlesEqual(response.cost, expectedCost, '동원 비용');
      assertBundlesEqual(
        response.cost,
        await ledgerBundle(tx, city.id, command.commandId, 'mobilization'),
        '동원 원장',
      );
      events.push({ kind: 'mobilize_units', command, response });
      continue;
    }
    if (receipt.command_kind === 'rename_city') {
      const command = parsedCommand as RenameCityCommand;
      const response = validateStoredRenameResponse(responseValue, city, command);
      if (response.cityVersion !== command.expectedVersion + 1) {
        throw new ServerError('DATA_INTEGRITY', '이름 변경 응답의 version이 영수증과 다르다.');
      }
      events.push({ kind: 'rename_city', command, response });
      continue;
    }
    if (receipt.command_kind === 'recover_units') {
      const command = parsedCommand as RecoverUnitsCommand;
      const response = validateStoredRecoverResponse(responseValue, city, command);
      if (response.cityVersion !== command.expectedVersion + 1) {
        throw new ServerError('DATA_INTEGRITY', '회복 응답의 version이 영수증과 다르다.');
      }
      const campaign = campaignForCity(city);
      const expectedCost = { supplies: recoverySuppliesCost(campaign, command.units) };
      assertBundlesEqual(response.cost, expectedCost, '회복 비용');
      assertBundlesEqual(
        response.cost,
        await ledgerBundle(tx, city.id, command.commandId, 'recovery'),
        '회복 원장',
      );
      // 예약한 병력이 job 행과 정확히 같아야 한다. job이 없으면 병력 이력을 재현할 수 없다.
      const jobs = recoveryRows.filter((row) => row.command_id === command.commandId);
      const jobUnits = jobs
        .map((row) => ({ unitId: row.unit_id as EconomyUnitId, count: row.count }))
        .sort((left, right) => (left.unitId < right.unitId ? -1 : 1));
      const commandUnits = [...command.units]
        .sort((left, right) => (left.unitId < right.unitId ? -1 : 1));
      if (stableStringify(jobUnits) !== stableStringify(commandUnits)
        || jobs.some((row) => row.started_at_hour !== receipt.created_at_hour
          || row.completes_at_hour !== receipt.created_at_hour + campaign.recoveryHours)) {
        throw new ServerError('DATA_INTEGRITY', '회복 job이 영수증과 다르다.');
      }
      events.push({ kind: 'recover_units', command, response });
      continue;
    }
    if (receipt.command_kind === 'recon_npc') {
      const command = parsedCommand as ReconNpcCommand;
      const reportRow = reconByCommand.get(command.commandId);
      if (!reportRow) throw new ServerError('DATA_INTEGRITY', '정찰 영수증의 보고서가 없다.');
      const response = validateStoredReconResponse(responseValue, city, reportRow);
      if (response.cityVersion !== command.expectedVersion + 1
        || response.report.createdAtHour !== receipt.created_at_hour
        || response.report.scenarioId !== command.scenarioId) {
        throw new ServerError('DATA_INTEGRITY', '정찰 응답의 version·시각이 영수증과 다르다.');
      }
      assertBundlesEqual(response.cost, RECON_COST, '정찰 비용');
      assertBundlesEqual(
        response.cost,
        await ledgerBundle(tx, city.id, command.commandId, 'recon'),
        '정찰 원장',
      );
      events.push({ kind: 'recon_npc', command, response });
      continue;
    }
    if (receipt.command_kind === 'advance_research') {
      const command = parsedCommand as AdvanceResearchCommand;
      const response = validateStoredResearchResponse(responseValue, city, command);
      if (response.cityVersion !== command.expectedVersion + 1) {
        throw new ServerError('DATA_INTEGRITY', '연구 응답의 version이 영수증과 다르다.');
      }
      events.push({ kind: 'advance_research', command, response });
      continue;
    }
    const command = parsedCommand as AttackNpcCommand;
    const reportRow = battleByCommand.get(command.commandId);
    if (!reportRow) throw new ServerError('DATA_INTEGRITY', '전투 영수증의 보고서가 없다.');
    const response = validateStoredAttackResponse(responseValue, city, reportRow);
    if (response.cityVersion !== command.expectedVersion + 1
      || response.report.createdAtHour !== receipt.created_at_hour) {
      throw new ServerError('DATA_INTEGRITY', '전투 응답의 version·시각이 영수증과 다르다.');
    }
    await assertAttackSemantics(tx, city, command, response, reportRow);
    events.push({ kind: 'attack_npc', command, response });
  }

  if (reconRows.length !== events.filter((event) => event.kind === 'recon_npc').length
    || battleRows.length !== events.filter((event) => event.kind === 'attack_npc').length) {
    throw new ServerError('DATA_INTEGRITY', '보고서와 작전 영수증 수가 다르다.');
  }
  for (const ledger of ledgers) {
    const receipt = receiptByCommand.get(ledger.command_id);
    const allowed = receipt?.command_kind === 'mobilize_units'
      ? ledger.reason === 'mobilization'
      : receipt?.command_kind === 'recon_npc'
        ? ledger.reason === 'recon'
        : receipt?.command_kind === 'attack_npc'
          ? ledger.reason === 'sortie' || ledger.reason === 'victory_reward'
          : receipt?.command_kind === 'advance_research'
            ? ledger.reason === 'research'
            : receipt?.command_kind === 'recover_units'
              ? ledger.reason === 'recovery'
              : receipt?.command_kind === 'credit_production'
                ? ledger.reason === 'production'
                // 이름 변경은 자원을 움직이지 않는다. 원장 행이 있으면 그 자체가 오류다.
                : false;
    if (!allowed) {
      throw new ServerError('DATA_INTEGRITY', '작전 원장 reason과 영수증 종류가 다르다.');
    }
  }

  const ordered = [...events].sort(
    (left, right) => left.response.cityVersion - right.response.cityVersion,
  );
  const versions = new Set<number>();
  const expectedReady = {} as Record<EconomyUnitId, number>;
  const expectedWounded = {} as Record<EconomyUnitId, number>;
  const expectedDead = {} as Record<EconomyUnitId, number>;
  for (const unitId of ECONOMY_UNIT_IDS) {
    expectedReady[unitId] = 0;
    expectedWounded[unitId] = 0;
    expectedDead[unitId] = 0;
  }
  /**
   * 회복 완료는 영수증이 아니라 job 행이 남기는 사건이다(D-045).
   * 병력 이력을 시간순으로 재생해야 "보유량보다 투입량이 많다" 검사가 올바르므로
   * 완료가 만든 도시 version을 키로 명령 사이에 끼워 넣는다.
   */
  const completions = new Map<number, RecoveryJobRow[]>();
  for (const row of recoveryRows) {
    if (row.status !== 'completed') continue;
    if (row.completed_city_version === null) {
      throw new ServerError('DATA_INTEGRITY', '완료된 회복 job에 version이 없다.');
    }
    const list = completions.get(row.completed_city_version) ?? [];
    list.push(row);
    completions.set(row.completed_city_version, list);
  }
  const applyCompletionsUpTo = (limit: number): void => {
    for (const [version, rows] of [...completions.entries()].sort((a, b) => a[0] - b[0])) {
      if (version > limit) continue;
      for (const row of rows) expectedReady[row.unit_id as EconomyUnitId] += row.count;
      completions.delete(version);
    }
  };

  for (const event of ordered) {
    if (versions.has(event.response.cityVersion)) {
      throw new ServerError('DATA_INTEGRITY', '작전 응답 cityVersion이 중복됐다.');
    }
    versions.add(event.response.cityVersion);
    applyCompletionsUpTo(event.response.cityVersion);
    if (event.kind === 'mobilize_units') {
      for (const order of event.response.units) {
        expectedReady[order.unitId] += order.count;
      }
      continue;
    }
    if (event.kind === 'recover_units') {
      for (const order of event.response.units) {
        if (expectedWounded[order.unitId] < order.count) {
          throw new ServerError('DATA_INTEGRITY', '저장 이력상 부상병보다 회복 예약이 많다.');
        }
        expectedWounded[order.unitId] -= order.count;
      }
      continue;
    }
    if (event.kind === 'recon_npc') {
      if (event.response.report.scoutCount !== expectedReady.scout) {
        throw new ServerError('DATA_INTEGRITY', '정찰 보고서의 정찰병 수가 작전 이력과 다르다.');
      }
      continue;
    }
    if (event.kind === 'attack_npc') {
      for (const casualty of event.response.report.casualties) {
        if (expectedReady[casualty.unitId] < casualty.deployed) {
          throw new ServerError('DATA_INTEGRITY', '저장 이력상 보유량보다 전투 투입량이 많다.');
        }
        expectedReady[casualty.unitId] =
          expectedReady[casualty.unitId] - casualty.deployed + casualty.survivors;
        expectedWounded[casualty.unitId] += casualty.wounded;
        expectedDead[casualty.unitId] += casualty.dead;
      }
    }
  }
  applyCompletionsUpTo(Number.MAX_SAFE_INTEGER);
  if (stableStringify(expectedReady) !== stableStringify(army.ready)
    || stableStringify(expectedWounded) !== stableStringify(army.wounded)
    || stableStringify(expectedDead) !== stableStringify(army.dead)) {
    throw new ServerError('DATA_INTEGRITY', '현재 병력 재고가 작전 영수증 이력과 다르다.');
  }
  return new Map(ordered.map((event) => [
    event.command.commandId,
    {
      cityVersion: event.response.cityVersion,
      createdAtHour: receiptByCommand.get(event.command.commandId)!.created_at_hour,
    },
  ]));
}

interface StoredConstructionResourceCommand extends StoredResourceCommand {
  readonly jobId: string;
  readonly cost: Readonly<PartialBundle>;
}

function storedConstructionResourceCommand(
  receipt: ConstructionReceiptHistoryRow,
  city: CityRow,
): StoredConstructionResourceCommand {
  if (receipt.actor_id !== city.owner_id
    || receipt.city_id !== city.id
    || receipt.command_kind !== 'start_construction'
    || !SHA256_PATTERN.test(receipt.payload_sha256)
    || sha256(receipt.payload_json) !== receipt.payload_sha256) {
    throw new ServerError('DATA_INTEGRITY', '건설 영수증의 소유자·도시·hash가 유효하지 않다.');
  }
  const payload = parseCanonicalStored(receipt.payload_json, '건설 payload');
  const response = parseCanonicalStored(receipt.response_json, '건설 응답');
  if (!isPlainRecord(payload) || !isPlainRecord(response)) {
    throw new ServerError('DATA_INTEGRITY', '건설 영수증 payload·응답이 객체가 아니다.');
  }
  assertStoredExactKeys(
    payload,
    ['kind', 'commandId', 'cityId', 'expectedVersion', 'buildingId'],
    '건설 payload',
  );
  assertStoredExactKeys(
    response,
    [
      'cityId',
      'cityVersion',
      'jobId',
      'buildingId',
      'targetLevel',
      'startedAtHour',
      'completesAtHour',
      'cost',
      'ruleVersion',
    ],
    '건설 응답',
  );
  const buildingId = response.buildingId as BuildingId;
  const expectedVersion = payload.expectedVersion;
  const cityVersion = response.cityVersion;
  const targetLevel = response.targetLevel;
  const startedAtHour = response.startedAtHour;
  const completesAtHour = response.completesAtHour;
  if (payload.kind !== 'start_construction'
    || payload.commandId !== receipt.command_id
    || payload.cityId !== city.id
    || !Number.isSafeInteger(expectedVersion)
    || (expectedVersion as number) < 0
    || (expectedVersion as number) >= MAX_CITY_VERSION
    || !BUILDING_IDS.includes(payload.buildingId as BuildingId)
    || response.cityId !== city.id
    || !Number.isSafeInteger(cityVersion)
    || cityVersion !== (expectedVersion as number) + 1
    || (cityVersion as number) > city.version
    || typeof response.jobId !== 'string'
    || !/^[A-Za-z0-9:_-]{1,96}$/.test(response.jobId)
    || !BUILDING_IDS.includes(buildingId)
    || response.buildingId !== payload.buildingId
    || !Number.isSafeInteger(targetLevel)
    || (targetLevel as number) < 2
    || !Number.isSafeInteger(startedAtHour)
    || startedAtHour !== receipt.created_at_hour
    || !Number.isSafeInteger(completesAtHour)
    || (completesAtHour as number) < (startedAtHour as number)
    || response.ruleVersion !== city.rule_version) {
    throw new ServerError('DATA_INTEGRITY', '건설 영수증 payload·응답 결속이 유효하지 않다.');
  }
  const rules = rulesFor(city.rule_version);
  if ((targetLevel as number) > buildingDef(rules, buildingId).maxLevel) {
    throw new ServerError('DATA_INTEGRITY', '건설 응답 목표 레벨이 규칙 상한을 넘는다.');
  }
  const cost = validateStoredBundle(response.cost, '건설 비용');
  assertBundlesEqual(
    cost,
    constructionCost(rules, buildingId, targetLevel as number),
    '건설 응답 비용',
  );
  return {
    cityVersion: cityVersion as number,
    createdAtHour: receipt.created_at_hour,
    jobId: response.jobId,
    cost,
  };
}

interface ResourceHistoryEvent {
  readonly source: string;
  readonly resourceId: ResourceId;
  readonly cityVersion: number;
  readonly phase: number;
  readonly balanceBeforeMicro: number;
  readonly balanceAfterMicro: number;
}

async function validateResourceHistory(
  tx: SqlExecutor,
  city: CityRow,
  resources: ReadonlyMap<ResourceId, number>,
  operationReceipts: readonly OperationReceiptRow[],
  operationLedgers: readonly OperationLedgerRow[],
  operationCommands: ReadonlyMap<string, StoredResourceCommand>,
): Promise<void> {
  const constructionReceipts = await tx.all(`
    SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
           payload_json, response_json, created_at_hour
    FROM command_receipts
    WHERE city_id = ? AND command_kind = 'start_construction'
    ORDER BY created_at_hour, command_id
  `, city.id) as unknown as ConstructionReceiptHistoryRow[];
  const constructionLedgers = await tx.all(`
    SELECT id, city_id, command_id, job_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM economy_ledger
    WHERE city_id = ?
    ORDER BY created_at_hour, id
  `, city.id) as unknown as ConstructionLedgerHistoryRow[];

  const constructionCommands = new Map<string, StoredConstructionResourceCommand>();
  for (const receipt of constructionReceipts) {
    if (constructionCommands.has(receipt.command_id)) {
      throw new ServerError('DATA_INTEGRITY', '건설 영수증 commandId가 중복됐다.');
    }
    constructionCommands.set(
      receipt.command_id,
      storedConstructionResourceCommand(receipt, city),
    );
  }

  const versionOwners = new Map<number, string>();
  for (const [commandId, command] of [
    ...constructionCommands.entries(),
    ...operationCommands.entries(),
  ]) {
    const prior = versionOwners.get(command.cityVersion);
    if (prior !== undefined) {
      throw new ServerError(
        'DATA_INTEGRITY',
        `자원 변경 명령 cityVersion이 중복됐다: ${prior}, ${commandId}`,
      );
    }
    versionOwners.set(command.cityVersion, commandId);
  }

  const events: ResourceHistoryEvent[] = [];
  const constructionBundles = new Map<string, PartialBundle>();
  const constructionKeys = new Set<string>();
  for (const row of constructionLedgers) {
    const resourceId = row.resource_id as ResourceId;
    const command = constructionCommands.get(row.command_id);
    const key = `${row.command_id}:${resourceId}`;
    if (!command
      || row.city_id !== city.id
      || row.job_id !== command.jobId
      || row.reason !== 'construction_start'
      || !RESOURCE_IDS.includes(resourceId)
      || constructionKeys.has(key)
      || !Number.isSafeInteger(row.delta_micro)
      || row.delta_micro >= 0
      || !Number.isSafeInteger(row.balance_before_micro)
      || !Number.isSafeInteger(row.balance_after_micro)
      || row.balance_before_micro < 0
      || row.balance_after_micro < 0
      || row.balance_after_micro !== row.balance_before_micro + row.delta_micro
      || row.created_at_hour !== command.createdAtHour) {
      throw new ServerError('DATA_INTEGRITY', '건설 자원 원장 행이 유효하지 않다.');
    }
    constructionKeys.add(key);
    const bundle = constructionBundles.get(row.command_id) ?? {};
    bundle[resourceId] = fromMicro(Math.abs(row.delta_micro));
    constructionBundles.set(row.command_id, bundle);
    events.push({
      source: `construction:${row.command_id}:${resourceId}`,
      resourceId,
      cityVersion: command.cityVersion,
      phase: 0,
      balanceBeforeMicro: row.balance_before_micro,
      balanceAfterMicro: row.balance_after_micro,
    });
  }
  for (const [commandId, command] of constructionCommands) {
    assertBundlesEqual(
      constructionBundles.get(commandId) ?? {},
      command.cost,
      `건설 자원 원장 ${commandId}`,
    );
  }

  const operationReceiptByCommand = new Map(
    operationReceipts.map((receipt) => [receipt.command_id, receipt]),
  );
  const operationKeys = new Set<string>();
  for (const row of operationLedgers) {
    const resourceId = row.resource_id as ResourceId;
    const command = operationCommands.get(row.command_id);
    const receipt = operationReceiptByCommand.get(row.command_id);
    const expectedSign = CREDIT_LEDGER_REASONS.includes(row.reason) ? 1 : -1;
    const key = `${row.command_id}:${row.reason}:${resourceId}`;
    if (!command
      || !receipt
      || row.city_id !== city.id
      || !RESOURCE_IDS.includes(resourceId)
      || !OPERATION_LEDGER_REASONS.includes(row.reason)
      || operationKeys.has(key)
      || !Number.isSafeInteger(row.delta_micro)
      || Math.sign(row.delta_micro) !== expectedSign
      || !Number.isSafeInteger(row.balance_before_micro)
      || !Number.isSafeInteger(row.balance_after_micro)
      || row.balance_before_micro < 0
      || row.balance_after_micro < 0
      || row.balance_after_micro !== row.balance_before_micro + row.delta_micro
      || row.created_at_hour !== command.createdAtHour
      || row.created_at_hour !== receipt.created_at_hour) {
      throw new ServerError('DATA_INTEGRITY', '작전 자원 원장 행이 유효하지 않다.');
    }
    operationKeys.add(key);
    events.push({
      source: `operation:${row.command_id}:${row.reason}:${resourceId}`,
      resourceId,
      cityVersion: command.cityVersion,
      phase: row.reason === 'victory_reward' ? 1 : 0,
      balanceBeforeMicro: row.balance_before_micro,
      balanceAfterMicro: row.balance_after_micro,
    });
  }

  for (const resourceId of RESOURCE_IDS) {
    const resourceEvents = events
      .filter((event) => event.resourceId === resourceId)
      .sort((left, right) => left.cityVersion - right.cityVersion || left.phase - right.phase);
    let expectedBefore: number | undefined;
    let priorOrder: string | undefined;
    for (const event of resourceEvents) {
      const order = `${event.cityVersion}:${event.phase}`;
      if (priorOrder === order || (
        expectedBefore !== undefined
        && event.balanceBeforeMicro !== expectedBefore
      )) {
        throw new ServerError(
          'DATA_INTEGRITY',
          `${resourceId} 자원 원장 연쇄가 끊겼다: ${event.source}`,
        );
      }
      expectedBefore = event.balanceAfterMicro;
      priorOrder = order;
    }
    if (expectedBefore !== undefined && resources.get(resourceId) !== expectedBefore) {
      throw new ServerError('DATA_INTEGRITY', `${resourceId} 현재 잔액이 통합 자원 원장과 다르다.`);
    }
  }
}

async function validateCurrentOperationStateHistory(
  tx: SqlExecutor,
  city: CityRow,
): Promise<void> {
  const resources = await readResourceMap(tx, city.id);
  const army = await readArmy(tx, city.id);
  const receipts = await tx.all(`
    SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
           payload_json, response_json, created_at_hour
    FROM operation_receipts
    WHERE city_id = ?
    ORDER BY created_at_hour, command_id
  `, city.id) as unknown as OperationReceiptRow[];
  const ledgers = await tx.all(`
    SELECT id, city_id, command_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM operation_ledger
    WHERE city_id = ?
    ORDER BY created_at_hour, id
  `, city.id) as unknown as OperationLedgerRow[];
  const reconRows = await tx.all(`
    SELECT id, city_id, command_id, scenario_id, accuracy_permille,
           created_at_hour, expires_at_hour, report_json
    FROM recon_reports
    WHERE city_id = ?
    ORDER BY created_at_hour, id
  `, city.id) as unknown as ReconReportRow[];
  const battleRows = await tx.all(`
    SELECT id, city_id, command_id, scenario_id, recon_report_id, seed, result_hash,
           input_json, report_json, created_at_hour
    FROM npc_battle_reports
    WHERE city_id = ?
    ORDER BY created_at_hour, id
  `, city.id) as unknown as BattleReportRow[];
  const operationCommands = await validateOperationHistory(
    tx,
    city,
    army.snapshot,
    receipts,
    ledgers,
    reconRows,
    battleRows,
    await readRecoveryJobs(tx, city.id),
  );
  await validateResourceHistory(
    tx,
    city,
    resources,
    receipts,
    ledgers,
    operationCommands,
  );
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ServerError) throw error;
  if (error instanceof Error && error.message.includes('GLOBAL_IDEMPOTENCY_CONFLICT')) {
    throw new ServerError(
      'IDEMPOTENCY_KEY_REUSED',
      '같은 commandId가 이미 다른 명령 종류에 사용됐다.',
      { cause: error },
    );
  }
  throw new ServerError('DATABASE_FAILURE', '작전 DB 처리에 실패했다.', { cause: error });
}

export class OperationService {
  private readonly adapter: SqlAdapter;
  private readonly options: ConstructionServerOptions;

  constructor(adapter: SqlAdapter, options: ConstructionServerOptions) {
    this.adapter = adapter;
    this.options = options;
  }

  /**
   * 연구 단계를 하나 올린다(D-044).
   *
   * 군표를 쓰므로 다른 자원 명령과 같은 영수증·원장 경로를 지난다.
   * 한 번에 한 단계만 올린다 — 재전송은 영수증으로 재생되고, 단계 건너뛰기는 거부한다.
   */
  async advanceResearch(
    rawContext: CommandContext,
    rawCommand: AdvanceResearchCommand,
  ): Promise<CommandExecution<AdvanceResearchResponse>> {
    const context = validateContext(rawContext);
    const command = validateResearchCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'advance_research',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      researchId: command.researchId,
      targetLevel: command.targetLevel,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, command.cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${command.cityId}`);
        campaignForCity(city);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'advance_research', city.id, payloadJson, payloadSha256);
          const response = validateStoredResearchResponse(
            parseCanonicalStored(prior.response_json, '연구 응답'),
            city,
            command,
          );
          assertBundlesEqual(
            response.cost,
            await ledgerBundle(tx, city.id, command.commandId, 'research'),
            '저장 연구 원장',
          );
          await validateCurrentOperationStateHistory(tx, city);
          return { response, replayed: true };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);

        const rules = rulesFor(city.rule_version);
        const definition = rules.research?.[command.researchId];
        if (definition === undefined) {
          throw new ServerError('UNKNOWN_RESEARCH', `알 수 없는 연구: ${command.researchId}`);
        }
        const levels = await readResearchLevels(tx, city.id);
        const current = levels.get(command.researchId) ?? 0;
        if (command.targetLevel !== current + 1) {
          throw new ServerError(
            'INVALID_INPUT',
            `연구는 한 단계씩만 올린다. 현재 ${current}단계이므로 목표는 ${current + 1}이어야 한다.`,
          );
        }
        if (command.targetLevel > definition.maxLevel) {
          throw new ServerError('MAX_LEVEL', `${definition.nameKo}는 이미 최대 단계다.`);
        }
        const labLevel = (await readBuildingLevels(tx, city.id)).get('research_lab') ?? 0;
        if (labLevel < definition.requiresLabLevel) {
          throw new ServerError(
            'RESEARCH_LAB_REQUIRED',
            `${definition.nameKo}는 연구소 ${definition.requiresLabLevel}레벨이 필요하다.`,
          );
        }
        if (definition.requires !== undefined && (levels.get(definition.requires) ?? 0) < 1) {
          const prerequisite = rules.research?.[definition.requires];
          throw new ServerError(
            'RESEARCH_PREREQUISITE',
            `${prerequisite?.nameKo ?? definition.requires}를 먼저 연구해야 한다.`,
          );
        }

        const cost = { scrip: researchScripCost(definition, command.targetLevel) };
        const appliedCost = await debitBundle(
          tx,
          city.id,
          command.commandId,
          context,
          cost,
          'research',
        );
        const update = await tx.run(`
          INSERT INTO city_research(city_id, research_id, level, completed_at_hour)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(city_id, research_id) DO UPDATE SET
            level = excluded.level,
            completed_at_hour = excluded.completed_at_hour
          WHERE city_research.level = ?
        `, city.id, command.researchId, command.targetLevel, context.nowHour, current);
        if (update.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '연구 단계 조건부 갱신이 실패했다.');
        }
        const cityVersion = await bumpCity(tx, city, context);
        const response: AdvanceResearchResponse = {
          cityId: city.id,
          cityVersion,
          researchId: command.researchId,
          level: command.targetLevel,
          cost: appliedCost,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'advance_research',
          payloadJson,
          payloadSha256,
          stableStringify(response),
        );
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 부상병 회복 예약(D-045).
   *
   * 보급품은 **예약 시** 낸다. 부상은 즉시 빠지고, 복귀는 `recoveryHours` 뒤 워커가 처리한다.
   * 전사자는 대상이 아니다 — 규칙상 복구하지 않는다.
   */
  async recoverUnits(
    rawContext: CommandContext,
    rawCommand: RecoverUnitsCommand,
  ): Promise<CommandExecution<RecoverUnitsResponse>> {
    const context = validateContext(rawContext);
    const command = validateRecoverCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'recover_units',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      units: command.units,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, command.cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${command.cityId}`);
        const campaign = campaignForCity(city);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'recover_units', city.id, payloadJson, payloadSha256);
          const response = validateStoredRecoverResponse(
            parseCanonicalStored(prior.response_json, '회복 응답'),
            city,
            command,
          );
          assertBundlesEqual(
            response.cost,
            await ledgerBundle(tx, city.id, command.commandId, 'recovery'),
            '저장 회복 원장',
          );
          await validateCurrentOperationStateHistory(tx, city);
          return { response, replayed: true };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);

        const army = await readArmy(tx, city.id);
        for (const order of command.units) {
          const current = army.rows.get(order.unitId);
          if (!current) throw new ServerError('DATA_INTEGRITY', `${order.unitId} 병력 행이 없다.`);
          if (current.wounded < order.count) {
            throw new ServerError(
              'INSUFFICIENT_UNITS',
              `${order.unitId} 부상병이 부족하다: 보유 ${current.wounded}, 요청 ${order.count}`,
            );
          }
        }
        const cost = { supplies: recoverySuppliesCost(campaign, command.units) };
        const appliedCost = await debitBundle(
          tx,
          city.id,
          command.commandId,
          context,
          cost,
          'recovery',
        );
        const completesAtHour = context.nowHour + campaign.recoveryHours;
        for (const order of command.units) {
          const current = army.rows.get(order.unitId)!;
          const update = await tx.run(`
            UPDATE city_armies SET wounded = ?
            WHERE city_id = ? AND unit_id = ? AND wounded = ?
          `, current.wounded - order.count, city.id, order.unitId, current.wounded);
          if (update.changes !== 1) {
            throw new ServerError('DATA_INTEGRITY', '회복 부상병 조건부 갱신이 실패했다.');
          }
          await tx.run(`
            INSERT INTO recovery_jobs(
              id, city_id, command_id, unit_id, count,
              started_at_hour, completes_at_hour, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
          `,
          `recovery:${command.commandId}:${order.unitId}`,
          city.id,
          command.commandId,
          order.unitId,
          order.count,
          context.nowHour,
          completesAtHour);
        }
        const cityVersion = await bumpCity(tx, city, context);
        const response: RecoverUnitsResponse = {
          cityId: city.id,
          cityVersion,
          units: command.units,
          cost: appliedCost,
          completesAtHour,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'recover_units',
          payloadJson,
          payloadSha256,
          stableStringify(response),
        );
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 시간당 생산 정산(D-045).
   *
   * 도시 소유자 이름으로 기록한다 — 워커가 방아쇠를 당기지만 자원은 소유자의 것이고,
   * 작전 영수증 검증이 "영수증 주인 = 도시 주인"을 요구하기 때문이다.
   * commandId는 정산 구간에서 결정되므로 같은 구간을 두 번 정산하면 영수증 재생이 된다.
   */
  async creditProduction(
    context: CommandContext,
    command: CreditProductionCommand,
  ): Promise<CommandExecution<CreditProductionResponse> | null> {
    const toHour = validateInteger(command.toHour, 'toHour', 0, MAX_CITY_HOUR);
    const cityId = validateId(command.cityId, 'cityId');
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${cityId}`);
        const rules = rulesFor(city.rule_version);
        campaignForCity(city);
        // 처음 보는 도시는 소급하지 않는다. 지금부터 시작점을 잡아 둔다.
        if (city.last_production_hour === null) {
          await tx.run(
            'UPDATE cities SET last_production_hour = ? WHERE id = ? AND last_production_hour IS NULL',
            toHour,
            city.id,
          );
          return null;
        }
        const fromHour = city.last_production_hour;
        if (toHour <= fromHour) return null;
        const hours = Math.min(toHour - fromHour, MAX_PRODUCTION_HOURS_PER_COMMAND);
        const settledHour = fromHour + hours;
        const ownerContext: CommandContext = { actorId: city.owner_id, nowHour: toHour };
        const commandId = `prod:${sha256(`${city.id}:${settledHour}`).slice(0, 40)}`;

        const prior = await receiptRow(tx, city.owner_id, commandId);
        if (prior) {
          // 같은 구간을 다시 정산하려는 것이므로 아무 것도 더하지 않는다.
          return null;
        }
        const levels = await readBuildingLevels(tx, city.id);
        const balances = await readResourceMap(tx, city.id);
        const caps = new Map<ResourceId, number>();
        for (const resourceId of RESOURCE_IDS) {
          caps.set(resourceId, await resourceCapMicro(tx, city.id, rules, resourceId));
        }
        const bundle = accumulateProduction(rules, levels, balances, caps, hours);
        if (Object.keys(bundle).length === 0) {
          // 전부 상한이면 기록할 원장이 없다. 시각만 밀어 다음에 다시 계산하지 않게 한다.
          await tx.run(
            'UPDATE cities SET last_production_hour = ? WHERE id = ? AND last_production_hour = ?',
            settledHour,
            city.id,
            fromHour,
          );
          return null;
        }
        if (city.version >= MAX_CITY_VERSION) {
          throw new ServerError('VERSION_EXHAUSTED', '도시 version 상한에 도달했다.');
        }
        if (toHour < city.last_server_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
        }
        const credited = await creditReward(
          tx, city.id, commandId, ownerContext, rules, bundle, 'production',
        );
        const cityVersion = await bumpCity(tx, city, ownerContext);
        const updated = await tx.run(
          'UPDATE cities SET last_production_hour = ? WHERE id = ? AND last_production_hour = ?',
          settledHour,
          city.id,
          fromHour,
        );
        if (updated.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '생산 정산 시각 조건부 갱신이 실패했다.');
        }
        const response: CreditProductionResponse = {
          cityId: city.id,
          cityVersion,
          fromHour,
          toHour: settledHour,
          credited,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        const payloadJson = stableStringify({
          kind: 'credit_production',
          commandId,
          cityId: city.id,
          fromHour,
          toHour: settledHour,
        });
        await insertReceipt(
          tx,
          ownerContext,
          commandId,
          city.id,
          'credit_production',
          payloadJson,
          sha256(payloadJson),
          stableStringify(response),
        );
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 도시 이름 변경(D-054).
   * 자원을 움직이지 않으므로 원장이 없다. 나머지 명령과 같은 멱등 영수증·낙관적 동시성을 쓴다.
   */
  async renameCity(
    rawContext: CommandContext,
    rawCommand: RenameCityCommand,
  ): Promise<CommandExecution<RenameCityResponse>> {
    const context = validateContext(rawContext);
    const command = validateRenameCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'rename_city',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      name: command.name,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, command.cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${command.cityId}`);
        campaignForCity(city);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'rename_city', city.id, payloadJson, payloadSha256);
          const response = validateStoredRenameResponse(
            parseCanonicalStored(prior.response_json, '이름 변경 응답'),
            city,
            command,
          );
          await validateCurrentOperationStateHistory(tx, city);
          return { response, replayed: true };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);

        const update = await tx.run(
          'UPDATE cities SET name = ? WHERE id = ? AND version = ?',
          command.name,
          city.id,
          city.version,
        );
        if (update.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '도시 이름 조건부 갱신이 실패했다.');
        }
        const cityVersion = await bumpCity(tx, city, context);
        const response: RenameCityResponse = {
          cityId: city.id,
          cityVersion,
          name: command.name,
        };
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'rename_city',
          payloadJson,
          payloadSha256,
          stableStringify(response),
        );
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /** 생산 정산이 밀린 도시. 워커가 쓴다. */
  async citiesNeedingProduction(nowHour: number, limit: number): Promise<readonly string[]> {
    try {
      return await this.adapter.transaction(async (tx) => {
        const rows = await tx.all(`
          SELECT id FROM cities
          WHERE last_production_hour IS NULL OR last_production_hour < ?
          ORDER BY id
          LIMIT ?
        `, nowHour, limit) as unknown as { id: string }[];
        return rows.map((row) => row.id);
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /** 회복 완료 대상 job. 워커가 시간이 된 것만 가져간다. */
  async dueRecoveryJobs(nowHour: number, limit: number): Promise<readonly string[]> {
    try {
      return await this.adapter.transaction(async (tx) => {
        const rows = await tx.all(`
          SELECT id FROM recovery_jobs
          WHERE status = 'pending' AND completes_at_hour <= ?
          ORDER BY completes_at_hour, id
          LIMIT ?
        `, nowHour, limit) as unknown as { id: string }[];
        return rows.map((row) => row.id);
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 회복 완료. 예약 때 이미 보급품을 냈으므로 자원은 움직이지 않고 부상 → 가용만 옮긴다.
   * 멱등성은 `status = 'pending'` 조건부 UPDATE가 보장한다 — 두 번째 호출은 0행을 바꾸고
   * 이미 완료된 job의 결과를 그대로 돌려준다.
   */
  async completeRecovery(
    rawContext: CommandContext,
    command: CompleteRecoveryCommand,
  ): Promise<CommandExecution<CompleteRecoveryResponse>> {
    const context = validateContext(rawContext);
    if (typeof command.jobId !== 'string'
      || command.jobId.length < 1
      || command.jobId.length > 160) {
      throw new ServerError('INVALID_INPUT', 'jobId는 1..160자 문자열이어야 한다.');
    }
    const jobId = command.jobId;
    try {
      return await this.adapter.transaction(async (tx) => {
        const row = await tx.get(`
          SELECT id, city_id, command_id, unit_id, count, started_at_hour,
                 completes_at_hour, status, completed_at_hour, completed_city_version
          FROM recovery_jobs WHERE id = ?
        `, jobId) as unknown as RecoveryJobRow | undefined;
        if (!row) throw new ServerError('NOT_FOUND', `회복 job을 찾을 수 없다: ${jobId}`);
        const unitId = row.unit_id as EconomyUnitId;
        if (!ECONOMY_UNIT_IDS.includes(unitId)) {
          throw new ServerError('DATA_INTEGRITY', '회복 job의 병종이 유효하지 않다.');
        }
        if (row.status === 'completed') {
          return {
            response: {
              jobId: row.id,
              cityId: row.city_id,
              unitId,
              count: row.count,
              effectiveAtHour: row.completes_at_hour,
            },
            replayed: true,
          };
        }
        if (context.nowHour < row.completes_at_hour) {
          throw new ServerError('TOO_EARLY', '회복 완료 시각 전이다.');
        }
        const city = await cityRow(tx, row.city_id);
        if (!city) throw new ServerError('DATA_INTEGRITY', '회복 job의 도시가 없다.');
        if (context.nowHour < city.last_server_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
        }
        const army = await readArmy(tx, city.id);
        const current = army.rows.get(unitId);
        if (!current) throw new ServerError('DATA_INTEGRITY', `${unitId} 병력 행이 없다.`);
        const readyUpdate = await tx.run(`
          UPDATE city_armies SET ready = ?
          WHERE city_id = ? AND unit_id = ? AND ready = ?
        `, current.ready + row.count, city.id, unitId, current.ready);
        if (readyUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '회복 복귀 조건부 갱신이 실패했다.');
        }
        const cityVersion = await bumpCity(tx, city, context);
        const jobUpdate = await tx.run(`
          UPDATE recovery_jobs
          SET status = 'completed', completed_at_hour = ?, completed_city_version = ?
          WHERE id = ? AND status = 'pending'
        `, context.nowHour, cityVersion, row.id);
        if (jobUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '회복 job 조건부 완료가 실패했다.');
        }
        return {
          response: {
            jobId: row.id,
            cityId: city.id,
            unitId,
            count: row.count,
            effectiveAtHour: row.completes_at_hour,
          },
          replayed: false,
        };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async mobilizeUnits(
    rawContext: CommandContext,
    rawCommand: MobilizeUnitsCommand,
  ): Promise<CommandExecution<MobilizeUnitsResponse>> {
    const context = validateContext(rawContext);
    const command = validateMobilizeCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'mobilize_units',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      units: command.units,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, command.cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${command.cityId}`);
        campaignForCity(city);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'mobilize_units', city.id, payloadJson, payloadSha256);
          const response = validateStoredMobilizeResponse(
            parseCanonicalStored(prior.response_json, '동원 응답'),
            city,
          );
          if (stableStringify(response.units) !== stableStringify(command.units)) {
            throw new ServerError('DATA_INTEGRITY', '저장 동원 병력이 payload와 다르다.');
          }
          if (response.cityVersion !== command.expectedVersion + 1) {
            throw new ServerError('DATA_INTEGRITY', '저장 동원 응답 version이 payload와 다르다.');
          }
          const expectedCost = totalMobilizationCost(rulesFor(city.rule_version), command.units);
          assertBundlesEqual(response.cost, expectedCost, '저장 동원 비용');
          assertBundlesEqual(
            response.cost,
            await ledgerBundle(tx, city.id, command.commandId, 'mobilization'),
            '저장 동원 원장',
          );
          await validateCurrentOperationStateHistory(tx, city);
          return {
            response,
            replayed: true,
          };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);
        const rules = rulesFor(city.rule_version);
        // 건물 레벨이 병종을 해금한다(D-043). 자원을 빼기 전에 막는다.
        await assertUnitsUnlocked(tx, city, rules, command.units);
        const cost = totalMobilizationCost(rules, command.units);
        const appliedCost = await debitBundle(
          tx,
          city.id,
          command.commandId,
          context,
          cost,
          'mobilization',
          () => this.options.faultInjector?.('mobilize:after_first_debit'),
        );
        this.options.faultInjector?.('mobilize:after_ledger');
        const army = await readArmy(tx, city.id);
        for (const order of command.units) {
          const current = army.rows.get(order.unitId);
          if (!current) throw new ServerError('DATA_INTEGRITY', `${order.unitId} 병력 행이 없다.`);
          if (current.ready > MAX_CITY_VERSION - order.count) {
            throw new ServerError('VERSION_EXHAUSTED', `${order.unitId} 병력 상한에 도달했다.`);
          }
          const update = await tx.run(`
            UPDATE city_armies SET ready = ?
            WHERE city_id = ? AND unit_id = ? AND ready = ?
          `, current.ready + order.count, city.id, order.unitId, current.ready);
          if (update.changes !== 1) {
            throw new ServerError('DATA_INTEGRITY', '동원 병력 조건부 갱신이 실패했다.');
          }
        }
        this.options.faultInjector?.('mobilize:after_army');
        const cityVersion = await bumpCity(tx, city, context);
        this.options.faultInjector?.('mobilize:after_version');
        const response: MobilizeUnitsResponse = {
          cityId: city.id,
          cityVersion,
          units: command.units,
          cost: appliedCost,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        const responseJson = stableStringify(response);
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'mobilize_units',
          payloadJson,
          payloadSha256,
          responseJson,
        );
        this.options.faultInjector?.('mobilize:after_receipt');
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async reconNpc(
    rawContext: CommandContext,
    rawCommand: ReconNpcCommand,
  ): Promise<CommandExecution<ReconNpcResponse>> {
    const context = validateContext(rawContext);
    const command = validateReconCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'recon_npc',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      scenarioId: command.scenarioId,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, command.cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${command.cityId}`);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'recon_npc', city.id, payloadJson, payloadSha256);
          const reportRow = await tx.get(`
            SELECT id, city_id, command_id, scenario_id, accuracy_permille,
                   created_at_hour, expires_at_hour, report_json
            FROM recon_reports WHERE city_id = ? AND command_id = ?
          `, city.id, command.commandId) as unknown as ReconReportRow | undefined;
          if (!reportRow) throw new ServerError('DATA_INTEGRITY', '정찰 영수증의 보고서가 없다.');
          const response = validateStoredReconResponse(
            parseCanonicalStored(prior.response_json, '정찰 응답'),
            city,
            reportRow,
          );
          if (response.cityVersion !== command.expectedVersion + 1) {
            throw new ServerError('DATA_INTEGRITY', '저장 정찰 응답 version이 payload와 다르다.');
          }
          assertBundlesEqual(response.cost, RECON_COST, '저장 정찰 비용');
          assertBundlesEqual(
            response.cost,
            await ledgerBundle(tx, city.id, command.commandId, 'recon'),
            '저장 정찰 원장',
          );
          await validateCurrentOperationStateHistory(tx, city);
          return {
            response,
            replayed: true,
          };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);
        const campaign = campaignForCity(city);
        const scenario = campaign.scenarios[command.scenarioId];
        if (!scenario) {
          throw new ServerError('UNKNOWN_SCENARIO', `알 수 없는 NPC 시나리오: ${command.scenarioId}`);
        }
        assertScenarioUnlocked(campaign, scenario, await clearedScenarios(tx, city.id));
        const army = await readArmy(tx, city.id);
        const scouts = army.snapshot.ready.scout;
        if (scouts < 1) {
          throw new ServerError('SCOUT_REQUIRED', '정찰에는 가용 정찰병 1기 이상이 필요하다.');
        }
        const cost = await debitBundle(
          tx,
          city.id,
          command.commandId,
          context,
          RECON_COST,
          'recon',
          () => this.options.faultInjector?.('recon:after_first_debit'),
        );
        this.options.faultInjector?.('recon:after_ledger');
        // 레이더가 정확도를 올린다(D-043). 만든 시점의 레벨을 보고서에 남겨 재검증이 흔들리지 않게 한다.
        const economyRules = rulesFor(city.rule_version);
        const radarLevel = (await readBuildingLevels(tx, city.id)).get('radar') ?? 0;
        // 연구 보정은 보고서에 남는 정확도에 한 번만 반영된다(재검증은 저장값을 쓴다).
        const researchMods = await readResearchModifiers(tx, city);
        const accuracyPermille = Math.min(
          950,
          reconAccuracyPermille(economyRules, scouts, radarLevel) + researchMods.reconPermille,
        );
        const threats: ReconThreatEstimate[] = scenario.defender.stacks.map((stack) => ({
          unitId: stack.unitId as EconomyUnitId,
          row: stack.row,
          minimum: Math.floor(stack.count * accuracyPermille / 1000),
          maximum: Math.ceil(stack.count * (2000 - accuracyPermille) / 1000),
        }));
        const reportId = `recon:${sha256(`${context.actorId}:${command.commandId}`).slice(0, 48)}`;
        const report: ReconReportSnapshot = {
          id: reportId,
          cityId: city.id,
          commandId: command.commandId,
          scenarioId: scenario.id,
          scenarioNameKo: scenario.nameKo,
          campaignRuleVersion: city.campaign_rule_version,
          scoutCount: scouts,
          accuracy: accuracyPermille / 1000,
          createdAtHour: context.nowHour,
          expiresAtHour: context.nowHour + RECON_VALID_HOURS,
          radarLevel,
          researchReconPermille: researchMods.reconPermille,
          threats,
        };
        const reportJson = stableStringify(report);
        await tx.run(`
          INSERT INTO recon_reports(
            id, city_id, command_id, scenario_id, accuracy_permille,
            created_at_hour, expires_at_hour, report_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, report.id, city.id, command.commandId, scenario.id, accuracyPermille,
        context.nowHour, report.expiresAtHour, reportJson);
        this.options.faultInjector?.('recon:after_report');
        const cityVersion = await bumpCity(tx, city, context);
        this.options.faultInjector?.('recon:after_version');
        const response: ReconNpcResponse = {
          cityId: city.id,
          cityVersion,
          cost,
          report,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        const responseJson = stableStringify(response);
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'recon_npc',
          payloadJson,
          payloadSha256,
          responseJson,
        );
        this.options.faultInjector?.('recon:after_receipt');
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async attackNpc(
    rawContext: CommandContext,
    rawCommand: AttackNpcCommand,
  ): Promise<CommandExecution<AttackNpcResponse>> {
    const context = validateContext(rawContext);
    if (!isPlainRecord(rawCommand)) {
      throw new ServerError('INVALID_INPUT', 'NPC 공격 명령은 객체여야 한다.');
    }
    const cityId = validateId(rawCommand.cityId, 'cityId');
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${cityId}`);
        const campaign = campaignForCity(city);
        const command = validateAttackCommand(rawCommand, campaign.combatRuleVersion);
        const payloadJson = stableStringify({
          kind: 'attack_npc',
          commandId: command.commandId,
          cityId: command.cityId,
          expectedVersion: command.expectedVersion,
          scenarioId: command.scenarioId,
          deployment: command.deployment,
          doctrine: command.doctrine,
        });
        const payloadSha256 = sha256(payloadJson);
        if (city.owner_id !== context.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceipt(prior, 'attack_npc', city.id, payloadJson, payloadSha256);
          const reportRow = await tx.get(`
            SELECT id, city_id, command_id, scenario_id, recon_report_id, seed, result_hash,
                   input_json, report_json, created_at_hour
            FROM npc_battle_reports WHERE city_id = ? AND command_id = ?
          `, city.id, command.commandId) as unknown as BattleReportRow | undefined;
          if (!reportRow) throw new ServerError('DATA_INTEGRITY', '전투 영수증의 보고서가 없다.');
          const response = validateStoredAttackResponse(
            parseCanonicalStored(prior.response_json, '전투 응답'),
            city,
            reportRow,
          );
          if (response.cityVersion !== command.expectedVersion + 1) {
            throw new ServerError('DATA_INTEGRITY', '저장 전투 응답 version이 payload와 다르다.');
          }
          await assertAttackSemantics(tx, city, command, response, reportRow);
          await validateCurrentOperationStateHistory(tx, city);
          return {
            response,
            replayed: true,
          };
        }
        await assertNoConstructionReceipt(tx, context.actorId, command.commandId);
        assertCityCommand(city, context, command.expectedVersion);
        const scenario = campaign.scenarios[command.scenarioId];
        if (!scenario) {
          throw new ServerError('UNKNOWN_SCENARIO', `알 수 없는 NPC 시나리오: ${command.scenarioId}`);
        }
        assertScenarioUnlocked(campaign, scenario, await clearedScenarios(tx, city.id));
        const latestRecon = await tx.get(`
          SELECT id, city_id, command_id, scenario_id, accuracy_permille,
                 created_at_hour, expires_at_hour, report_json
          FROM recon_reports
          WHERE city_id = ? AND scenario_id = ?
          ORDER BY created_at_hour DESC, id DESC
          LIMIT 1
        `, city.id, scenario.id) as unknown as ReconReportRow | undefined;
        if (!latestRecon) {
          throw new ServerError('RECON_REQUIRED', 'NPC 공격 전에 정찰 보고서가 필요하다.');
        }
        const reconReport = validateReconReport(
          parseCanonicalStored(latestRecon.report_json, '정찰 보고서'),
          latestRecon,
        );
        assertReconSemantics(reconReport, city.campaign_rule_version);
        if (context.nowHour >= reconReport.expiresAtHour) {
          throw new ServerError('RECON_EXPIRED', '정찰 보고서가 만료됐다.');
        }
        const army = await readArmy(tx, city.id);
        const deployed = {} as Record<EconomyUnitId, number>;
        for (const unitId of ECONOMY_UNIT_IDS) deployed[unitId] = 0;
        for (const stack of command.deployment) {
          const unitId = stack.unitId as EconomyUnitId;
          deployed[unitId] += stack.count;
          if (!Number.isSafeInteger(deployed[unitId])
            || deployed[unitId] > army.snapshot.ready[unitId]) {
            throw new ServerError('INSUFFICIENT_UNITS', `${unitId} 가용 병력이 부족하다.`);
          }
        }
        const combatRules = RULESETS[campaign.combatRuleVersion];
        if (!combatRules) throw new ServerError('DATA_INTEGRITY', '전투 규칙을 찾을 수 없다.');
        const deployedValue = ECONOMY_UNIT_IDS.reduce(
          (sum, unitId) => sum + deployed[unitId] * combatRules.units[unitId]!.cost,
          0,
        );
        const economyRules = rulesFor(city.rule_version);
        const sortieCost = npcSortieCost(city.campaign_rule_version, command.deployment);
        const appliedSortieCost = await debitBundle(
          tx,
          city.id,
          command.commandId,
          context,
          sortieCost,
          'sortie',
          () => this.options.faultInjector?.('battle:after_first_debit'),
        );
        this.options.faultInjector?.('battle:after_ledger');
        const seed = this.nextSeed();
        // 연구 공격 보정은 전투 입력에 담긴다 — 입력이 저장되므로 나중에 연구가 올라도
        // 이 전투의 재현은 정확히 같다(D-044).
        const battleResearch = await readResearchModifiers(tx, city);
        const attackMultByTag: Partial<Record<string, number>> = {};
        for (const [tag, bonus] of battleResearch.attackByTag) {
          attackMultByTag[tag] = 1 + bonus;
        }
        const battleInput: BattleInput = {
          ruleVersion: campaign.combatRuleVersion,
          seed,
          attacker: {
            stacks: [...command.deployment],
            doctrine: command.doctrine,
            supply: campaign.attackerDefaults.supply,
            reconAccuracy: reconReport.accuracy,
            retreatThreshold: campaign.attackerDefaults.retreatThreshold,
            ...(Object.keys(attackMultByTag).length > 0
              ? { attackMultByTag: attackMultByTag as never }
              : {}),
          },
          defender: scenario.defender,
        };
        const result = simulateBattle(battleInput);
        if (result.attacker.totalCost !== deployedValue) {
          throw new ServerError('DATA_INTEGRITY', '출정 가치와 전투 결과 가치가 다르다.');
        }
        const casualties = casualtiesFromResult(command.deployment, result);
        for (const casualty of casualties) {
          const before = army.rows.get(casualty.unitId);
          if (!before) throw new ServerError('DATA_INTEGRITY', '병력 행이 누락됐다.');
          const nextReady = before.ready - casualty.deployed + casualty.survivors;
          const nextWounded = before.wounded + casualty.wounded;
          const nextDead = before.dead + casualty.dead;
          if (nextReady < 0
            || nextWounded > MAX_CITY_VERSION
            || nextDead > MAX_CITY_VERSION) {
            throw new ServerError('DATA_INTEGRITY', '전투 후 병력 수량이 범위를 벗어났다.');
          }
          const update = await tx.run(`
            UPDATE city_armies
            SET ready = ?, wounded = ?, dead = ?
            WHERE city_id = ? AND unit_id = ?
              AND ready = ? AND wounded = ? AND dead = ?
          `, nextReady, nextWounded, nextDead, city.id, casualty.unitId,
          before.ready, before.wounded, before.dead);
          if (update.changes !== 1) {
            throw new ServerError('DATA_INTEGRITY', '전투 병력 조건부 갱신이 실패했다.');
          }
        }
        this.options.faultInjector?.('battle:after_army');
        this.options.faultInjector?.('battle:before_reward');
        const reward = result.outcome === 'attacker_win'
          ? await creditReward(
            tx,
            city.id,
            command.commandId,
            context,
            economyRules,
            scenario.victoryReward,
          )
          : {};
        const reportId = `battle:${sha256(`${context.actorId}:${command.commandId}`).slice(0, 48)}`;
        // 저장되는 것은 정확히 이 항목들이다. 교리 같은 파생 항목을 여기 넣으면
        // 기존 기록의 canonical 비교가 깨진다 — 읽을 때 붙인다(D-042).
        const report: StoredNpcBattleReport = {
          id: reportId,
          cityId: city.id,
          commandId: command.commandId,
          scenarioId: scenario.id,
          scenarioNameKo: scenario.nameKo,
          campaignRuleVersion: city.campaign_rule_version,
          seed,
          createdAtHour: context.nowHour,
          reconReportId: reconReport.id,
          sortieCost: appliedSortieCost,
          reward,
          casualties,
          result,
          analysis: analyzeBattle(result),
        };
        const inputJson = stableStringify(battleInput);
        const reportJson = stableStringify(report);
        await tx.run(`
          INSERT INTO npc_battle_reports(
            id, city_id, command_id, scenario_id, recon_report_id, seed, result_hash,
            input_json, report_json, created_at_hour
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, report.id, city.id, command.commandId, scenario.id, reconReport.id,
        seed, result.hash, inputJson, reportJson, context.nowHour);
        this.options.faultInjector?.('battle:after_report');
        const cityVersion = await bumpCity(tx, city, context);
        this.options.faultInjector?.('battle:after_version');
        // 영수증에 남기는 응답도 저장 형태를 쓴다. 재생 검증이 report_json과 바이트 단위로 비교한다.
        const storedResponse = {
          cityId: city.id,
          cityVersion,
          report,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
        };
        const responseJson = stableStringify(storedResponse);
        const response: AttackNpcResponse = {
          ...storedResponse,
          report: {
            ...report,
            doctrine: command.doctrine,
            doctrineNameKo: combatRules.doctrines[command.doctrine]!.nameKo,
          },
        };
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'attack_npc',
          payloadJson,
          payloadSha256,
          responseJson,
        );
        this.options.faultInjector?.('battle:after_receipt');
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async getOperations(cityIdInput: string): Promise<OperationSnapshot> {
    const cityId = validateId(cityIdInput, 'cityId');
    try {
      return await this.adapter.transaction(async (tx) => {
        const city = await cityRow(tx, cityId);
        if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${cityId}`);
        rulesFor(city.rule_version);
        campaignForCity(city);
        const resources = await readResourceMap(tx, city.id);
        const army = await readArmy(tx, city.id);
        const buildingRows = await tx.all(`
          SELECT building_id, level
          FROM city_buildings
          WHERE city_id = ?
          ORDER BY building_id
        `, city.id) as unknown as BuildingRow[];
        // 건물 집합은 도시의 경제 규칙이 정한다(D-043).
        const expectedBuildingIds = cityBuildingIds(rulesFor(city.rule_version));
        if (buildingRows.length !== expectedBuildingIds.length) {
          throw new ServerError('DATA_INTEGRITY', '도시 건물 행 수가 규칙과 다르다.');
        }
        const buildings = {} as Record<BuildingId, number>;
        for (const row of buildingRows) {
          const buildingId = row.building_id as BuildingId;
          if (!BUILDING_IDS.includes(buildingId)
            || buildings[buildingId] !== undefined
            || !Number.isSafeInteger(row.level)
            || row.level < 1) {
            throw new ServerError('DATA_INTEGRITY', '도시 건물 행이 유효하지 않다.');
          }
          buildings[buildingId] = row.level;
        }
        const jobRows = await tx.all(`
          SELECT id, city_id, building_id, target_level, rule_version,
                 started_at_hour, completes_at_hour, effective_at_hour,
                 processed_at_hour, status
          FROM construction_jobs
          WHERE city_id = ?
          ORDER BY started_at_hour, id
        `, city.id) as unknown as ConstructionJobRow[];
        const jobs: ConstructionJobSnapshot[] = jobRows.map((row) => {
          const buildingId = row.building_id as BuildingId;
          if (!BUILDING_IDS.includes(buildingId)
            || row.city_id !== city.id
            || !['pending', 'completed'].includes(row.status)) {
            throw new ServerError('DATA_INTEGRITY', '건설 job 행이 유효하지 않다.');
          }
          return {
            id: row.id,
            cityId: row.city_id,
            buildingId,
            targetLevel: row.target_level,
            ruleVersion: row.rule_version,
            startedAtHour: row.started_at_hour,
            completesAtHour: row.completes_at_hour,
            effectiveAtHour: row.effective_at_hour,
            processedAtHour: row.processed_at_hour,
            status: row.status,
          };
        });
        const reconRows = await tx.all(`
          SELECT id, city_id, command_id, scenario_id, accuracy_permille,
                 created_at_hour, expires_at_hour, report_json
          FROM recon_reports
          WHERE city_id = ?
          ORDER BY created_at_hour, id
        `, city.id) as unknown as ReconReportRow[];
        const reconReports = reconRows.map((row) => {
          const report = validateReconReport(
            parseCanonicalStored(row.report_json, '정찰 보고서'),
            row,
          );
          assertReconSemantics(report, city.campaign_rule_version);
          return report;
        });
        const latestRecon = reconReports.at(-1) ?? null;
        const battleRows = await tx.all(`
          SELECT id, city_id, command_id, scenario_id, recon_report_id, seed, result_hash,
                 input_json, report_json, created_at_hour
          FROM npc_battle_reports
          WHERE city_id = ?
          ORDER BY created_at_hour, id
        `, city.id) as unknown as BattleReportRow[];
        const ledgerRows = await tx.all(`
          SELECT id, city_id, command_id, resource_id, reason, delta_micro,
                 balance_before_micro, balance_after_micro, created_at_hour
          FROM operation_ledger
          WHERE city_id = ?
          ORDER BY created_at_hour, id
        `, city.id) as unknown as OperationLedgerRow[];
        const receiptRows = await tx.all(`
          SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
                 payload_json, response_json, created_at_hour
          FROM operation_receipts
          WHERE city_id = ?
          ORDER BY created_at_hour, command_id
        `, city.id) as unknown as OperationReceiptRow[];
        const resourceSnapshot = {} as Record<ResourceId, number>;
        for (const resourceId of RESOURCE_IDS) {
          resourceSnapshot[resourceId] = resources.get(resourceId)!;
        }
        const ledger: OperationLedgerSnapshot[] = ledgerRows.map((row) => {
          if (!RESOURCE_IDS.includes(row.resource_id as ResourceId)
            || !OPERATION_LEDGER_REASONS.includes(row.reason)
            || row.balance_after_micro !== row.balance_before_micro + row.delta_micro) {
            throw new ServerError('DATA_INTEGRITY', '작전 원장 행이 유효하지 않다.');
          }
          return {
            id: row.id,
            cityId: row.city_id,
            commandId: row.command_id,
            resourceId: row.resource_id as ResourceId,
            reason: row.reason,
            deltaMicro: row.delta_micro,
            balanceBeforeMicro: row.balance_before_micro,
            balanceAfterMicro: row.balance_after_micro,
            createdAtHour: row.created_at_hour,
          };
        });
        const receipts: OperationReceiptSnapshot[] = receiptRows.map((row) => {
          if (!SHA256_PATTERN.test(row.payload_sha256)
            || sha256(row.payload_json) !== row.payload_sha256
            || stableStringify(parseCanonicalStored(row.payload_json, '작전 payload')) !== row.payload_json
            || stableStringify(parseCanonicalStored(row.response_json, '작전 응답')) !== row.response_json) {
            throw new ServerError('DATA_INTEGRITY', '작전 영수증 행이 유효하지 않다.');
          }
          return {
            actorId: row.actor_id,
            commandId: row.command_id,
            cityId: row.city_id,
            commandKind: row.command_kind,
            payloadSha256: row.payload_sha256,
            payloadJson: row.payload_json,
            responseJson: row.response_json,
            createdAtHour: row.created_at_hour,
          };
        });
        const recoveryRows = await readRecoveryJobs(tx, city.id);
        const operationCommands = await validateOperationHistory(
          tx,
          city,
          army.snapshot,
          receiptRows,
          ledgerRows,
          reconRows,
          battleRows,
          recoveryRows,
        );
        await validateResourceHistory(
          tx,
          city,
          resources,
          receiptRows,
          ledgerRows,
          operationCommands,
        );
        return {
          cityId: city.id,
          name: city.name,
          ownerId: city.owner_id,
          ruleVersion: city.rule_version,
          campaignRuleVersion: city.campaign_rule_version,
          version: city.version,
          lastServerHour: city.last_server_hour,
          resourcesMicro: resourceSnapshot,
          buildings,
          jobs,
          army: army.snapshot,
          recoveries: recoveryRows
            .filter((row) => row.status === 'pending')
            .map(recoveryJobSnapshot),
          recoveryInfo: recoveryInfo(city),
          // 현재 인력 기준 1시간치. 군표는 인력에 비례하므로 시간마다 조금씩 달라진다.
          productionPerHour: hourlyProduction(
            rulesFor(city.rule_version),
            Object.fromEntries(await readBuildingLevels(tx, city.id)),
            fromMicro(resources.get('manpower') ?? 0),
          ),
          latestRecon,
          battleReports: battleRows.map((row) => validateBattleReport(
            parseCanonicalStored(row.report_json, '전투 보고서'),
            row,
          )),
          scenarios: await listScenarios(tx, city),
          doctrines: listDoctrines(city),
          units: await listUnits(tx, city),
          buildingInfo: await listBuildings(tx, city),
          research: await listResearch(tx, city),
          ledger,
          receipts,
        };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  private nextSeed(): number {
    let seed: number;
    try {
      seed = this.options.seedGenerator?.() ?? randomBytes(4).readUInt32BE(0);
    } catch (error) {
      throw new ServerError('DATABASE_FAILURE', '서버 전투 seed 생성에 실패했다.', { cause: error });
    }
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new ServerError('DATA_INTEGRITY', '서버 전투 seed 생성기가 uint32를 반환하지 않았다.');
    }
    return seed;
  }
}

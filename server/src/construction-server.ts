import { createHash, randomBytes } from 'node:crypto';
import {
  BUILDING_IDS,
  buildingDef,
  cityBuildingIds,
  CAMPAIGN_RULESETS,
  CURRENT_CAMPAIGN_RULE_VERSION,
  CURRENT_ECONOMY_RULE_VERSION,
  ECONOMY_RULESETS,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
  constructionCost,
  constructionHours,
  stableStringify,
} from '../../engine/src/index.js';
import type {
  BuildingId,
  EconomyRuleset,
  PartialBundle,
  ResourceBundle,
  ResourceId,
} from '../../engine/src/index.js';
import { SERVER_SCHEMA_VERSION } from './database.js';
import type { SqlAdapter, SqlExecutor } from './db/adapter.js';
import { SqliteAdapter } from './db/sqlite-adapter.js';
import { ServerError } from './errors.js';
import { OperationService } from './operation-service.js';
import {
  ADMIN_ID_PREFIX,
  CLIENT_EVENT_NAMES,
  CLIENT_EVENT_SUBJECTS,
  CONSTRUCTION_WORKER_ID,
  WORKER_ID_PREFIX,
} from './types.js';
import type {
  AdminActionKind,
  AdminActionSnapshot,
  ClientEventInput,
  ClientEventName,
  ClientEventSubject,
  FunnelRow,
  RecordEventsResult,
  AuthenticatedActor,
  AttackNpcCommand,
  AttackNpcResponse,
  CitySnapshot,
  ClaimDueJobsCommand,
  ClaimDueJobsResult,
  ClaimedJob,
  CommandContext,
  CommandExecution,
  CompleteConstructionCommand,
  CompleteConstructionResponse,
  ConstructionJobSnapshot,
  ConstructionServerOptions,
  DeadJobSnapshot,
  FailClaimedJobCommand,
  FailClaimedJobResult,
  FaultPoint,
  IssueTokenCommand,
  AccountSnapshot,
  AdvanceResearchCommand,
  AdvanceResearchResponse,
  RecoverUnitsCommand,
  RecoverUnitsResponse,
  CompleteRecoveryCommand,
  CompleteRecoveryResponse,
  CreditProductionCommand,
  CreditProductionResponse,
  RenameCityCommand,
  RenameCityResponse,
  DeleteAccountResult,
  DeviceSessionResult,
  IssueTokenResult,
  JobClaimSnapshot,
  JobDispatchPolicy,
  LedgerSnapshot,
  MobilizeUnitsCommand,
  MobilizeUnitsResponse,
  OperationSnapshot,
  ReconNpcCommand,
  ReconNpcResponse,
  ReceiptSnapshot,
  ReleaseClaimCommand,
  ReleaseClaimResult,
  RequeueDeadJobCommand,
  RequeueDeadJobResult,
  RevokeTokenCommand,
  RevokeTokenResult,
  SeedCityInput,
  StartConstructionCommand,
  StartConstructionResponse,
  TokenRole,
} from './types.js';

const SCALE = 1000;
const MAX_CITY_VERSION = 2_147_483_647;
const MAX_SERVER_HOUR = 20_000_000;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const START_COMMAND_KEYS = ['commandId', 'cityId', 'expectedVersion', 'buildingId'] as const;
const COMPLETE_COMMAND_KEYS = ['commandId', 'jobId'] as const;
const FAIL_COMMAND_KEYS = ['jobId', 'error'] as const;
const RELEASE_COMMAND_KEYS = ['jobId'] as const;
const CONTEXT_KEYS = ['actorId', 'nowHour'] as const;
const DEFAULT_JOB_POLICY = { maxAttempts: 5, defaultLeaseHours: 1, maxBackoffHours: 24 } as const;
const JOB_POLICY_KEYS = ['maxAttempts', 'defaultLeaseHours', 'maxBackoffHours'] as const;
const START_RESPONSE_KEYS = [
  'cityId',
  'cityVersion',
  'jobId',
  'buildingId',
  'targetLevel',
  'startedAtHour',
  'completesAtHour',
  'cost',
  'ruleVersion',
] as const;
const COMPLETE_RESPONSE_KEYS = [
  'cityId',
  'cityVersion',
  'jobId',
  'buildingId',
  'targetLevel',
  'effectiveAtHour',
  'processedAtHour',
  'ruleVersion',
] as const;

interface CityRow {
  id: string;
  owner_id: string;
  rule_version: string;
  campaign_rule_version: string;
  version: number;
  last_server_hour: number;
}

interface ResourceRow {
  resource_id: string;
  balance_micro: number;
}

interface BuildingRow {
  building_id: string;
  level: number;
}

interface JobRow {
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

interface LedgerRow {
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

interface ReceiptRow {
  actor_id: string;
  command_id: string;
  city_id: string;
  command_kind: 'start_construction' | 'complete_construction';
  payload_sha256: string;
  payload_json: string;
  response_json: string;
  created_at_hour: number;
}

interface EffectRow {
  job_id: string;
  effect_key: string;
  command_id: string;
  city_version: number;
  response_json: string;
  effective_at_hour: number;
  processed_at_hour: number;
}

interface ClaimRow {
  job_id: string;
  worker_id: string;
  state: 'leased' | 'dead';
  attempt_count: number;
  claimed_at_hour: number;
  lease_until_hour: number;
  last_error: string | null;
}

interface ClaimCandidateRow {
  job_id: string;
  city_id: string;
  building_id: string;
  target_level: number;
  rule_version: string;
  completes_at_hour: number;
  claim_attempts: number | null;
}

interface ResolvedJobPolicy {
  readonly maxAttempts: number;
  readonly defaultLeaseHours: number;
  readonly maxBackoffHours: number;
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

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ServerError('INVALID_ID', `${label}는 영문·숫자·콜론·밑줄·하이픈 1..64자여야 한다.`);
  }
  return value;
}

function validateNonNegativeInteger(value: unknown, label: string, max = 10_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new ServerError('INVALID_INPUT', `${label}는 0..${max} 범위의 안전한 정수여야 한다.`);
  }
  return value as number;
}

function validateContext(value: unknown): CommandContext {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '명령 context는 객체여야 한다.');
  assertExactKeys(value, CONTEXT_KEYS, 'context');
  return {
    actorId: validateId(value.actorId, 'actorId'),
    nowHour: validateNonNegativeInteger(value.nowHour, 'nowHour'),
  };
}

function validateStartCommand(value: unknown): StartConstructionCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '건설 시작 명령은 객체여야 한다.');
  assertExactKeys(value, START_COMMAND_KEYS, 'startConstruction');
  if (typeof value.buildingId !== 'string'
    || !BUILDING_IDS.includes(value.buildingId as BuildingId)) {
    throw new ServerError('UNKNOWN_BUILDING', `알 수 없는 건물: ${String(value.buildingId)}`);
  }
  return {
    commandId: validateId(value.commandId, 'commandId'),
    cityId: validateId(value.cityId, 'cityId'),
    expectedVersion: validateNonNegativeInteger(value.expectedVersion, 'expectedVersion', 2_147_483_647),
    buildingId: value.buildingId as BuildingId,
  };
}

function validateCompleteCommand(value: unknown): CompleteConstructionCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '건설 완료 명령은 객체여야 한다.');
  assertExactKeys(value, COMPLETE_COMMAND_KEYS, 'completeConstruction');
  return {
    commandId: validateId(value.commandId, 'commandId'),
    jobId: validateId(value.jobId, 'jobId'),
  };
}

function validateIntegerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ServerError('INVALID_INPUT', `${label}는 ${minimum}..${maximum} 정수여야 한다.`);
  }
  return value as number;
}

function requireWorkerActor(actorId: string): void {
  if (!actorId.startsWith(WORKER_ID_PREFIX) || actorId.length <= WORKER_ID_PREFIX.length) {
    throw new ServerError('FORBIDDEN', `작업 claim은 '${WORKER_ID_PREFIX}' 접두 워커 주체만 실행할 수 있다.`);
  }
}

function resolveJobPolicy(policy: JobDispatchPolicy | undefined): ResolvedJobPolicy {
  if (policy === undefined) return DEFAULT_JOB_POLICY;
  if (!isPlainRecord(policy)) throw new ServerError('INVALID_INPUT', 'jobPolicy는 객체여야 한다.');
  for (const key of Object.keys(policy)) {
    if (!JOB_POLICY_KEYS.includes(key as (typeof JOB_POLICY_KEYS)[number])) {
      throw new ServerError('INVALID_INPUT', `jobPolicy에 허용되지 않은 필드가 있다: ${key}`);
    }
  }
  const source = policy as JobDispatchPolicy;
  return {
    maxAttempts: source.maxAttempts === undefined
      ? DEFAULT_JOB_POLICY.maxAttempts
      : validateIntegerInRange(source.maxAttempts, 'jobPolicy.maxAttempts', 1, 100),
    defaultLeaseHours: source.defaultLeaseHours === undefined
      ? DEFAULT_JOB_POLICY.defaultLeaseHours
      : validateIntegerInRange(source.defaultLeaseHours, 'jobPolicy.defaultLeaseHours', 1, 168),
    maxBackoffHours: source.maxBackoffHours === undefined
      ? DEFAULT_JOB_POLICY.maxBackoffHours
      : validateIntegerInRange(source.maxBackoffHours, 'jobPolicy.maxBackoffHours', 1, 720),
  };
}

function validateClaimCommand(value: unknown): ClaimDueJobsCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', 'claim 명령은 객체여야 한다.');
  for (const key of Object.keys(value)) {
    if (key !== 'limit' && key !== 'leaseHours') {
      throw new ServerError('INVALID_INPUT', `claimDueJobs에 허용되지 않은 필드가 있다: ${key}`);
    }
  }
  const limit = validateIntegerInRange(value.limit, 'limit', 1, 100);
  if (value.leaseHours === undefined) return { limit };
  return { limit, leaseHours: validateIntegerInRange(value.leaseHours, 'leaseHours', 1, 168) };
}

function validateFailCommand(value: unknown): FailClaimedJobCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', '실패 보고 명령은 객체여야 한다.');
  assertExactKeys(value, FAIL_COMMAND_KEYS, 'failClaimedJob');
  if (typeof value.error !== 'string' || value.error.length < 1 || value.error.length > 200) {
    throw new ServerError('INVALID_INPUT', '실패 사유는 1..200자 문자열이어야 한다.');
  }
  return {
    jobId: validateId(value.jobId, 'jobId'),
    error: value.error,
  };
}

function validateReleaseCommand(value: unknown): ReleaseClaimCommand {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_INPUT', 'claim 반납 명령은 객체여야 한다.');
  assertExactKeys(value, RELEASE_COMMAND_KEYS, 'releaseClaim');
  return { jobId: validateId(value.jobId, 'jobId') };
}

const EVENT_KEYS = ['id', 'sessionId', 'name', 'subject', 'outcome', 'clientSeq'] as const;
const OUTCOME_PATTERN = /^[A-Z_]{1,40}$/;

/** 계측 이벤트 검증. 열거값과 코드만 허용해 개인정보 유입을 막는다. */
function validateClientEvent(value: unknown): ClientEventInput {
  if (!isPlainRecord(value)) throw new ServerError('INVALID_EVENT', '이벤트는 객체여야 한다.');
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.includes(key as (typeof EVENT_KEYS)[number])) {
      throw new ServerError('INVALID_EVENT', `허용되지 않은 이벤트 필드다: ${key}`);
    }
  }
  const id = value.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{8,96}$/.test(id)) {
    throw new ServerError('INVALID_EVENT', '이벤트 id 형식이 유효하지 않다.');
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9:_-]{8,64}$/.test(sessionId)) {
    throw new ServerError('INVALID_EVENT', 'sessionId 형식이 유효하지 않다.');
  }
  if (typeof value.name !== 'string'
    || !CLIENT_EVENT_NAMES.includes(value.name as ClientEventName)) {
    throw new ServerError('INVALID_EVENT', `알 수 없는 이벤트명이다: ${String(value.name)}`);
  }
  if (value.subject !== undefined
    && (typeof value.subject !== 'string'
      || !CLIENT_EVENT_SUBJECTS.includes(value.subject as ClientEventSubject))) {
    throw new ServerError('INVALID_EVENT', `알 수 없는 이벤트 대상이다: ${String(value.subject)}`);
  }
  if (value.outcome !== undefined
    && (typeof value.outcome !== 'string' || !OUTCOME_PATTERN.test(value.outcome))) {
    throw new ServerError('INVALID_EVENT', 'outcome은 대문자·밑줄 1..40자여야 한다.');
  }
  if (!Number.isSafeInteger(value.clientSeq)
    || (value.clientSeq as number) < 0 || (value.clientSeq as number) > 1_000_000) {
    throw new ServerError('INVALID_EVENT', 'clientSeq는 0..1000000 정수여야 한다.');
  }
  return {
    id,
    sessionId,
    name: value.name as ClientEventName,
    ...(value.subject === undefined ? {} : { subject: value.subject as ClientEventSubject }),
    ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    clientSeq: value.clientSeq as number,
  };
}

const REQUEUE_COMMAND_KEYS = ['jobId', 'reason'] as const;
const ISSUE_TOKEN_KEYS = ['actorId', 'role', 'reason'] as const;
const REVOKE_TOKEN_KEYS = ['tokenSha256', 'reason'] as const;
const TOKEN_ROLES: readonly TokenRole[] = ['player', 'admin', 'worker'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** 기기 비밀값. 클라이언트가 crypto 난수로 만들며 형식만 검증한다(원문은 저장하지 않는다). */
const DEVICE_SECRET_PATTERN = /^[0-9a-f]{32,128}$/;

function requireAdminActor(actorId: string): void {
  if (!actorId.startsWith(ADMIN_ID_PREFIX) || actorId.length <= ADMIN_ID_PREFIX.length) {
    throw new ServerError('FORBIDDEN', `운영 조치는 '${ADMIN_ID_PREFIX}' 접두 관리자 주체만 실행할 수 있다.`);
  }
}

function validateReason(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new ServerError('INVALID_INPUT', `${label}은 1..200자 문자열이어야 한다.`);
  }
  return value;
}

async function insertAdminAction(
  tx: SqlExecutor,
  context: CommandContext,
  action: AdminActionKind,
  target: string,
  reason: string,
  priorState: string | null,
): Promise<void> {
  await tx.run(`
    INSERT INTO admin_actions(actor_id, action, target, reason, at_hour, prior_state)
    VALUES (?, ?, ?, ?, ?, ?)
  `, context.actorId, action, target, reason, context.nowHour, priorState);
}

interface TokenRow {
  token_sha256: string;
  actor_id: string;
  role: TokenRole;
  created_at_hour: number;
  revoked: number;
}

interface AccountRow {
  id: string;
  device_sha256: string;
  city_id: string;
  created_at_hour: number;
}

interface AdminActionRow {
  id: number;
  actor_id: string;
  action: AdminActionKind;
  target: string;
  reason: string;
  at_hour: number;
  prior_state: string | null;
}

interface DeadJobRow extends ClaimRow {
  city_id: string;
  building_id: string;
  target_level: number;
  completes_at_hour: number;
}

function toMicro(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ServerError('INVALID_INPUT', `자원 값이 유효하지 않다: ${String(value)}`);
  }
  const scaled = value * SCALE;
  const micro = Math.round(scaled);
  if (Math.abs(scaled - micro) > 1e-9) {
    throw new ServerError('INVALID_INPUT', `자원 값은 소수점 셋째 자리까지만 허용한다: ${value}`);
  }
  if (!Number.isSafeInteger(micro)) {
    throw new ServerError('INVALID_INPUT', `자원 값이 micro 안전 정수 범위를 벗어났다: ${value}`);
  }
  return micro;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertDataIntegrity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ServerError('DATA_INTEGRITY', message);
}

function parseStoredRecord(serialized: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (stableStringify(parsed) !== serialized) {
      throw new ServerError('DATA_INTEGRITY', `${label}이 정규화 JSON이 아니다.`);
    }
    assertDataIntegrity(isPlainRecord(parsed), `${label}은 객체여야 한다.`);
    return parsed;
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw new ServerError('DATA_INTEGRITY', `${label} JSON을 읽을 수 없다.`, { cause: error });
  }
}

function assertStoredExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assertDataIntegrity(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} 필드 집합이 계약과 다르다.`,
  );
}

function storedId(value: unknown, label: string): string {
  assertDataIntegrity(typeof value === 'string' && ID_PATTERN.test(value), `${label} ID가 유효하지 않다.`);
  return value;
}

function storedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  assertDataIntegrity(
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum,
    `${label} 정수 범위가 유효하지 않다.`,
  );
  return value as number;
}

function storedBuilding(value: unknown, label: string): BuildingId {
  assertDataIntegrity(
    typeof value === 'string' && BUILDING_IDS.includes(value as BuildingId),
    `${label} 건물 ID가 유효하지 않다.`,
  );
  return value as BuildingId;
}

function storedRuleVersion(value: unknown, label: string): string {
  assertDataIntegrity(typeof value === 'string' && value.length > 0, `${label} 규칙 버전이 유효하지 않다.`);
  return value;
}

function storedCost(value: unknown): PartialBundle {
  assertDataIntegrity(isPlainRecord(value), '저장 시작 응답 cost는 객체여야 한다.');
  for (const [resourceId, amount] of Object.entries(value)) {
    assertDataIntegrity(
      RESOURCE_IDS.includes(resourceId as ResourceId),
      `저장 시작 응답 cost에 알 수 없는 자원이 있다: ${resourceId}`,
    );
    const scaled = typeof amount === 'number' ? amount * SCALE : Number.NaN;
    assertDataIntegrity(
      typeof amount === 'number'
        && Number.isFinite(amount)
        && amount >= 0
        && Number.isSafeInteger(Math.round(scaled))
        && Math.abs(scaled - Math.round(scaled)) <= 1e-9,
      `저장 시작 응답 cost.${resourceId} 값이 유효하지 않다.`,
    );
  }
  return value as PartialBundle;
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
  throw new ServerError('DATABASE_FAILURE', 'SQLite 명령 처리 중 실패했다.', { cause: error });
}

function rulesFor(version: string): EconomyRuleset {
  const rules = ECONOMY_RULESETS[version];
  if (!rules) throw new ServerError('DATA_INTEGRITY', `도시에 연결된 경제 규칙이 없다: ${version}`);
  return rules;
}

async function cityRow(tx: SqlExecutor, cityId: string): Promise<CityRow | undefined> {
  return await tx.get(`
    SELECT id, owner_id, rule_version, campaign_rule_version, version, last_server_hour
    FROM cities WHERE id = ?
  `, cityId) as CityRow | undefined;
}

async function receiptRow(tx: SqlExecutor, actorId: string, commandId: string): Promise<ReceiptRow | undefined> {
  return await tx.get(`
    SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
           payload_json, response_json, created_at_hour
    FROM command_receipts WHERE actor_id = ? AND command_id = ?
  `, actorId, commandId) as ReceiptRow | undefined;
}

async function assertNoOperationReceipt(
  tx: SqlExecutor,
  actorId: string,
  commandId: string,
): Promise<void> {
  const conflicting = await tx.get(`
    SELECT 1 AS present
    FROM operation_receipts
    WHERE actor_id = ? AND command_id = ?
  `, actorId, commandId);
  if (conflicting) {
    throw new ServerError(
      'IDEMPOTENCY_KEY_REUSED',
      '같은 commandId가 이미 다른 명령 종류에 사용됐다.',
    );
  }
}

async function jobRow(tx: SqlExecutor, jobId: string): Promise<JobRow | undefined> {
  return await tx.get(`
    SELECT id, city_id, building_id, target_level, rule_version,
           started_at_hour, completes_at_hour, effective_at_hour, processed_at_hour, status
    FROM construction_jobs WHERE id = ?
  `, jobId) as JobRow | undefined;
}

async function effectRow(tx: SqlExecutor, jobId: string): Promise<EffectRow | undefined> {
  return await tx.get(`
    SELECT job_id, effect_key, command_id, city_version, response_json,
           effective_at_hour, processed_at_hour
    FROM completion_effects WHERE job_id = ?
  `, jobId) as EffectRow | undefined;
}

async function claimRow(tx: SqlExecutor, jobId: string): Promise<ClaimRow | undefined> {
  return await tx.get(`
    SELECT job_id, worker_id, state, attempt_count, claimed_at_hour, lease_until_hour, last_error
    FROM job_claims WHERE job_id = ?
  `, jobId) as ClaimRow | undefined;
}

function assertReceiptPayload(
  receipt: ReceiptRow,
  kind: ReceiptRow['command_kind'],
  cityId: string,
  payloadJson: string,
  payloadSha256: string,
): void {
  if (sha256(receipt.payload_json) !== receipt.payload_sha256) {
    throw new ServerError('DATA_INTEGRITY', '저장 command payload와 SHA-256이 일치하지 않는다.');
  }
  if (receipt.command_kind !== kind
    || receipt.city_id !== cityId
    || receipt.payload_sha256 !== payloadSha256
    || receipt.payload_json !== payloadJson) {
    throw new ServerError('IDEMPOTENCY_KEY_REUSED', '같은 commandId가 다른 payload에 재사용됐다.');
  }
}

async function validateStoredStartResponse(
  tx: SqlExecutor,
  serialized: string,
  receipt: ReceiptRow,
  city: CityRow,
  command: StartConstructionCommand,
): Promise<StartConstructionResponse> {
  const record = parseStoredRecord(serialized, '저장 시작 응답');
  assertStoredExactKeys(record, START_RESPONSE_KEYS, '저장 시작 응답');
  const response: StartConstructionResponse = {
    cityId: storedId(record.cityId, '저장 시작 응답 cityId'),
    cityVersion: storedInteger(record.cityVersion, '저장 시작 응답 cityVersion', 1, MAX_CITY_VERSION),
    jobId: storedId(record.jobId, '저장 시작 응답 jobId'),
    buildingId: storedBuilding(record.buildingId, '저장 시작 응답 buildingId'),
    targetLevel: storedInteger(record.targetLevel, '저장 시작 응답 targetLevel', 2, 100),
    startedAtHour: storedInteger(record.startedAtHour, '저장 시작 응답 startedAtHour', 0, 10_000_000),
    completesAtHour: storedInteger(record.completesAtHour, '저장 시작 응답 completesAtHour', 0, 20_000_000),
    cost: storedCost(record.cost),
    ruleVersion: storedRuleVersion(record.ruleVersion, '저장 시작 응답 ruleVersion'),
  };
  const job = await jobRow(tx, response.jobId);
  assertDataIntegrity(job, '저장 시작 응답이 가리키는 건설 job이 없다.');
  assertDataIntegrity(response.cityId === city.id && receipt.city_id === city.id, '저장 시작 응답의 도시가 receipt와 다르다.');
  assertDataIntegrity(response.cityVersion === command.expectedVersion + 1, '저장 시작 응답 version이 요청과 다르다.');
  assertDataIntegrity(response.cityVersion <= city.version, '저장 시작 응답 version이 현재 도시보다 앞선다.');
  assertDataIntegrity(response.buildingId === command.buildingId, '저장 시작 응답 건물이 요청과 다르다.');
  assertDataIntegrity(job.city_id === city.id, '저장 시작 응답 job의 도시가 다르다.');
  assertDataIntegrity(job.building_id === response.buildingId, '저장 시작 응답 job의 건물이 다르다.');
  assertDataIntegrity(job.target_level === response.targetLevel, '저장 시작 응답 job의 목표 레벨이 다르다.');
  assertDataIntegrity(job.rule_version === response.ruleVersion, '저장 시작 응답 job의 규칙 버전이 다르다.');
  assertDataIntegrity(job.started_at_hour === response.startedAtHour, '저장 시작 응답 job의 시작 시각이 다르다.');
  assertDataIntegrity(job.completes_at_hour === response.completesAtHour, '저장 시작 응답 job의 완료 시각이 다르다.');
  assertDataIntegrity(receipt.created_at_hour === response.startedAtHour, '저장 시작 receipt 시각이 응답과 다르다.');
  const rules = rulesFor(response.ruleVersion);
  assertDataIntegrity(
    response.targetLevel <= buildingDef(rules, response.buildingId).maxLevel,
    '저장 시작 응답의 목표 레벨이 규칙 상한을 넘는다.',
  );
  assertDataIntegrity(
    response.completesAtHour - response.startedAtHour
      === constructionHours(rules, response.buildingId, response.targetLevel),
    '저장 시작 응답의 건설 시간이 규칙과 다르다.',
  );
  assertDataIntegrity(
    stableStringify(response.cost)
      === stableStringify(constructionCost(rules, response.buildingId, response.targetLevel)),
    '저장 시작 응답의 비용이 규칙과 다르다.',
  );
  return response;
}

async function validateStoredCompleteResponse(
  tx: SqlExecutor,
  serialized: string,
  expectedJobId: string,
): Promise<{ readonly response: CompleteConstructionResponse; readonly city: CityRow }> {
  const record = parseStoredRecord(serialized, '저장 완료 응답');
  assertStoredExactKeys(record, COMPLETE_RESPONSE_KEYS, '저장 완료 응답');
  const response: CompleteConstructionResponse = {
    cityId: storedId(record.cityId, '저장 완료 응답 cityId'),
    cityVersion: storedInteger(record.cityVersion, '저장 완료 응답 cityVersion', 1, MAX_CITY_VERSION),
    jobId: storedId(record.jobId, '저장 완료 응답 jobId'),
    buildingId: storedBuilding(record.buildingId, '저장 완료 응답 buildingId'),
    targetLevel: storedInteger(record.targetLevel, '저장 완료 응답 targetLevel', 2, 100),
    effectiveAtHour: storedInteger(record.effectiveAtHour, '저장 완료 응답 effectiveAtHour', 0, 20_000_000),
    processedAtHour: storedInteger(record.processedAtHour, '저장 완료 응답 processedAtHour', 0, 20_000_000),
    ruleVersion: storedRuleVersion(record.ruleVersion, '저장 완료 응답 ruleVersion'),
  };
  assertDataIntegrity(response.jobId === expectedJobId, '저장 완료 응답이 다른 job을 가리킨다.');
  const job = await jobRow(tx, expectedJobId);
  const effect = await effectRow(tx, expectedJobId);
  assertDataIntegrity(job, '저장 완료 응답이 가리키는 건설 job이 없다.');
  assertDataIntegrity(effect, '완료된 건설 job에 effect가 없다.');
  const city = await cityRow(tx, job.city_id);
  assertDataIntegrity(city, '완료된 건설 job의 도시가 없다.');
  assertDataIntegrity(job.status === 'completed', 'effect가 있는 건설 job이 완료 상태가 아니다.');
  assertDataIntegrity(effect.job_id === job.id && effect.response_json === serialized, '완료 effect 응답이 저장 응답과 다르다.');
  assertDataIntegrity(effect.effect_key === `construction_complete:${job.id}`, '완료 effect key가 job과 다르다.');
  assertDataIntegrity(ID_PATTERN.test(effect.command_id), '완료 effect command ID가 유효하지 않다.');
  assertDataIntegrity(response.cityId === job.city_id, '저장 완료 응답의 도시가 job과 다르다.');
  assertDataIntegrity(response.cityVersion === effect.city_version, '저장 완료 응답 version이 effect와 다르다.');
  assertDataIntegrity(response.cityVersion <= city.version, '저장 완료 응답 version이 현재 도시보다 앞선다.');
  assertDataIntegrity(response.buildingId === job.building_id, '저장 완료 응답 건물이 job과 다르다.');
  assertDataIntegrity(response.targetLevel === job.target_level, '저장 완료 응답 목표 레벨이 job과 다르다.');
  assertDataIntegrity(response.ruleVersion === job.rule_version, '저장 완료 응답 규칙 버전이 job과 다르다.');
  assertDataIntegrity(response.effectiveAtHour === job.effective_at_hour, '저장 완료 응답 적용 시각이 job과 다르다.');
  assertDataIntegrity(response.processedAtHour === job.processed_at_hour, '저장 완료 응답 처리 시각이 job과 다르다.');
  assertDataIntegrity(effect.effective_at_hour === response.effectiveAtHour, '완료 effect 적용 시각이 응답과 다르다.');
  assertDataIntegrity(effect.processed_at_hour === response.processedAtHour, '완료 effect 처리 시각이 응답과 다르다.');
  assertDataIntegrity(response.processedAtHour >= response.effectiveAtHour, '저장 완료 응답 처리 시각이 적용 시각보다 이르다.');
  assertDataIntegrity(city.last_server_hour >= response.processedAtHour, '도시 시각이 저장 완료 응답보다 이르다.');
  const building = await tx.get(`
    SELECT level FROM city_buildings WHERE city_id = ? AND building_id = ?
  `, city.id, response.buildingId) as { level: number } | undefined;
  assertDataIntegrity(building && building.level >= response.targetLevel, '완료 응답의 건물 레벨이 적용되지 않았다.');
  const originReceipt = await receiptRow(tx, CONSTRUCTION_WORKER_ID, effect.command_id);
  assertDataIntegrity(originReceipt, '완료 effect를 만든 command receipt가 없다.');
  const originPayloadJson = stableStringify({
    kind: 'complete_construction',
    commandId: effect.command_id,
    jobId: job.id,
  });
  assertDataIntegrity(originReceipt.city_id === city.id, '완료 effect 원본 receipt의 도시가 다르다.');
  assertDataIntegrity(originReceipt.command_kind === 'complete_construction', '완료 effect 원본 receipt 종류가 다르다.');
  assertDataIntegrity(originReceipt.payload_json === originPayloadJson, '완료 effect 원본 receipt payload가 다르다.');
  assertDataIntegrity(originReceipt.payload_sha256 === sha256(originPayloadJson), '완료 effect 원본 receipt 해시가 다르다.');
  assertDataIntegrity(originReceipt.response_json === serialized, '완료 effect 원본 receipt 응답이 다르다.');
  assertDataIntegrity(originReceipt.created_at_hour === response.processedAtHour, '완료 effect 원본 receipt 시각이 다르다.');
  const rules = rulesFor(response.ruleVersion);
  assertDataIntegrity(
    response.targetLevel <= buildingDef(rules, response.buildingId).maxLevel,
    '저장 완료 응답의 목표 레벨이 규칙 상한을 넘는다.',
  );
  return { response, city };
}

async function insertReceipt(
  tx: SqlExecutor,
  context: CommandContext,
  commandId: string,
  cityId: string,
  kind: ReceiptRow['command_kind'],
  payloadJson: string,
  payloadSha256: string,
  responseJson: string,
): Promise<void> {
  await tx.run(`
    INSERT INTO command_receipts(
      actor_id, command_id, city_id, command_kind, payload_sha256,
      payload_json, response_json, created_at_hour
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    context.actorId,
    commandId,
    cityId,
    kind,
    payloadSha256,
    payloadJson,
    responseJson,
    context.nowHour,
  );
}

export class ConstructionServer {
  readonly schemaVersion = SERVER_SCHEMA_VERSION;
  readonly databasePath: string;
  private readonly adapter: SqlAdapter;
  private readonly options: ConstructionServerOptions;
  private readonly jobPolicy: ResolvedJobPolicy;
  private readonly operationService: OperationService;

  private constructor(adapter: SqlAdapter, databasePath: string, options: ConstructionServerOptions) {
    this.adapter = adapter;
    this.databasePath = databasePath;
    this.options = options;
    this.jobPolicy = resolveJobPolicy(options.jobPolicy);
    this.operationService = new OperationService(adapter, options);
  }

  /** SQLite 파일 DB로 서버를 연다(마이그레이션 포함). 유일하게 검증된 경로다. */
  static async open(
    databasePath: string,
    options: ConstructionServerOptions = {},
  ): Promise<ConstructionServer> {
    if (typeof databasePath !== 'string' || databasePath.length === 0) {
      throw new ServerError('INVALID_INPUT', 'databasePath가 필요하다.');
    }
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (nodeMajor !== 24) {
      throw new ServerError(
        'UNSUPPORTED_RUNTIME',
        `이 SQLite PoC는 Node.js 24에서만 검증됐다: ${process.versions.node}`,
      );
    }
    // 어댑터를 열기 전에 정책 오류를 fail closed한다.
    resolveJobPolicy(options.jobPolicy);
    const adapter = await SqliteAdapter.open(databasePath, options.busyTimeoutMs ?? 2_000);
    return new ConstructionServer(adapter, databasePath, options);
  }

  /**
   * 외부 어댑터 주입점(미래 PostgreSQL 경로). 어댑터는 db/adapter.ts의 D-022 계약을
   * 지켜야 하며, SQLite 외 구현은 아직 검증되지 않았다.
   */
  static withAdapter(adapter: SqlAdapter, options: ConstructionServerOptions = {}): ConstructionServer {
    return new ConstructionServer(adapter, `adapter:${adapter.kind}`, options);
  }

  get isTransaction(): boolean {
    return this.adapter.isTransaction;
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  private fault(point: FaultPoint): void {
    this.options.faultInjector?.(point);
  }

  async seedCity(input: SeedCityInput): Promise<CitySnapshot> {
    if (!isPlainRecord(input)) throw new ServerError('INVALID_INPUT', 'seedCity 입력은 객체여야 한다.');
    const cityId = validateId(input.cityId, 'cityId');
    const ownerId = validateId(input.ownerId, 'ownerId');
    const ruleVersion = input.ruleVersion ?? '0.1.0';
    const rules = ECONOMY_RULESETS[ruleVersion];
    if (!rules) throw new ServerError('INVALID_INPUT', `알 수 없는 경제 규칙 버전: ${ruleVersion}`);
    const campaignRuleVersion = input.campaignRuleVersion ?? '0.1.0';
    const campaignRules = (CAMPAIGN_RULESETS as Readonly<Record<string, {
      readonly economyRuleVersion: string;
    }>>)[campaignRuleVersion];
    if (!campaignRules) {
      throw new ServerError('INVALID_INPUT', `알 수 없는 캠페인 규칙 버전: ${campaignRuleVersion}`);
    }
    if (campaignRules.economyRuleVersion !== ruleVersion) {
      throw new ServerError(
        'INVALID_INPUT',
        `경제·캠페인 규칙 버전이 호환되지 않는다: ${ruleVersion}/${campaignRuleVersion}`,
      );
    }
    const version = validateNonNegativeInteger(input.version ?? 0, 'version', 2_147_483_647);
    const lastServerHour = validateNonNegativeInteger(input.lastServerHour ?? 0, 'lastServerHour');
    const resources: ResourceBundle = { ...rules.balance.startingResources, ...input.resources };
    const buildings = { ...rules.balance.startingBuildings, ...input.buildings };
    for (const key of Object.keys(input.resources ?? {})) {
      if (!RESOURCE_IDS.includes(key as ResourceId)) {
        throw new ServerError('INVALID_INPUT', `알 수 없는 자원: ${key}`);
      }
    }
    for (const key of Object.keys(input.buildings ?? {})) {
      if (!BUILDING_IDS.includes(key as BuildingId)) {
        throw new ServerError('UNKNOWN_BUILDING', `알 수 없는 건물: ${key}`);
      }
    }
    try {
      await this.adapter.transaction(async (tx) => {
        await tx.run(`
          INSERT INTO cities(
            id, owner_id, rule_version, campaign_rule_version, version, last_server_hour
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `, cityId, ownerId, ruleVersion, campaignRuleVersion, version, lastServerHour);
        for (const resourceId of RESOURCE_IDS) {
          await tx.run(
            'INSERT INTO city_resources(city_id, resource_id, balance_micro) VALUES (?, ?, ?)',
            cityId, resourceId, toMicro(resources[resourceId]),
          );
        }
        // 도시의 건물 집합은 이 도시의 경제 규칙이 정한다(D-043).
        for (const buildingId of cityBuildingIds(rules)) {
          const level = buildings[buildingId] ?? 1;
          if (!Number.isInteger(level) || level < 1 || level > buildingDef(rules, buildingId).maxLevel) {
            throw new ServerError('INVALID_INPUT', `${buildingId} 초기 레벨이 유효하지 않다.`);
          }
          await tx.run(
            'INSERT INTO city_buildings(city_id, building_id, level) VALUES (?, ?, ?)',
            cityId, buildingId, level,
          );
        }
        for (const unitId of ECONOMY_UNIT_IDS) {
          await tx.run(
            'INSERT INTO city_armies(city_id, unit_id, ready, wounded, dead) VALUES (?, ?, 0, 0, 0)',
            cityId,
            unitId,
          );
        }
      });
      return await this.getCity(cityId);
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async startConstruction(
    rawContext: CommandContext,
    rawCommand: StartConstructionCommand,
  ): Promise<CommandExecution<StartConstructionResponse>> {
    const context = validateContext(rawContext);
    const command = validateStartCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'start_construction',
      commandId: command.commandId,
      cityId: command.cityId,
      expectedVersion: command.expectedVersion,
      buildingId: command.buildingId,
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
          assertReceiptPayload(prior, 'start_construction', city.id, payloadJson, payloadSha256);
          return {
            response: await validateStoredStartResponse(tx, prior.response_json, prior, city, command),
            replayed: true,
          };
        }
        await assertNoOperationReceipt(tx, context.actorId, command.commandId);
        if (city.version !== command.expectedVersion) {
          throw new ServerError(
            'STALE_VERSION',
            `도시 version 불일치: expected=${command.expectedVersion}, actual=${city.version}`,
          );
        }
        if (city.version >= MAX_CITY_VERSION) {
          throw new ServerError('VERSION_EXHAUSTED', '도시 version 상한에 도달해 새 명령을 적용할 수 없다.');
        }
        if (context.nowHour < city.last_server_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
        }
        const rules = rulesFor(city.rule_version);
        const definition = buildingDef(rules, command.buildingId);
        // 효과를 내는 시스템이 아직 없는 건물은 건설을 거부한다(D-044).
        // 자원만 소모하고 아무 일도 없는 선택지는 함정이므로 서버가 막는다.
        if (definition.inertReasonKo !== undefined) {
          throw new ServerError(
            'SYSTEM_NOT_IMPLEMENTED',
            `${command.buildingId}: ${definition.inertReasonKo}`,
          );
        }
        const currentRow = await tx.get(`
          SELECT level FROM city_buildings WHERE city_id = ? AND building_id = ?
        `, city.id, command.buildingId) as { level: number } | undefined;
        if (!currentRow) throw new ServerError('DATA_INTEGRITY', '도시 건물 행이 누락됐다.');
        const pendingSame = await tx.get(`
          SELECT id FROM construction_jobs
          WHERE city_id = ? AND building_id = ? AND status = 'pending'
        `, city.id, command.buildingId);
        if (pendingSame) {
          throw new ServerError('BUILDING_ALREADY_PENDING', '같은 건물의 건설이 이미 진행 중이다.');
        }
        const targetLevel = currentRow.level + 1;
        if (targetLevel > definition.maxLevel) {
          throw new ServerError('MAX_LEVEL', `${command.buildingId}은 이미 최대 레벨이다.`);
        }
        const hqRow = await tx.get(`
          SELECT level FROM city_buildings WHERE city_id = ? AND building_id = 'hq'
        `, city.id) as { level: number } | undefined;
        if (!hqRow) throw new ServerError('DATA_INTEGRITY', '사령부 건물 행이 누락됐다.');
        if (command.buildingId !== 'hq'
          && targetLevel > hqRow.level + rules.balance.nonHqLevelOffset) {
          throw new ServerError('HQ_LEVEL_REQUIRED', '완료된 사령부 레벨이 목표 건물 레벨보다 낮다.');
        }
        const pendingCount = await tx.get(`
          SELECT COUNT(*) AS count FROM construction_jobs WHERE city_id = ? AND status = 'pending'
        `, city.id) as { count: number };
        if (pendingCount.count >= rules.balance.buildSlots) {
          throw new ServerError('BUILD_SLOT_FULL', '동시 건설 슬롯이 가득 찼다.');
        }
        const cost = constructionCost(rules, command.buildingId, targetLevel);
        const balances = new Map<ResourceId, number>();
        for (const row of await tx.all(`
          SELECT resource_id, balance_micro FROM city_resources WHERE city_id = ?
        `, city.id) as unknown as ResourceRow[]) {
          balances.set(row.resource_id as ResourceId, row.balance_micro);
        }
        for (const resourceId of RESOURCE_IDS) {
          const required = toMicro(cost[resourceId] ?? 0);
          const balance = balances.get(resourceId);
          if (balance === undefined) throw new ServerError('DATA_INTEGRITY', `${resourceId} 자원 행이 없다.`);
          if (balance < required) {
            throw new ServerError('INSUFFICIENT_RESOURCES', `${resourceId} 자원이 부족하다.`);
          }
        }
        const jobId = `job:${sha256(`${context.actorId}:${command.commandId}`).slice(0, 48)}`;
        let debitIndex = 0;
        for (const resourceId of RESOURCE_IDS) {
          const required = toMicro(cost[resourceId] ?? 0);
          if (required === 0) continue;
          const before = balances.get(resourceId)!;
          const after = before - required;
          const update = await tx.run(`
            UPDATE city_resources SET balance_micro = ?
            WHERE city_id = ? AND resource_id = ? AND balance_micro = ?
          `, after, city.id, resourceId, before);
          if (update.changes !== 1) {
            throw new ServerError('DATA_INTEGRITY', `${resourceId} 조건부 차감에 실패했다.`);
          }
          if (debitIndex === 0) this.fault('start:after_first_debit');
          await tx.run(`
            INSERT INTO economy_ledger(
              id, city_id, command_id, job_id, resource_id, reason,
              delta_micro, balance_before_micro, balance_after_micro, created_at_hour
            ) VALUES (?, ?, ?, ?, ?, 'construction_start', ?, ?, ?, ?)
          `,
            `ledger:${jobId}:${resourceId}`,
            city.id,
            command.commandId,
            jobId,
            resourceId,
            -required,
            before,
            after,
            context.nowHour,
          );
          debitIndex += 1;
        }
        this.fault('start:after_ledger');
        const durationHours = constructionHours(rules, command.buildingId, targetLevel);
        const completesAtHour = context.nowHour + durationHours;
        await tx.run(`
          INSERT INTO construction_jobs(
            id, city_id, building_id, target_level, rule_version,
            started_at_hour, completes_at_hour, effective_at_hour, processed_at_hour, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending')
        `,
          jobId,
          city.id,
          command.buildingId,
          targetLevel,
          city.rule_version,
          context.nowHour,
          completesAtHour,
        );
        this.fault('start:after_job');
        const nextVersion = city.version + 1;
        const versionUpdate = await tx.run(`
          UPDATE cities SET version = ?, last_server_hour = ? WHERE id = ? AND version = ?
        `, nextVersion, context.nowHour, city.id, city.version);
        if (versionUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '도시 version 조건부 갱신에 실패했다.');
        }
        this.fault('start:after_version');
        const response: StartConstructionResponse = {
          cityId: city.id,
          cityVersion: nextVersion,
          jobId,
          buildingId: command.buildingId,
          targetLevel,
          startedAtHour: context.nowHour,
          completesAtHour,
          cost,
          ruleVersion: city.rule_version,
        };
        const responseJson = stableStringify(response);
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'start_construction',
          payloadJson,
          payloadSha256,
          responseJson,
        );
        this.fault('start:after_receipt');
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  async completeConstruction(
    rawContext: CommandContext,
    rawCommand: CompleteConstructionCommand,
  ): Promise<CommandExecution<CompleteConstructionResponse>> {
    const context = validateContext(rawContext);
    if (context.actorId !== CONSTRUCTION_WORKER_ID) {
      throw new ServerError('FORBIDDEN', '건설 완료는 권위 작업 처리기만 실행할 수 있다.');
    }
    const command = validateCompleteCommand(rawCommand);
    const payloadJson = stableStringify({
      kind: 'complete_construction',
      commandId: command.commandId,
      jobId: command.jobId,
    });
    const payloadSha256 = sha256(payloadJson);
    try {
      return await this.adapter.transaction(async (tx) => {
        const prior = await receiptRow(tx, context.actorId, command.commandId);
        if (prior) {
          assertReceiptPayload(prior, 'complete_construction', prior.city_id, payloadJson, payloadSha256);
          const stored = await validateStoredCompleteResponse(
            tx,
            prior.response_json,
            command.jobId,
          );
          assertDataIntegrity(prior.city_id === stored.city.id, '저장 완료 receipt의 도시가 job과 다르다.');
          return {
            response: stored.response,
            replayed: true,
          };
        }
        await assertNoOperationReceipt(tx, context.actorId, command.commandId);
        const effect = await effectRow(tx, command.jobId);
        if (effect) {
          const stored = await validateStoredCompleteResponse(tx, effect.response_json, command.jobId);
          const response = stored.response;
          const completedCity = stored.city;
          if (context.nowHour < completedCity.last_server_hour) {
            throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
          }
          await insertReceipt(
            tx,
            context,
            command.commandId,
            response.cityId,
            'complete_construction',
            payloadJson,
            payloadSha256,
            effect.response_json,
          );
          this.fault('complete:after_receipt');
          return { response, replayed: true };
        }
        const job = await jobRow(tx, command.jobId);
        if (!job) throw new ServerError('NOT_FOUND', `건설 job을 찾을 수 없다: ${command.jobId}`);
        if (job.status !== 'pending') {
          throw new ServerError('DATA_INTEGRITY', '완료 job에 completion effect가 없다.');
        }
        const city = await cityRow(tx, job.city_id);
        if (!city) throw new ServerError('DATA_INTEGRITY', '건설 job의 도시가 없다.');
        const jobRules = rulesFor(job.rule_version);
        const jobBuilding = job.building_id as BuildingId;
        if (!BUILDING_IDS.includes(jobBuilding)
          || jobRules.buildings[jobBuilding] === undefined
          || job.target_level > buildingDef(jobRules, jobBuilding).maxLevel
          || job.completes_at_hour - job.started_at_hour
            !== constructionHours(jobRules, jobBuilding, job.target_level)) {
          throw new ServerError('DATA_INTEGRITY', '건설 job의 규칙·건물·목표·시간이 서로 맞지 않는다.');
        }
        if (context.nowHour < city.last_server_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 도시의 마지막 처리 시각보다 이전이다.');
        }
        if (context.nowHour < job.completes_at_hour) {
          throw new ServerError(
            'TOO_EARLY',
            `완료 시각 이전이다: now=${context.nowHour}, completes=${job.completes_at_hour}`,
          );
        }
        if (city.version >= MAX_CITY_VERSION) {
          throw new ServerError('VERSION_EXHAUSTED', '도시 version 상한에 도달해 건설 완료를 적용할 수 없다.');
        }
        const buildingUpdate = await tx.run(`
          UPDATE city_buildings SET level = ?
          WHERE city_id = ? AND building_id = ? AND level = ?
        `, job.target_level, city.id, job.building_id, job.target_level - 1);
        if (buildingUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '건물 레벨 선행 조건이 맞지 않는다.');
        }
        this.fault('complete:after_building');
        const jobUpdate = await tx.run(`
          UPDATE construction_jobs
          SET status = 'completed', effective_at_hour = ?, processed_at_hour = ?
          WHERE id = ? AND status = 'pending'
        `, job.completes_at_hour, context.nowHour, job.id);
        if (jobUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '건설 job 완료 조건부 갱신에 실패했다.');
        }
        this.fault('complete:after_job');
        const nextVersion = city.version + 1;
        const response: CompleteConstructionResponse = {
          cityId: city.id,
          cityVersion: nextVersion,
          jobId: job.id,
          buildingId: job.building_id as BuildingId,
          targetLevel: job.target_level,
          effectiveAtHour: job.completes_at_hour,
          processedAtHour: context.nowHour,
          ruleVersion: job.rule_version,
        };
        const responseJson = stableStringify(response);
        await tx.run(`
          INSERT INTO completion_effects(
            job_id, effect_key, command_id, city_version, response_json,
            effective_at_hour, processed_at_hour
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
            job.id,
            `construction_complete:${job.id}`,
            command.commandId,
            nextVersion,
            responseJson,
            job.completes_at_hour,
            context.nowHour,
          );
        this.fault('complete:after_effect');
        const versionUpdate = await tx.run(`
          UPDATE cities SET version = ?, last_server_hour = ? WHERE id = ? AND version = ?
        `, nextVersion, context.nowHour, city.id, city.version);
        if (versionUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '도시 완료 version 갱신에 실패했다.');
        }
        this.fault('complete:after_version');
        // 완료된 job의 claim은 같은 트랜잭션에서 제거한다(claim 존재 ⇒ job pending 불변식).
        // claim 없는 완료도 허용되므로 changes는 0 또는 1이다.
        await tx.run('DELETE FROM job_claims WHERE job_id = ?', job.id);
        this.fault('complete:after_claim_delete');
        await insertReceipt(
          tx,
          context,
          command.commandId,
          city.id,
          'complete_construction',
          payloadJson,
          payloadSha256,
          responseJson,
        );
        this.fault('complete:after_receipt');
        return { response, replayed: false };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 기한이 도래한 pending 건설 job을 워커 인스턴스가 원자적으로 claim한다.
   * lease가 유효한 claim은 탈취할 수 없고, 만료된 claim은 시도 횟수를 올려 재claim한다.
   * 최대 시도를 소진한 job은 이 스캔에서 dead letter로 전환되고 반환 목록에서 제외된다.
   */
  async claimDueConstructionJobs(
    rawContext: CommandContext,
    rawCommand: ClaimDueJobsCommand,
  ): Promise<ClaimDueJobsResult> {
    const context = validateContext(rawContext);
    requireWorkerActor(context.actorId);
    const command = validateClaimCommand(rawCommand);
    const leaseHours = command.leaseHours ?? this.jobPolicy.defaultLeaseHours;
    try {
      return await this.adapter.transaction(async (tx) => {
        const leaseUntilHour = context.nowHour + leaseHours;
        if (leaseUntilHour > MAX_SERVER_HOUR) {
          throw new ServerError('INVALID_INPUT', 'lease 만료 시각이 서버 시간 상한을 넘는다.');
        }
        const candidates = await tx.all(`
          SELECT j.id AS job_id, j.city_id, j.building_id, j.target_level, j.rule_version,
                 j.completes_at_hour, c.attempt_count AS claim_attempts
          FROM construction_jobs j
          LEFT JOIN job_claims c ON c.job_id = j.id
          WHERE j.status = 'pending'
            AND j.completes_at_hour <= ?
            AND (c.job_id IS NULL OR (c.state = 'leased' AND c.lease_until_hour <= ?))
          ORDER BY j.completes_at_hour, j.id
          LIMIT ?
        `, context.nowHour, context.nowHour, command.limit) as unknown as ClaimCandidateRow[];
        const claimed: ClaimedJob[] = [];
        const deadLettered: string[] = [];
        for (const row of candidates) {
          const buildingId = row.building_id as BuildingId;
          if (!BUILDING_IDS.includes(buildingId)) {
            throw new ServerError('DATA_INTEGRITY', `claim 후보 job의 건물이 유효하지 않다: ${row.building_id}`);
          }
          if (row.claim_attempts !== null && row.claim_attempts >= this.jobPolicy.maxAttempts) {
            const deadUpdate = await tx.run(`
              UPDATE job_claims
              SET state = 'dead', last_error = COALESCE(last_error, ?)
              WHERE job_id = ? AND state = 'leased' AND lease_until_hour <= ? AND attempt_count = ?
            `,
              '최대 시도 소진: lease 만료 재claim 스캔에서 전환',
              row.job_id,
              context.nowHour,
              row.claim_attempts,
            );
            if (deadUpdate.changes !== 1) {
              throw new ServerError('DATA_INTEGRITY', 'dead letter 전환 선행 조건이 맞지 않는다.');
            }
            this.fault('claim:after_dead_letter');
            deadLettered.push(row.job_id);
            continue;
          }
          const attempt = (row.claim_attempts ?? 0) + 1;
          if (row.claim_attempts === null) {
            const insert = await tx.run(`
              INSERT INTO job_claims(
                job_id, worker_id, state, attempt_count, claimed_at_hour, lease_until_hour, last_error
              ) VALUES (?, ?, 'leased', 1, ?, ?, NULL)
            `, row.job_id, context.actorId, context.nowHour, leaseUntilHour);
            if (insert.changes !== 1) {
              throw new ServerError('DATA_INTEGRITY', '신규 claim 삽입에 실패했다.');
            }
          } else {
            const reclaim = await tx.run(`
              UPDATE job_claims
              SET worker_id = ?, attempt_count = ?, claimed_at_hour = ?, lease_until_hour = ?
              WHERE job_id = ? AND state = 'leased' AND lease_until_hour <= ? AND attempt_count = ?
            `,
              context.actorId,
              attempt,
              context.nowHour,
              leaseUntilHour,
              row.job_id,
              context.nowHour,
              row.claim_attempts,
            );
            if (reclaim.changes !== 1) {
              throw new ServerError('DATA_INTEGRITY', '만료 claim 재획득 선행 조건이 맞지 않는다.');
            }
          }
          this.fault('claim:after_upsert');
          claimed.push({
            jobId: row.job_id,
            cityId: row.city_id,
            buildingId,
            targetLevel: row.target_level,
            ruleVersion: row.rule_version,
            completesAtHour: row.completes_at_hour,
            attempt,
            leaseUntilHour,
          });
        }
        return { claimed, deadLettered };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 워커가 처리 실패를 보고한다. lease를 소유한 워커만 가능하며,
   * 남은 시도가 있으면 지수 백오프(2^(시도-1), 상한 정책)만큼 재claim을 늦추고
   * 최대 시도를 소진했으면 dead letter로 전환한다.
   */
  async failClaimedConstructionJob(
    rawContext: CommandContext,
    rawCommand: FailClaimedJobCommand,
  ): Promise<FailClaimedJobResult> {
    const context = validateContext(rawContext);
    requireWorkerActor(context.actorId);
    const command = validateFailCommand(rawCommand);
    try {
      return await this.adapter.transaction(async (tx) => {
        const claim = await claimRow(tx, command.jobId);
        if (!claim) {
          throw new ServerError('NOT_FOUND', `실패를 보고할 claim이 없다: ${command.jobId}`);
        }
        if (claim.state !== 'leased'
          || claim.worker_id !== context.actorId
          || claim.lease_until_hour <= context.nowHour) {
          throw new ServerError('CLAIM_EXPIRED', 'claim을 소유하고 있지 않다(만료·소유자 불일치·dead).');
        }
        if (context.nowHour < claim.claimed_at_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 claim 시각보다 이전이다.');
        }
        const job = await jobRow(tx, command.jobId);
        assertDataIntegrity(job && job.status === 'pending', 'claim이 가리키는 job이 pending이 아니다.');
        if (claim.attempt_count >= this.jobPolicy.maxAttempts) {
          const deadUpdate = await tx.run(`
            UPDATE job_claims SET state = 'dead', last_error = ?
            WHERE job_id = ? AND worker_id = ? AND state = 'leased' AND lease_until_hour = ?
          `, command.error, command.jobId, context.actorId, claim.lease_until_hour);
          if (deadUpdate.changes !== 1) {
            throw new ServerError('DATA_INTEGRITY', 'dead letter 전환 선행 조건이 맞지 않는다.');
          }
          return {
            jobId: command.jobId,
            state: 'dead' as const,
            attempt: claim.attempt_count,
            nextEligibleHour: null,
          };
        }
        const backoffHours = Math.min(this.jobPolicy.maxBackoffHours, 2 ** (claim.attempt_count - 1));
        const nextEligibleHour = Math.min(MAX_SERVER_HOUR, context.nowHour + backoffHours);
        const retryUpdate = await tx.run(`
          UPDATE job_claims SET lease_until_hour = ?, last_error = ?
          WHERE job_id = ? AND worker_id = ? AND state = 'leased' AND lease_until_hour = ?
        `, nextEligibleHour, command.error, command.jobId, context.actorId, claim.lease_until_hour);
        if (retryUpdate.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '재시도 백오프 갱신 선행 조건이 맞지 않는다.');
        }
        return {
          jobId: command.jobId,
          state: 'retry_scheduled' as const,
          attempt: claim.attempt_count,
          nextEligibleHour,
        };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 정상 종료 시 lease를 반납해 즉시 재claim 가능하게 한다. 시도 횟수는 되돌리지 않는다.
   * claim이 이미 없으면(완료 등) released=false를 반환한다.
   */
  async releaseConstructionJobClaim(
    rawContext: CommandContext,
    rawCommand: ReleaseClaimCommand,
  ): Promise<ReleaseClaimResult> {
    const context = validateContext(rawContext);
    requireWorkerActor(context.actorId);
    const command = validateReleaseCommand(rawCommand);
    try {
      return await this.adapter.transaction(async (tx) => {
        const claim = await claimRow(tx, command.jobId);
        if (!claim) return { jobId: command.jobId, released: false };
        if (claim.state !== 'leased'
          || claim.worker_id !== context.actorId
          || claim.lease_until_hour <= context.nowHour) {
          throw new ServerError('CLAIM_EXPIRED', 'claim을 소유하고 있지 않아 반납할 수 없다.');
        }
        if (context.nowHour < claim.claimed_at_hour) {
          throw new ServerError('TIME_REVERSED', '서버 시간이 claim 시각보다 이전이다.');
        }
        const release = await tx.run(`
          UPDATE job_claims SET lease_until_hour = ?
          WHERE job_id = ? AND worker_id = ? AND state = 'leased' AND lease_until_hour = ?
        `, context.nowHour, command.jobId, context.actorId, claim.lease_until_hour);
        if (release.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', 'claim 반납 선행 조건이 맞지 않는다.');
        }
        return { jobId: command.jobId, released: true };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * dead letter를 감사 기록과 함께 재가동한다(운영 조치, admin 전용).
   * claim을 삭제하므로 다음 스캔이 attempt 1부터 다시 시작한다. 감사 행과 같은 트랜잭션이다.
   */
  async requeueDeadJob(rawContext: CommandContext, rawCommand: RequeueDeadJobCommand): Promise<RequeueDeadJobResult> {
    const context = validateContext(rawContext);
    requireAdminActor(context.actorId);
    if (!isPlainRecord(rawCommand)) throw new ServerError('INVALID_INPUT', 'requeue 명령은 객체여야 한다.');
    assertExactKeys(rawCommand, REQUEUE_COMMAND_KEYS, 'requeueDeadJob');
    const jobId = validateId(rawCommand.jobId, 'jobId');
    const reason = validateReason(rawCommand.reason, 'reason');
    try {
      return await this.adapter.transaction(async (tx) => {
        const claim = await claimRow(tx, jobId);
        if (!claim) throw new ServerError('NOT_FOUND', `재가동할 claim이 없다: ${jobId}`);
        if (claim.state !== 'dead') {
          throw new ServerError('NOT_DEAD_LETTER', 'dead letter 상태의 claim만 재가동할 수 있다.');
        }
        const job = await jobRow(tx, jobId);
        assertDataIntegrity(job && job.status === 'pending', 'dead claim이 가리키는 job이 pending이 아니다.');
        const priorState = stableStringify({
          attemptCount: claim.attempt_count,
          claimedAtHour: claim.claimed_at_hour,
          lastError: claim.last_error,
          leaseUntilHour: claim.lease_until_hour,
          state: claim.state,
          workerId: claim.worker_id,
        });
        const removal = await tx.run(`
          DELETE FROM job_claims WHERE job_id = ? AND state = 'dead' AND attempt_count = ?
        `, jobId, claim.attempt_count);
        if (removal.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', 'dead claim 재가동 선행 조건이 맞지 않는다.');
        }
        await insertAdminAction(tx, context, 'requeue_dead_job', jobId, reason, priorState);
        return { jobId, priorAttempts: claim.attempt_count, requeued: true as const };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /** 운영 조회: dead letter 목록(job 문맥 포함). */
  async listDeadJobs(): Promise<DeadJobSnapshot[]> {
    const rows = await this.adapter.all(`
      SELECT c.job_id, c.worker_id, c.state, c.attempt_count, c.claimed_at_hour,
             c.lease_until_hour, c.last_error,
             j.city_id, j.building_id, j.target_level, j.completes_at_hour
      FROM job_claims c
      JOIN construction_jobs j ON j.id = c.job_id
      WHERE c.state = 'dead'
      ORDER BY c.job_id
    `) as unknown as DeadJobRow[];
    return rows.map((row): DeadJobSnapshot => ({
      jobId: row.job_id,
      workerId: row.worker_id,
      state: row.state,
      attemptCount: row.attempt_count,
      claimedAtHour: row.claimed_at_hour,
      leaseUntilHour: row.lease_until_hour,
      lastError: row.last_error,
      cityId: row.city_id,
      buildingId: row.building_id as BuildingId,
      targetLevel: row.target_level,
      completesAtHour: row.completes_at_hour,
    }));
  }

  /** 운영 조회: 관리자 조치 감사 목록. */
  async listAdminActions(): Promise<AdminActionSnapshot[]> {
    const rows = await this.adapter.all(`
      SELECT id, actor_id, action, target, reason, at_hour, prior_state
      FROM admin_actions ORDER BY id
    `) as unknown as AdminActionRow[];
    return rows.map((row): AdminActionSnapshot => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      target: row.target,
      reason: row.reason,
      atHour: row.at_hour,
      priorState: row.prior_state,
    }));
  }

  /**
   * 토큰 발급(admin 전용, 직접 호출 부트스트랩 — HTTP로 노출하지 않는다).
   * 원문 토큰은 이 응답에서만 반환되고 DB에는 sha256 해시만 저장된다.
   */
  async issueToken(rawContext: CommandContext, rawCommand: IssueTokenCommand): Promise<IssueTokenResult> {
    const context = validateContext(rawContext);
    requireAdminActor(context.actorId);
    if (!isPlainRecord(rawCommand)) throw new ServerError('INVALID_INPUT', '토큰 발급 명령은 객체여야 한다.');
    assertExactKeys(rawCommand, ISSUE_TOKEN_KEYS, 'issueToken');
    const actorId = validateId(rawCommand.actorId, 'actorId');
    if (typeof rawCommand.role !== 'string' || !TOKEN_ROLES.includes(rawCommand.role as TokenRole)) {
      throw new ServerError('INVALID_INPUT', `role은 ${TOKEN_ROLES.join('|')} 중 하나여야 한다.`);
    }
    const role = rawCommand.role as TokenRole;
    const reason = validateReason(rawCommand.reason, 'reason');
    const token = randomBytes(32).toString('hex');
    const tokenSha256 = sha256(token);
    try {
      return await this.adapter.transaction(async (tx) => {
        await tx.run(`
          INSERT INTO auth_tokens(token_sha256, actor_id, role, created_at_hour, revoked)
          VALUES (?, ?, ?, ?, 0)
        `, tokenSha256, actorId, role, context.nowHour);
        await insertAdminAction(tx, context, 'issue_token', `${role}:${actorId}`, reason, null);
        return { token, tokenSha256, actorId, role };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /** 토큰 폐기(admin 전용). 이미 폐기된 토큰은 멱등으로 성공을 재생한다. */
  async revokeToken(rawContext: CommandContext, rawCommand: RevokeTokenCommand): Promise<RevokeTokenResult> {
    const context = validateContext(rawContext);
    requireAdminActor(context.actorId);
    if (!isPlainRecord(rawCommand)) throw new ServerError('INVALID_INPUT', '토큰 폐기 명령은 객체여야 한다.');
    assertExactKeys(rawCommand, REVOKE_TOKEN_KEYS, 'revokeToken');
    if (typeof rawCommand.tokenSha256 !== 'string' || !SHA256_PATTERN.test(rawCommand.tokenSha256)) {
      throw new ServerError('INVALID_INPUT', 'tokenSha256는 64자 소문자 16진이어야 한다.');
    }
    const tokenSha256 = rawCommand.tokenSha256;
    const reason = validateReason(rawCommand.reason, 'reason');
    try {
      return await this.adapter.transaction(async (tx) => {
        const row = await tx.get(`
          SELECT token_sha256, actor_id, role, created_at_hour, revoked
          FROM auth_tokens WHERE token_sha256 = ?
        `, tokenSha256) as TokenRow | undefined;
        if (!row) throw new ServerError('NOT_FOUND', '폐기할 토큰이 없다.');
        if (row.revoked === 1) return { tokenSha256, revoked: true as const };
        const update = await tx.run(`
          UPDATE auth_tokens SET revoked = 1 WHERE token_sha256 = ? AND revoked = 0
        `, tokenSha256);
        if (update.changes !== 1) {
          throw new ServerError('DATA_INTEGRITY', '토큰 폐기 선행 조건이 맞지 않는다.');
        }
        await insertAdminAction(
          tx,
          context,
          'revoke_token',
          `${row.role}:${row.actor_id}`,
          reason,
          stableStringify({ actorId: row.actor_id, createdAtHour: row.created_at_hour, role: row.role }),
        );
        return { tokenSha256, revoked: true as const };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * 기기 계정 등록·재로그인(D-039). 스토어 배포에서 토큰 붙여넣기를 대체한다.
   *
   * 기기가 만든 무작위 비밀값을 받아 sha256만 저장하고 원문은 남기지 않는다.
   * 처음 보는 기기면 계정과 도시를 만들고, 이미 아는 기기면 기존 계정에 새 세션을 준다.
   * 이메일·비밀번호·기기 식별자를 받지 않으므로 개인식별정보를 저장하지 않는다.
   */
  async registerDevice(
    rawContext: Pick<CommandContext, 'nowHour'>,
    deviceSecret: unknown,
  ): Promise<DeviceSessionResult> {
    const nowHour = validateNonNegativeInteger(rawContext?.nowHour, 'nowHour');
    if (typeof deviceSecret !== 'string' || !DEVICE_SECRET_PATTERN.test(deviceSecret)) {
      throw new ServerError('INVALID_INPUT', 'deviceSecret은 32..128자 소문자 16진이어야 한다.');
    }
    const deviceSha256 = sha256(deviceSecret);
    const existing = await this.adapter.get(`
      SELECT id, device_sha256, city_id, created_at_hour FROM accounts WHERE device_sha256 = ?
    `, deviceSha256) as AccountRow | undefined;

    if (existing === undefined) {
      // 도시 생성은 seedCity의 검증을 그대로 쓴다(규칙 버전·시작 자원 중복 정의를 만들지 않는다).
      //
      // 규칙 버전과 시작 사령부 레벨을 반드시 명시한다. seedCity의 기본값은 캠페인 0.1.0이라
      // 최신 시나리오가 없고, 사령부 1레벨에서는 첫 목표인 농장 증설이 게이트에 막힌다(D-040).
      const suffix = deviceSha256.slice(0, 24);
      const actorId = `user:${suffix}`;
      const cityId = `city:${suffix}`;
      // 경제·캠페인 규칙 버전을 함께 명시한다. 둘이 어긋나면 campaignForCity가 거부한다.
      // 시작 건물 레벨은 규칙의 startingBuildings를 그대로 쓴다(사령부 2를 포함한다).
      await this.seedCity({
        cityId,
        ownerId: actorId,
        ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
        campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
        lastServerHour: nowHour,
      });
      try {
        await this.adapter.run(`
          INSERT INTO accounts(id, device_sha256, city_id, created_at_hour) VALUES (?, ?, ?, ?)
        `, actorId, deviceSha256, cityId, nowHour);
      } catch (error) {
        return mapDatabaseError(error);
      }
      const token = await this.mintSessionToken(actorId, nowHour);
      return { actorId, cityId, token, created: true };
    }

    const token = await this.mintSessionToken(existing.id, nowHour);
    return { actorId: existing.id, cityId: existing.city_id, token, created: false };
  }

  /** 세션 토큰 발급. 관리자 발급(issueToken)과 달리 감사 기록을 남기지 않는 플레이어 경로다. */
  private async mintSessionToken(actorId: string, nowHour: number): Promise<string> {
    const token = randomBytes(32).toString('hex');
    try {
      await this.adapter.run(`
        INSERT INTO auth_tokens(token_sha256, actor_id, role, created_at_hour, revoked)
        VALUES (?, ?, 'player', ?, 0)
      `, sha256(token), actorId, nowHour);
    } catch (error) {
      return mapDatabaseError(error);
    }
    return token;
  }

  /** 인증된 주체의 계정 정보. 앱이 자기 도시 ID를 서버에서 받아 오게 한다. */
  async getAccount(actorId: string): Promise<AccountSnapshot> {
    const row = await this.adapter.get(`
      SELECT id, device_sha256, city_id, created_at_hour FROM accounts WHERE id = ?
    `, validateId(actorId, 'actorId')) as AccountRow | undefined;
    if (!row) throw new ServerError('NOT_FOUND', '계정이 없다.');
    return { actorId: row.id, cityId: row.city_id, createdAtHour: row.created_at_hour };
  }

  /**
   * 계정과 그 도시의 모든 기록을 지운다.
   *
   * 스토어 요건이다 — Apple은 계정 생성이 있으면 앱 내 삭제를 요구하고 Google도 삭제 경로를 요구한다.
   * 되돌릴 수 없다. 외래키가 RESTRICT인 테이블이 섞여 있으므로 의존 순서대로 직접 지운다.
   */
  async deleteAccount(actorId: string): Promise<DeleteAccountResult> {
    const id = validateId(actorId, 'actorId');
    try {
      return await this.adapter.transaction(async (tx) => {
        const account = await tx.get(`
          SELECT id, device_sha256, city_id, created_at_hour FROM accounts WHERE id = ?
        `, id) as AccountRow | undefined;
        if (!account) throw new ServerError('NOT_FOUND', '삭제할 계정이 없다.');
        const cityId = account.city_id;
        // 의존 순서: 자식 → 부모. 순서를 바꾸면 RESTRICT에 걸린다.
        await tx.run('DELETE FROM npc_battle_reports WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM recon_reports WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM operation_ledger WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM operation_receipts WHERE city_id = ?', cityId);
        await tx.run(`
          DELETE FROM completion_effects
          WHERE job_id IN (SELECT id FROM construction_jobs WHERE city_id = ?)
        `, cityId);
        await tx.run(`
          DELETE FROM job_claims
          WHERE job_id IN (SELECT id FROM construction_jobs WHERE city_id = ?)
        `, cityId);
        await tx.run('DELETE FROM economy_ledger WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM command_receipts WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM construction_jobs WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM accounts WHERE id = ?', id);
        // city_resources·city_buildings·city_armies는 cities 삭제에 딸려 간다.
        await tx.run('DELETE FROM city_resources WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM city_buildings WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM city_armies WHERE city_id = ?', cityId);
        await tx.run('DELETE FROM cities WHERE id = ?', cityId);
        await tx.run('DELETE FROM auth_tokens WHERE actor_id = ?', id);
        await tx.run('DELETE FROM client_events WHERE actor_id = ?', id);
        return { actorId: id, cityId, deleted: true as const };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /**
   * HTTP 계층용 토큰 인증. 미지·폐기 토큰은 동일한 메시지로 거부해 존재 여부를 노출하지 않는다.
   */
  async authenticateToken(token: unknown): Promise<AuthenticatedActor> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      throw new ServerError('UNAUTHORIZED', '유효하지 않은 토큰이다.');
    }
    const tokenSha256 = sha256(token);
    const row = await this.adapter.get(`
      SELECT token_sha256, actor_id, role, created_at_hour, revoked
      FROM auth_tokens WHERE token_sha256 = ?
    `, tokenSha256) as TokenRow | undefined;
    if (!row || row.revoked === 1) {
      throw new ServerError('UNAUTHORIZED', '유효하지 않은 토큰이다.');
    }
    return { actorId: row.actor_id, role: row.role, tokenSha256 };
  }

  /**
   * 첫 루프 계측 이벤트를 append한다(schema v6).
   *
   * 주체는 토큰에서 유도한 context.actorId만 쓰고 payload의 주체 주장은 무시한다.
   * 같은 ID 재전송은 한 번만 저장한다(멱등). 계측 실패가 게임 진행을 막지 않도록
   * 호출자는 오류를 무시해도 된다.
   */
  async recordClientEvents(
    rawContext: CommandContext,
    rawEvents: readonly ClientEventInput[],
  ): Promise<RecordEventsResult> {
    const context = validateContext(rawContext);
    if (!Array.isArray(rawEvents)) {
      throw new ServerError('INVALID_EVENT', 'events는 배열이어야 한다.');
    }
    if (rawEvents.length === 0 || rawEvents.length > 50) {
      throw new ServerError('INVALID_EVENT', 'events는 1..50개여야 한다.');
    }
    const events = rawEvents.map((event) => validateClientEvent(event));
    try {
      return await this.adapter.transaction(async (tx) => {
        let stored = 0;
        for (const event of events) {
          const result = await tx.run(`
            INSERT OR IGNORE INTO client_events(
              id, session_id, actor_id, name, subject, outcome, client_seq, server_hour
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          event.id,
          event.sessionId,
          context.actorId,
          event.name,
          event.subject ?? null,
          event.outcome ?? null,
          event.clientSeq,
          context.nowHour);
          stored += result.changes;
        }
        return { received: events.length, stored };
      });
    } catch (error) {
      return mapDatabaseError(error);
    }
  }

  /** 깔때기 조회: 이벤트별 발생 수와 고유 세션 수. */
  async listFunnel(): Promise<FunnelRow[]> {
    const rows = await this.adapter.all(`
      SELECT name, subject, outcome,
             COUNT(*) AS events,
             COUNT(DISTINCT session_id) AS sessions
      FROM client_events
      GROUP BY name, subject, outcome
      ORDER BY name, subject, outcome
    `) as unknown as {
      name: ClientEventName;
      subject: ClientEventSubject | null;
      outcome: string | null;
      events: number;
      sessions: number;
    }[];
    return rows.map((row): FunnelRow => ({
      name: row.name,
      subject: row.subject,
      outcome: row.outcome,
      events: row.events,
      sessions: row.sessions,
    }));
  }

  /** 관측·운영용 claim 조회. cityId를 주면 해당 도시의 job claim만 반환한다. */
  async listJobClaims(cityIdInput?: string): Promise<JobClaimSnapshot[]> {
    const rows = cityIdInput === undefined
      ? await this.adapter.all(`
          SELECT job_id, worker_id, state, attempt_count, claimed_at_hour, lease_until_hour, last_error
          FROM job_claims ORDER BY job_id
        `) as unknown as ClaimRow[]
      : await this.adapter.all(`
          SELECT c.job_id, c.worker_id, c.state, c.attempt_count, c.claimed_at_hour,
                 c.lease_until_hour, c.last_error
          FROM job_claims c
          JOIN construction_jobs j ON j.id = c.job_id
          WHERE j.city_id = ?
          ORDER BY c.job_id
        `, validateId(cityIdInput, 'cityId')) as unknown as ClaimRow[];
    return rows.map((row): JobClaimSnapshot => ({
      jobId: row.job_id,
      workerId: row.worker_id,
      state: row.state,
      attemptCount: row.attempt_count,
      claimedAtHour: row.claimed_at_hour,
      leaseUntilHour: row.lease_until_hour,
      lastError: row.last_error,
    }));
  }

  async mobilizeUnits(
    context: CommandContext,
    command: MobilizeUnitsCommand,
  ): Promise<CommandExecution<MobilizeUnitsResponse>> {
    return await this.operationService.mobilizeUnits(context, command);
  }

  async reconNpc(
    context: CommandContext,
    command: ReconNpcCommand,
  ): Promise<CommandExecution<ReconNpcResponse>> {
    return await this.operationService.reconNpc(context, command);
  }

  async attackNpc(
    context: CommandContext,
    command: AttackNpcCommand,
  ): Promise<CommandExecution<AttackNpcResponse>> {
    return await this.operationService.attackNpc(context, command);
  }

  /** 연구 단계를 하나 올린다(D-044). */
  async advanceResearch(
    context: CommandContext,
    command: AdvanceResearchCommand,
  ): Promise<CommandExecution<AdvanceResearchResponse>> {
    return await this.operationService.advanceResearch(context, command);
  }

  /** 부상병 회복을 예약한다(D-045). */
  async recoverUnits(
    context: CommandContext,
    command: RecoverUnitsCommand,
  ): Promise<CommandExecution<RecoverUnitsResponse>> {
    return await this.operationService.recoverUnits(context, command);
  }

  /** 도시 이름을 바꾼다(D-054). */
  async renameCity(
    context: CommandContext,
    command: RenameCityCommand,
  ): Promise<CommandExecution<RenameCityResponse>> {
    return await this.operationService.renameCity(context, command);
  }

  /** 생산 정산이 밀린 도시. 워커가 쓴다(D-045). */
  async citiesNeedingProduction(nowHour: number, limit: number): Promise<readonly string[]> {
    return await this.operationService.citiesNeedingProduction(nowHour, limit);
  }

  /** 한 도시의 시간당 생산을 정산한다. 정산할 것이 없으면 null. */
  async creditProduction(
    context: CommandContext,
    command: CreditProductionCommand,
  ): Promise<CommandExecution<CreditProductionResponse> | null> {
    return await this.operationService.creditProduction(context, command);
  }

  /** 시간이 된 회복 job. 워커가 쓴다. */
  async dueRecoveryJobs(nowHour: number, limit: number): Promise<readonly string[]> {
    return await this.operationService.dueRecoveryJobs(nowHour, limit);
  }

  /** 회복 완료. 조건부 UPDATE가 멱등을 보장하므로 재실행이 안전하다. */
  async completeRecovery(
    context: CommandContext,
    command: CompleteRecoveryCommand,
  ): Promise<CommandExecution<CompleteRecoveryResponse>> {
    return await this.operationService.completeRecovery(context, command);
  }

  async getOperations(cityId: string): Promise<OperationSnapshot> {
    return await this.operationService.getOperations(cityId);
  }

  async getCity(cityIdInput: string): Promise<CitySnapshot> {
    const cityId = validateId(cityIdInput, 'cityId');
    return await this.adapter.transaction(async (tx) => {
    const city = await cityRow(tx, cityId);
    if (!city) throw new ServerError('NOT_FOUND', `도시를 찾을 수 없다: ${cityId}`);
    const resourcesMicro = Object.fromEntries(RESOURCE_IDS.map((resourceId) => [resourceId, 0])) as Record<
      ResourceId,
      number
    >;
    const resourceRows = await tx.all(`
      SELECT resource_id, balance_micro FROM city_resources WHERE city_id = ? ORDER BY resource_id
    `, city.id) as unknown as ResourceRow[];
    if (resourceRows.length !== RESOURCE_IDS.length) {
      throw new ServerError('DATA_INTEGRITY', '도시 자원 행 수가 완전하지 않다.');
    }
    for (const row of resourceRows) resourcesMicro[row.resource_id as ResourceId] = row.balance_micro;
    // 이 도시가 가져야 할 건물 집합은 도시의 경제 규칙이 정한다(D-043).
    // 전역 BUILDING_IDS로 개수를 재면 규칙 버전이 다른 도시가 전부 DATA_INTEGRITY로 죽는다.
    const expectedBuildingIds = cityBuildingIds(rulesFor(city.rule_version));
    const buildings = Object.fromEntries(
      expectedBuildingIds.map((buildingId) => [buildingId, 0]),
    ) as Record<BuildingId, number>;
    const buildingRows = await tx.all(`
      SELECT building_id, level FROM city_buildings WHERE city_id = ? ORDER BY building_id
    `, city.id) as unknown as BuildingRow[];
    if (buildingRows.length !== expectedBuildingIds.length) {
      throw new ServerError('DATA_INTEGRITY', '도시 건물 행 수가 규칙과 다르다.');
    }
    for (const row of buildingRows) buildings[row.building_id as BuildingId] = row.level;
    const jobs = (await tx.all(`
      SELECT id, city_id, building_id, target_level, rule_version,
             started_at_hour, completes_at_hour, effective_at_hour, processed_at_hour, status
      FROM construction_jobs WHERE city_id = ? ORDER BY started_at_hour, id
    `, city.id) as unknown as JobRow[]).map((row): ConstructionJobSnapshot => ({
      id: row.id,
      cityId: row.city_id,
      buildingId: row.building_id as BuildingId,
      targetLevel: row.target_level,
      ruleVersion: row.rule_version,
      startedAtHour: row.started_at_hour,
      completesAtHour: row.completes_at_hour,
      effectiveAtHour: row.effective_at_hour,
      processedAtHour: row.processed_at_hour,
      status: row.status,
    }));
    const ledger = (await tx.all(`
      SELECT id, city_id, command_id, job_id, resource_id, reason,
             delta_micro, balance_before_micro, balance_after_micro, created_at_hour
      FROM economy_ledger WHERE city_id = ? ORDER BY rowid
    `, city.id) as unknown as LedgerRow[]).map((row): LedgerSnapshot => ({
      id: row.id,
      cityId: row.city_id,
      commandId: row.command_id,
      jobId: row.job_id,
      resourceId: row.resource_id as ResourceId,
      reason: row.reason,
      deltaMicro: row.delta_micro,
      balanceBeforeMicro: row.balance_before_micro,
      balanceAfterMicro: row.balance_after_micro,
      createdAtHour: row.created_at_hour,
    }));
    const receipts = (await tx.all(`
      SELECT actor_id, command_id, city_id, command_kind, payload_sha256,
             payload_json, response_json, created_at_hour
      FROM command_receipts WHERE city_id = ? ORDER BY rowid
    `, city.id) as unknown as ReceiptRow[]).map((row): ReceiptSnapshot => ({
      actorId: row.actor_id,
      commandId: row.command_id,
      cityId: row.city_id,
      commandKind: row.command_kind,
      payloadSha256: row.payload_sha256,
      payloadJson: row.payload_json,
      responseJson: row.response_json,
      createdAtHour: row.created_at_hour,
    }));
    const effectCount = await tx.get(`
      SELECT COUNT(*) AS count FROM completion_effects ce
      JOIN construction_jobs cj ON cj.id = ce.job_id WHERE cj.city_id = ?
    `, city.id) as { count: number };
    return {
      id: city.id,
      ownerId: city.owner_id,
      ruleVersion: city.rule_version,
      campaignRuleVersion: city.campaign_rule_version,
      version: city.version,
      lastServerHour: city.last_server_hour,
      resourcesMicro,
      buildings,
      jobs,
      ledger,
      receipts,
      completionEffectCount: effectCount.count,
    };
    });
  }

  async sqliteVersion(): Promise<string> {
    return await this.adapter.backendVersion();
  }
}

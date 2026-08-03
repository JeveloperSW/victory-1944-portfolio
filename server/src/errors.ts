export type ServerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_ID'
  | 'UNKNOWN_BUILDING'
  | 'UNKNOWN_UNIT'
  | 'UNKNOWN_SCENARIO'
  | 'SCENARIO_LOCKED'
  | 'UNIT_LOCKED'
  | 'UNKNOWN_RESEARCH'
  | 'RESEARCH_LAB_REQUIRED'
  | 'RESEARCH_PREREQUISITE'
  | 'UNKNOWN_DOCTRINE'
  /** 도시 이름이 규칙에 맞지 않는다(D-054). */
  | 'INVALID_CITY_NAME'
  /** 사양에는 있으나 효과를 내는 시스템이 아직 없어 거부한다(D-044). */
  | 'SYSTEM_NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'STALE_VERSION'
  | 'VERSION_EXHAUSTED'
  | 'TIME_REVERSED'
  | 'BUILD_SLOT_FULL'
  | 'BUILDING_ALREADY_PENDING'
  | 'MAX_LEVEL'
  | 'HQ_LEVEL_REQUIRED'
  | 'INSUFFICIENT_RESOURCES'
  | 'INSUFFICIENT_UNITS'
  | 'SCOUT_REQUIRED'
  | 'RECON_REQUIRED'
  | 'RECON_EXPIRED'
  | 'TOO_EARLY'
  | 'CLAIM_EXPIRED'
  | 'NOT_DEAD_LETTER'
  | 'UNAUTHORIZED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_EVENT'
  | 'UNSUPPORTED_RUNTIME'
  | 'UNSUPPORTED_SCHEMA'
  | 'DB_BUSY_RETRYABLE'
  | 'DATA_INTEGRITY'
  | 'DATABASE_FAILURE';

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly retryable: boolean;

  constructor(code: ServerErrorCode, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(`[${code}] ${message}`, { cause: options?.cause });
    this.name = 'ServerError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

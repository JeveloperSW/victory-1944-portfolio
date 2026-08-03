import type { HealthResponse, OperationsSnapshot, Row } from './contract.js';

/**
 * 서버 권위 API 클라이언트.
 * - 토큰은 메모리와 localStorage에만 두고 화면·로그에 원문을 노출하지 않는다.
 * - 명령은 멱등 `commandId`를 갖고, 재시도는 같은 id를 재사용해 서버 멱등성에 위임한다.
 * - 오류는 서버가 준 코드를 그대로 보존한다(화면이 임의 해석하지 않는다).
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 서버 오류 코드 → 플레이어에게 보여줄 안내. 없으면 서버 메시지를 그대로 쓴다. */
const GUIDANCE: Readonly<Record<string, string>> = {
  UNAUTHORIZED: '토큰이 유효하지 않습니다. 연결 화면에서 다시 입력하십시오.',
  FORBIDDEN: '이 도시에 대한 권한이 없습니다.',
  STALE_VERSION: '도시 상태가 바뀌었습니다. 최신 상태를 불러온 뒤 다시 시도하십시오.',
  INSUFFICIENT_RESOURCES: '자원이 부족합니다.',
  INSUFFICIENT_UNITS: '가용 병력이 부족합니다.',
  BUILD_SLOT_FULL: '동시 건설 슬롯이 가득 찼습니다.',
  BUILDING_ALREADY_PENDING: '같은 건물의 건설이 이미 진행 중입니다.',
  MAX_LEVEL: '이미 최대 레벨입니다.',
  HQ_LEVEL_REQUIRED: '사령부 레벨이 부족합니다.',
  SCOUT_REQUIRED: '정찰차량이 필요합니다.',
  RECON_REQUIRED: '먼저 정찰해야 합니다.',
  SCENARIO_LOCKED: '아직 열리지 않은 목표입니다. 앞 단계를 먼저 격파하십시오.',
  UNIT_LOCKED: '이 병종은 아직 해금되지 않았습니다.',
  SYSTEM_NOT_IMPLEMENTED: '이 건물은 아직 효과가 없어 지을 수 없습니다.',
  INVALID_CITY_NAME: '쓸 수 없는 이름입니다. 24자 이내로, 보이지 않는 문자나 여는 대괄호 없이 적어 주십시오.',
  UNKNOWN_RESEARCH: '알 수 없는 연구입니다.',
  RESEARCH_LAB_REQUIRED: '연구소 레벨이 부족합니다.',
  RESEARCH_PREREQUISITE: '선행 연구를 먼저 완료해야 합니다.',
  UNKNOWN_SCENARIO: '알 수 없는 목표입니다.',
  RECON_EXPIRED: '정찰 보고서가 만료되었습니다. 다시 정찰한 뒤 공격하십시오.',
  DB_BUSY_RETRYABLE: '서버가 잠시 바쁩니다. 다시 시도하십시오.',
};

export function guidanceFor(error: unknown): string {
  if (error instanceof ApiError) {
    return GUIDANCE[error.code] ?? error.message;
  }
  if (error instanceof TypeError) {
    return '서버에 연결할 수 없습니다. 서버 주소와 앱 개발 서버 실행 상태를 확인하십시오.';
  }
  return error instanceof Error ? error.message : String(error);
}

export interface Session {
  readonly baseUrl: string;
  readonly token: string;
  readonly cityId: string;
}

const SESSION_KEY = 'victory1944.session.v1';
const DEVICE_KEY = 'victory1944.device.v1';

/**
 * API 주소는 빌드 시 주입한다(D-039).
 * 이용자에게 서버 주소를 입력시키는 화면은 스토어 배포에 부적합하다.
 * 값이 없으면 로컬 개발 서버로 떨어지며, 실서비스 빌드는 HTTPS 주소를 반드시 넣어야 한다.
 */
export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const value = typeof configured === 'string' && configured.length > 0
    ? configured
    : 'http://127.0.0.1:8150';
  return value.replace(/\/+$/, '');
}

export function isInsecureApi(): boolean {
  return apiBaseUrl().startsWith('http://');
}

/**
 * 이 기기의 비밀값. 최초 1회 만들어 저장하고 이후 계속 쓴다.
 * 이메일·비밀번호를 받지 않는 대신 이 값이 계정 열쇠이며, 서버는 sha256만 보관한다.
 * 기기를 잃으면 계정도 잃는다 — 계정 이전은 아직 없다.
 */
function deviceSecret(): string {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const created = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.token !== 'string' || typeof record.cityId !== 'string') return null;
    // 주소는 저장값이 아니라 항상 빌드 설정을 따른다(서버 이전 시 헌 주소에 묶이지 않게).
    return { baseUrl: apiBaseUrl(), token: record.token, cityId: record.cityId };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ token: session.token, cityId: session.cityId }),
  );
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** 기기 비밀값까지 지운다. 계정 삭제 뒤에만 쓴다 — 다음 실행은 새 계정이 된다. */
export function clearDevice(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(DEVICE_KEY);
}

export interface DeviceSession {
  readonly actorId: string;
  readonly cityId: string;
  readonly token: string;
  readonly created: boolean;
}

/**
 * 저장된 세션이 있으면 그대로 쓰고, 없으면 기기 비밀값으로 계정을 만들거나 다시 로그인한다.
 * 이용자는 아무것도 입력하지 않는다.
 */
export async function openSession(): Promise<Session> {
  const existing = loadSession();
  if (existing !== null) return existing;
  const baseUrl = apiBaseUrl();
  const response = await fetch(`${baseUrl}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceSecret: deviceSecret() }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError('INVALID_RESPONSE', '서버 응답을 해석할 수 없습니다.', response.status);
    }
  }
  if (!response.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    throw new ApiError(
      typeof record.code === 'string' ? record.code : 'UNKNOWN',
      typeof record.message === 'string' ? record.message : '세션을 열지 못했습니다.',
      response.status,
    );
  }
  const result = parsed as DeviceSession;
  const session: Session = { baseUrl, token: result.token, cityId: result.cityId };
  saveSession(session);
  return session;
}

/** 명령 멱등 키. 재시도 시 호출자가 같은 값을 재사용한다. */
export function newCommandId(kind: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${kind}:${random[0]!.toString(16)}${random[1]!.toString(16)}`.slice(0, 64);
}

export interface MobilizeUnit {
  readonly unitId: string;
  readonly count: number;
}

export interface DeploymentEntry {
  readonly unitId: string;
  readonly count: number;
  readonly row: Row;
}

export class GameApi {
  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  get cityId(): string {
    return this.session.cityId;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.session.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.session.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError('INVALID_RESPONSE', '서버 응답을 해석할 수 없습니다.', response.status);
      }
    }
    if (!response.ok) {
      const record = (parsed ?? {}) as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
      const message = typeof record.message === 'string' ? record.message : '요청이 거부되었습니다.';
      throw new ApiError(code, message, response.status);
    }
    return parsed as T;
  }

  /** 계측 배치 전송. 실패는 호출자가 무시한다. */
  recordEvents(events: readonly unknown[]): Promise<unknown> {
    return this.request('POST', '/v1/events', { events });
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  account(): Promise<{ actorId: string; cityId: string; createdAtHour: number }> {
    return this.request('GET', '/v1/account');
  }

  /** 계정과 도시 기록을 서버에서 지운다. 되돌릴 수 없다(스토어 요건). */
  deleteAccount(): Promise<unknown> {
    return this.request('DELETE', '/v1/account');
  }

  operations(): Promise<OperationsSnapshot> {
    return this.request<OperationsSnapshot>(
      'GET',
      `/v1/cities/${encodeURIComponent(this.session.cityId)}/operations`,
    );
  }

  private commandPath(suffix: string): string {
    return `/v1/cities/${encodeURIComponent(this.session.cityId)}/${suffix}`;
  }

  startConstruction(commandId: string, expectedVersion: number, buildingId: string): Promise<unknown> {
    return this.request('POST', this.commandPath('constructions'), {
      commandId,
      expectedVersion,
      buildingId,
    });
  }

  /** 연구 단계를 하나 올린다(D-044). */
  advanceResearch(
    commandId: string,
    expectedVersion: number,
    researchId: string,
    targetLevel: number,
  ): Promise<unknown> {
    return this.request('POST', this.commandPath('research'), {
      commandId,
      expectedVersion,
      researchId,
      targetLevel,
    });
  }

  /** 도시 이름을 바꾼다(D-054). 정규화·검증은 서버가 한다. */
  renameCity(commandId: string, expectedVersion: number, name: string): Promise<unknown> {
    return this.request('POST', this.commandPath('name'), { commandId, expectedVersion, name });
  }

  /** 부상병 회복을 예약한다(D-045). 보급품은 예약 시 나간다. */
  recoverUnits(
    commandId: string,
    expectedVersion: number,
    units: readonly MobilizeUnit[],
  ): Promise<unknown> {
    return this.request('POST', this.commandPath('recoveries'), {
      commandId,
      expectedVersion,
      units: units.map((unit) => ({ unitId: unit.unitId, count: unit.count })),
    });
  }

  mobilize(commandId: string, expectedVersion: number, units: readonly MobilizeUnit[]): Promise<unknown> {
    return this.request('POST', this.commandPath('mobilizations'), {
      commandId,
      expectedVersion,
      units: units.map((unit) => ({ unitId: unit.unitId, count: unit.count })),
    });
  }

  recon(commandId: string, expectedVersion: number, scenarioId: string): Promise<unknown> {
    return this.request('POST', this.commandPath('recon'), {
      commandId,
      expectedVersion,
      scenarioId,
    });
  }

  attack(
    commandId: string,
    expectedVersion: number,
    scenarioId: string,
    doctrine: string,
    deployment: readonly DeploymentEntry[],
  ): Promise<unknown> {
    return this.request('POST', this.commandPath('battles'), {
      commandId,
      expectedVersion,
      scenarioId,
      doctrine,
      deployment: deployment.map((entry) => ({
        unitId: entry.unitId,
        count: entry.count,
        row: entry.row,
      })),
    });
  }
}

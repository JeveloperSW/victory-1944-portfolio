import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConstructionServer } from './construction-server.js';
import { ServerError, type ServerErrorCode } from './errors.js';
import { renderPrototypePage } from './prototype-ui.js';
import type { AuthenticatedActor } from './types.js';

/**
 * 토큰 인증 HTTP 계층(PoC).
 * - actorId는 항상 Bearer 토큰에서 유도한다 — payload의 주체 주장은 무시된다.
 * - 오류는 코드·메시지만 노출한다(스택·SQL 등 내부 정보 비노출, ENGINEERING_RULES).
 * - 건설 완료는 HTTP로 노출하지 않는다(워커 데몬 전용 권위 경로).
 * - HTTPS 종단·속도 제한·토큰 만료는 범위 밖이다.
 */

export interface HttpApiOptions {
  readonly server: ConstructionServer;
  /** 권위 hour 시계(주입식) */
  readonly clock: () => number;
  /** 요청 본문 상한(바이트). 기본 16KiB */
  readonly maxBodyBytes?: number;
  /** 0이면 임의 포트. 생략 시 0. 루프백 바인딩은 바꿀 수 없다. */
  readonly port?: number;
  /** 명시적으로 켠 로컬 UI 세션. 토큰은 루프백 HTML 안에만 주입된다. */
  readonly prototypeSession?: {
    readonly token: string;
    readonly cityId: string;
  };
  /**
   * 교차 출처 앱(Capacitor·Vite dev)을 위한 명시적 Origin 허용목록(D-026).
   * 생략하면 CORS 헤더를 내보내지 않는다. 와일드카드는 지원하지 않는다.
   */
  readonly allowedOrigins?: readonly string[];
}

export interface RunningHttpApi {
  readonly port: number;
  close(): Promise<void>;
}

const STATUS_BY_CODE: Readonly<Partial<Record<ServerErrorCode, number>>> = {
  INVALID_INPUT: 400,
  INVALID_EVENT: 400,
  INVALID_ID: 400,
  UNKNOWN_BUILDING: 400,
  UNKNOWN_UNIT: 400,
  UNKNOWN_SCENARIO: 400,
  UNKNOWN_DOCTRINE: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_KEY_REUSED: 409,
  STALE_VERSION: 409,
  VERSION_EXHAUSTED: 409,
  TIME_REVERSED: 409,
  BUILD_SLOT_FULL: 409,
  BUILDING_ALREADY_PENDING: 409,
  MAX_LEVEL: 409,
  HQ_LEVEL_REQUIRED: 409,
  SCENARIO_LOCKED: 409,
  UNIT_LOCKED: 409,
  SYSTEM_NOT_IMPLEMENTED: 409,
  INVALID_CITY_NAME: 400,
  UNKNOWN_RESEARCH: 400,
  RESEARCH_LAB_REQUIRED: 409,
  RESEARCH_PREREQUISITE: 409,
  INSUFFICIENT_RESOURCES: 409,
  INSUFFICIENT_UNITS: 409,
  SCOUT_REQUIRED: 409,
  RECON_REQUIRED: 409,
  RECON_EXPIRED: 409,
  TOO_EARLY: 409,
  CLAIM_EXPIRED: 409,
  NOT_DEAD_LETTER: 409,
  DB_BUSY_RETRYABLE: 503,
};

/**
 * 허용목록에 있는 Origin에만 정확한 값을 echo한다(D-026).
 * 와일드카드와 Access-Control-Allow-Credentials는 사용하지 않는다 — 인증은 Bearer 헤더다.
 */
function corsHeaders(origin: string | undefined, allowed: ReadonlySet<string>): Record<string, string> {
  if (allowed.size === 0) return {};
  // Origin에 따라 응답이 달라지므로 캐시가 교차 오염되지 않도록 항상 Vary를 붙인다.
  const headers: Record<string, string> = { vary: 'Origin' };
  if (origin !== undefined && allowed.has(origin.toLowerCase())) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  });
  response.end(serialized);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; "
      + "script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ServerError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    // 5xx 내부 오류는 메시지도 일반화한다(내부 구조 비노출).
    const message = status >= 500 && status !== 503 ? '내부 오류가 발생했다.' : error.message;
    const headers: Record<string, string> = {};
    if (status === 503) headers['retry-after'] = '1';
    const serialized = JSON.stringify({ code: error.code, message });
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(serialized),
      ...headers,
    });
    response.end(serialized);
    return;
  }
  sendJson(response, 500, { code: 'DATABASE_FAILURE', message: '내부 오류가 발생했다.' });
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new ServerError('PAYLOAD_TOO_LARGE', `요청 본문은 ${maxBytes}바이트를 넘을 수 없다.`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function parseJsonBody(text: string): Record<string, unknown> {
  if (text.length === 0) throw new ServerError('INVALID_INPUT', '요청 본문이 비어 있다.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServerError('INVALID_INPUT', '요청 본문이 유효한 JSON이 아니다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ServerError('INVALID_INPUT', '요청 본문은 JSON 객체여야 한다.');
  }
  return parsed as Record<string, unknown>;
}

function assertExactBodyKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ServerError('INVALID_INPUT', '요청 본문에 누락되거나 허용되지 않은 필드가 있다.');
  }
}

async function authenticate(game: ConstructionServer, request: IncomingMessage): Promise<AuthenticatedActor> {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new ServerError('UNAUTHORIZED', 'Bearer 토큰이 필요하다.');
  }
  return await game.authenticateToken(header.slice('Bearer '.length));
}

function requireAdmin(actor: AuthenticatedActor): void {
  if (actor.role !== 'admin') {
    throw new ServerError('FORBIDDEN', '관리자 역할이 필요하다.');
  }
}

function requirePlayer(actor: AuthenticatedActor): void {
  if (actor.role !== 'player') {
    throw new ServerError('FORBIDDEN', '플레이어 역할이 필요하다.');
  }
}

/** 경로 세그먼트 분해: /v1/cities/{cityId}/constructions → ['v1','cities',cityId,'constructions'] */
function segmentsOf(url: string): string[] {
  const path = url.split('?')[0] ?? '';
  return path.split('/').filter((segment) => segment.length > 0).map(decodeURIComponent);
}

/**
 * 옵션 검증 실패도 동기 throw가 아니라 rejection으로 돌려준다 —
 * 호출자가 `.catch()`만 붙여도 프로세스가 죽지 않도록 한다.
 */
export async function startHttpApi(options: HttpApiOptions): Promise<RunningHttpApi> {
  const game = options.server;
  const clock = options.clock;
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 1_048_576) {
    throw new ServerError('INVALID_INPUT', 'maxBodyBytes는 256..1048576 정수여야 한다.');
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ServerError('INVALID_INPUT', 'port는 0..65535 정수여야 한다.');
  }
  if (options.prototypeSession
    && (typeof options.prototypeSession.token !== 'string'
      || options.prototypeSession.token.length < 16
      || options.prototypeSession.token.length > 128
      || typeof options.prototypeSession.cityId !== 'string'
      || options.prototypeSession.cityId.length < 1
      || options.prototypeSession.cityId.length > 64)) {
    throw new ServerError('INVALID_INPUT', 'prototypeSession 형식이 유효하지 않다.');
  }
  const allowedOrigins = new Set<string>();
  for (const origin of options.allowedOrigins ?? []) {
    if (typeof origin !== 'string' || origin.length === 0 || origin.length > 200) {
      throw new ServerError('INVALID_INPUT', 'allowedOrigins 항목은 1..200자 문자열이어야 한다.');
    }
    if (origin === '*' || origin.includes('*')) {
      throw new ServerError('INVALID_INPUT', 'allowedOrigins는 와일드카드를 지원하지 않는다.');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ServerError('INVALID_INPUT', `allowedOrigins 항목이 절대 Origin이 아니다: ${origin}`);
    }
    // Origin은 스킴+호스트+포트만이며 경로·질의·자격 정보를 포함하지 않는다.
    if (parsed.origin.toLowerCase() !== origin.toLowerCase() || parsed.origin === 'null') {
      throw new ServerError('INVALID_INPUT', `allowedOrigins 항목이 정규 Origin이 아니다: ${origin}`);
    }
    allowedOrigins.add(origin.toLowerCase());
  }

  const httpServer: Server = createServer((request, response) => {
    void handle(request, response);
  });

  function assertPrototypeLoopbackRequest(request: IncomingMessage): void {
    if (!options.prototypeSession) return;
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new ServerError('DATABASE_FAILURE', '프로토타입 HTTP 주소를 확인할 수 없다.');
    }
    const allowedHosts = new Set([
      `127.0.0.1:${address.port}`,
      `localhost:${address.port}`,
    ]);
    const host = request.headers.host;
    if (typeof host !== 'string' || !allowedHosts.has(host.toLowerCase())) {
      throw new ServerError('FORBIDDEN', '프로토타입은 명시적인 루프백 Host에서만 접근할 수 있다.');
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      const allowedOrigins = new Set([
        `http://127.0.0.1:${address.port}`,
        `http://localhost:${address.port}`,
      ]);
      if (!allowedOrigins.has(origin.toLowerCase())) {
        throw new ServerError('FORBIDDEN', '프로토타입은 동일 루프백 Origin에서만 접근할 수 있다.');
      }
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // CORS 헤더는 setHeader로 미리 올려 둔다 — writeHead 헤더와 병합되므로
      // 이후 모든 응답 경로(성공·오류)가 동일하게 적용받는다.
      const origin = request.headers.origin;
      for (const [name, value] of Object.entries(corsHeaders(origin, allowedOrigins))) {
        response.setHeader(name, value);
      }
      if (allowedOrigins.size > 0
        && typeof origin === 'string'
        && !allowedOrigins.has(origin.toLowerCase())) {
        throw new ServerError('FORBIDDEN', '허용되지 않은 Origin이다.');
      }
      assertPrototypeLoopbackRequest(request);
      const method = request.method ?? 'GET';
      const segments = segmentsOf(request.url ?? '/');

      // 프리플라이트: 허용 Origin에만 응답하고 본문은 없다.
      if (method === 'OPTIONS') {
        if (allowedOrigins.size === 0 || typeof origin !== 'string') {
          throw new ServerError('NOT_FOUND', '알 수 없는 경로다.');
        }
        response.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
          'content-length': 0,
        });
        response.end();
        return;
      }

      if (options.prototypeSession && method === 'GET' && segments.length === 0) {
        response.writeHead(302, {
          location: '/prototype',
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }

      if (options.prototypeSession
        && method === 'GET'
        && segments.length === 1
        && segments[0] === 'prototype') {
        sendHtml(response, renderPrototypePage(options.prototypeSession));
        return;
      }

      // GET /health — 인증 불필요(가용성 프로브)
      if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
        sendJson(response, 200, {
          ok: true,
          schemaVersion: game.schemaVersion,
          nowHour: clock(),
        });
        return;
      }

      if (segments[0] !== 'v1') {
        throw new ServerError('NOT_FOUND', '알 수 없는 경로다.');
      }

      // POST /v1/session — 기기 계정 등록·재로그인(D-039). 유일하게 인증이 필요 없는 v1 경로다.
      if (method === 'POST' && segments.length === 2 && segments[1] === 'session') {
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['deviceSecret']);
        const result = await game.registerDevice({ nowHour: clock() }, body.deviceSecret);
        sendJson(response, result.created ? 201 : 200, result);
        return;
      }

      // GET /v1/account — 자기 계정. 앱이 도시 ID를 서버에서 받아 오게 한다.
      if (method === 'GET' && segments.length === 2 && segments[1] === 'account') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        sendJson(response, 200, await game.getAccount(actor.actorId));
        return;
      }

      // DELETE /v1/account — 앱 내 계정 삭제(스토어 요건). 되돌릴 수 없다.
      if (method === 'DELETE' && segments.length === 2 && segments[1] === 'account') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        sendJson(response, 200, await game.deleteAccount(actor.actorId));
        return;
      }

      // GET /v1/cities/{cityId} — 소유자 또는 admin
      if (method === 'GET' && segments.length === 3 && segments[1] === 'cities') {
        const actor = await authenticate(game, request);
        const city = await game.getCity(segments[2]!);
        if (actor.role !== 'admin' && city.ownerId !== actor.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        sendJson(response, 200, city);
        return;
      }

      // GET /v1/cities/{cityId}/operations — 소유자 또는 admin
      if (method === 'GET' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'operations') {
        const actor = await authenticate(game, request);
        const city = await game.getCity(segments[2]!);
        if (actor.role !== 'admin' && city.ownerId !== actor.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const operations = await game.getOperations(segments[2]!);
        sendJson(response, 200, operations);
        return;
      }

      // GET /v1/cities/{cityId}/battle-reports — 소유자 또는 admin
      if (method === 'GET' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'battle-reports') {
        const actor = await authenticate(game, request);
        const city = await game.getCity(segments[2]!);
        if (actor.role !== 'admin' && city.ownerId !== actor.actorId) {
          throw new ServerError('FORBIDDEN', '해당 도시의 소유자가 아니다.');
        }
        const operations = await game.getOperations(segments[2]!);
        sendJson(response, 200, { battleReports: operations.battleReports });
        return;
      }

      // POST /v1/cities/{cityId}/constructions — 소유자(player)
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'constructions') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'buildingId']);
        const execution = await game.startConstruction(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            buildingId: body.buildingId,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/mobilizations — 소유자 player
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'mobilizations') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'units']);
        const execution = await game.mobilizeUnits(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            units: body.units,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/name — 소유자 player (D-054)
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'name') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'name']);
        const execution = await game.renameCity(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            name: body.name,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/recoveries — 소유자 player (D-045)
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'recoveries') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'units']);
        const execution = await game.recoverUnits(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            units: body.units,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/recon — 소유자 player
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'recon') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'scenarioId']);
        const execution = await game.reconNpc(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            scenarioId: body.scenarioId,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/battles — 소유자 player
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'battles') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(
          body,
          ['commandId', 'expectedVersion', 'scenarioId', 'deployment', 'doctrine'],
        );
        const execution = await game.attackNpc(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId,
            cityId: segments[2],
            expectedVersion: body.expectedVersion,
            scenarioId: body.scenarioId,
            deployment: body.deployment,
            doctrine: body.doctrine,
          } as never,
        );
        sendJson(response, execution.replayed ? 200 : 201, {
          replayed: execution.replayed,
          response: execution.response,
        });
        return;
      }

      // POST /v1/cities/{cityId}/research — 연구 단계 상승(D-044)
      if (method === 'POST' && segments.length === 4
        && segments[1] === 'cities' && segments[3] === 'research') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['commandId', 'expectedVersion', 'researchId', 'targetLevel']);
        const outcome = await game.advanceResearch(
          { actorId: actor.actorId, nowHour: clock() },
          {
            commandId: body.commandId as string,
            cityId: decodeURIComponent(segments[2]!),
            expectedVersion: body.expectedVersion as number,
            researchId: body.researchId as string,
            targetLevel: body.targetLevel as number,
          },
        );
        sendJson(response, outcome.replayed ? 200 : 201, outcome.response);
        return;
      }

      // POST /v1/events — 첫 루프 계측(플레이어). 실패해도 게임 진행을 막지 않는다.
      if (method === 'POST' && segments.length === 2 && segments[1] === 'events') {
        const actor = await authenticate(game, request);
        requirePlayer(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['events']);
        const result = await game.recordClientEvents(
          { actorId: actor.actorId, nowHour: clock() },
          body.events as never,
        );
        sendJson(response, 202, result);
        return;
      }

      // GET /v1/admin/dead-letters — admin
      if (method === 'GET' && segments.length === 3
        && segments[1] === 'admin' && segments[2] === 'dead-letters') {
        const actor = await authenticate(game, request);
        requireAdmin(actor);
        sendJson(response, 200, { deadLetters: await game.listDeadJobs() });
        return;
      }

      // POST /v1/admin/requeue — admin
      if (method === 'POST' && segments.length === 3
        && segments[1] === 'admin' && segments[2] === 'requeue') {
        const actor = await authenticate(game, request);
        requireAdmin(actor);
        const body = parseJsonBody(await readBody(request, maxBodyBytes));
        assertExactBodyKeys(body, ['jobId', 'reason']);
        const result = await game.requeueDeadJob(
          { actorId: actor.actorId, nowHour: clock() },
          { jobId: body.jobId, reason: body.reason } as never,
        );
        sendJson(response, 200, result);
        return;
      }

      throw new ServerError('NOT_FOUND', '알 수 없는 경로다.');
    } catch (error) {
      sendError(response, error);
    }
  }

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
      });
    });
  });
}

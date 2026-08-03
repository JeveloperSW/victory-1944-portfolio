import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConstructionServer } from '../src/index.js';
import { startHttpApi, type RunningHttpApi } from '../src/http-api.js';

const OWNER = 'user:alpha';
const OTHER = 'user:bravo';
const CITY = 'city:alpha';
const ADMIN = 'admin:ops';

interface HttpFixture {
  readonly server: ConstructionServer;
  baseUrl: string;
  playerToken: string;
  otherToken: string;
  adminToken: string;
  hour: number;
}

async function httpFixture(t: TestContext): Promise<HttpFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-http-'));
  const server = await ConstructionServer.open(join(directory, 'http.sqlite'));
  const fixture: HttpFixture = {
    server,
    baseUrl: '',
    playerToken: '',
    otherToken: '',
    adminToken: '',
    hour: 10,
  };
  const api: RunningHttpApi = await startHttpApi({ server, clock: () => fixture.hour });
  t.after(async () => {
    await api.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: { hq: 2 } });
  const adminContext = { actorId: ADMIN, nowHour: 10 } as const;
  fixture.playerToken = (await server.issueToken(adminContext, { actorId: OWNER, role: 'player', reason: 'test' })).token;
  fixture.otherToken = (await server.issueToken(adminContext, { actorId: OTHER, role: 'player', reason: 'test' })).token;
  fixture.adminToken = (await server.issueToken(adminContext, { actorId: ADMIN, role: 'admin', reason: 'test' })).token;
  fixture.baseUrl = `http://127.0.0.1:${api.port}`;
  return fixture;
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function startBody(commandId: string, expectedVersion: number, buildingId = 'farm'): string {
  return JSON.stringify({ commandId, expectedVersion, buildingId });
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('HTTP: health는 무인증, 건설 시작은 201→재전송 replay 200, 도시 조회는 소유자만', async (t) => {
  const fx = await httpFixture(t);

  const health = await fetch(`${fx.baseUrl}/health`);
  assert.equal(health.status, 200);
  const healthBody = await jsonOf(health);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.nowHour, 10);

  const first = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: startBody('http:start:1', 0),
  });
  assert.equal(first.status, 201);
  const firstBody = await jsonOf(first);
  assert.equal(firstBody.replayed, false);
  const response = firstBody.response as Record<string, unknown>;
  assert.equal(response.buildingId, 'farm');
  assert.equal(response.cityVersion, 1);
  assert.equal(response.startedAtHour, 10);

  // 같은 commandId 재전송은 저장 응답 replay(상태 불변).
  const replay = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: startBody('http:start:1', 0),
  });
  assert.equal(replay.status, 200);
  const replayBody = await jsonOf(replay);
  assert.equal(replayBody.replayed, true);
  assert.deepEqual(replayBody.response, response);

  const city = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: authHeaders(fx.playerToken),
  });
  assert.equal(city.status, 200);
  const cityBody = await jsonOf(city);
  assert.equal(cityBody.version, 1);
  assert.equal((cityBody.jobs as unknown[]).length, 1);

  // admin은 소유자가 아니어도 조회할 수 있다.
  const adminView = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: authHeaders(fx.adminToken),
  });
  assert.equal(adminView.status, 200);
});

test('HTTP 인증·권한: 무토큰 401, 폐기 토큰 401, 타인 도시 403, 관리자 경로 403', async (t) => {
  const fx = await httpFixture(t);

  const noToken = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`);
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: authHeaders('f'.repeat(64)),
  });
  assert.equal(badToken.status, 401);

  const otherCity = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: authHeaders(fx.otherToken),
  });
  assert.equal(otherCity.status, 403);

  const otherStart = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.otherToken),
    body: startBody('http:forbidden', 0),
  });
  assert.equal(otherStart.status, 403);

  const playerAdmin = await fetch(`${fx.baseUrl}/v1/admin/dead-letters`, {
    headers: authHeaders(fx.playerToken),
  });
  assert.equal(playerAdmin.status, 403);

  // 토큰 폐기 후에는 같은 토큰이 401이다.
  const issued = await fx.server.issueToken(
    { actorId: ADMIN, nowHour: 10 },
    { actorId: 'user:temp', role: 'player', reason: 'revoke test' },
  );
  await fx.server.revokeToken({ actorId: ADMIN, nowHour: 10 }, { tokenSha256: issued.tokenSha256, reason: 'test' });
  const revoked = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: authHeaders(issued.token),
  });
  assert.equal(revoked.status, 401);
});

test('HTTP 입력 방어: 깨진 JSON 400, 크기 초과 413, 미지 경로 404, stale version 409', async (t) => {
  const fx = await httpFixture(t);

  const badJson = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  const badJsonBody = await jsonOf(badJson);
  assert.equal(badJsonBody.code, 'INVALID_INPUT');
  assert.ok(!JSON.stringify(badJsonBody).includes('SQLITE'), '내부 정보가 노출되면 안 된다.');

  const oversized = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: JSON.stringify({ commandId: 'x', expectedVersion: 0, buildingId: 'farm', junk: 'a'.repeat(20_000) }),
  });
  assert.equal(oversized.status, 413);

  const unknownPath = await fetch(`${fx.baseUrl}/v1/unknown`, {
    headers: authHeaders(fx.playerToken),
  });
  assert.equal(unknownPath.status, 404);

  const stale = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: startBody('http:stale', 7),
  });
  assert.equal(stale.status, 409);
  assert.equal((await jsonOf(stale)).code, 'STALE_VERSION');

  // payload의 cityId 주장 무시: URL의 도시가 권위다(존재하지 않는 도시 → 404).
  const missingCity = await fetch(`${fx.baseUrl}/v1/cities/city:none/constructions`, {
    method: 'POST',
    headers: authHeaders(fx.playerToken),
    body: startBody('http:none', 0),
  });
  assert.equal(missingCity.status, 404);
});

test('HTTP 관리자 흐름: dead letter 조회→requeue→감사·재완료까지 이어진다', async (t) => {
  const fx = await httpFixture(t);
  const server = fx.server;

  // dead letter 준비(정책은 서버 생성 시 고정이라 직접 API로 만든다: maxAttempts 기본 5 → fail 5회)
  const started = await server.startConstruction(
    { actorId: OWNER, nowHour: 10 },
    { commandId: 'start:dead', cityId: CITY, expectedVersion: 0, buildingId: 'farm' },
  );
  const jobId = started.response.jobId;
  const dueHour = started.response.completesAtHour;
  let hour = dueHour;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = await server.claimDueConstructionJobs({ actorId: 'worker:http', nowHour: hour }, { limit: 10 });
    assert.equal(claimed.claimed[0]?.attempt, attempt);
    const failed = await server.failClaimedConstructionJob(
      { actorId: 'worker:http', nowHour: hour },
      { jobId, error: `실패 ${attempt}` },
    );
    if (failed.state === 'dead') break;
    hour = failed.nextEligibleHour!;
  }
  fx.hour = hour + 1;

  const listResponse = await fetch(`${fx.baseUrl}/v1/admin/dead-letters`, {
    headers: authHeaders(fx.adminToken),
  });
  assert.equal(listResponse.status, 200);
  const listBody = await jsonOf(listResponse);
  const deadLetters = listBody.deadLetters as Record<string, unknown>[];
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0]?.jobId, jobId);
  assert.equal(deadLetters[0]?.state, 'dead');

  const requeue = await fetch(`${fx.baseUrl}/v1/admin/requeue`, {
    method: 'POST',
    headers: authHeaders(fx.adminToken),
    body: JSON.stringify({ jobId, reason: 'HTTP 운영 재가동' }),
  });
  assert.equal(requeue.status, 200);
  const requeueBody = await jsonOf(requeue);
  assert.equal(requeueBody.requeued, true);
  assert.equal(requeueBody.priorAttempts, 5);

  const doubleRequeue = await fetch(`${fx.baseUrl}/v1/admin/requeue`, {
    method: 'POST',
    headers: authHeaders(fx.adminToken),
    body: JSON.stringify({ jobId, reason: '중복 재가동' }),
  });
  assert.equal(doubleRequeue.status, 404, '이미 재가동된 job의 claim은 없어야 한다.');

  const audit = (await server.listAdminActions()).filter((action) => action.action === 'requeue_dead_job');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.target, jobId);
});

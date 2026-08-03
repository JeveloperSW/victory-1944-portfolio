import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConstructionServer, ServerError } from '../src/index.js';
import { startHttpApi, type RunningHttpApi } from '../src/http-api.js';

const OWNER = 'user:app';
const CITY = 'city:app';
const ADMIN = 'admin:app';
const APP_ORIGIN = 'http://localhost:5173';
const CAPACITOR_ORIGIN = 'http://localhost';

interface CorsFixture {
  readonly baseUrl: string;
  readonly playerToken: string;
}

async function corsFixture(
  t: TestContext,
  allowedOrigins?: readonly string[],
): Promise<CorsFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-cors-'));
  const server = await ConstructionServer.open(join(directory, 'cors.sqlite'));
  const api: RunningHttpApi = await startHttpApi({
    server,
    clock: () => 10,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  t.after(async () => {
    await api.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: { hq: 2 } });
  const issued = await server.issueToken(
    { actorId: ADMIN, nowHour: 10 },
    { actorId: OWNER, role: 'player', reason: 'cors test' },
  );
  return { baseUrl: `http://127.0.0.1:${api.port}`, playerToken: issued.token };
}

test('허용 Origin은 정확히 echo되고 Vary가 붙는다', async (t) => {
  const fx = await corsFixture(t, [APP_ORIGIN, CAPACITOR_ORIGIN]);

  const response = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: { authorization: `Bearer ${fx.playerToken}`, origin: APP_ORIGIN },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), APP_ORIGIN);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);

  // Capacitor 앱 문서 Origin도 같은 방식으로 허용된다.
  const capacitor = await fetch(`${fx.baseUrl}/health`, { headers: { origin: CAPACITOR_ORIGIN } });
  assert.equal(capacitor.status, 200);
  assert.equal(capacitor.headers.get('access-control-allow-origin'), CAPACITOR_ORIGIN);
});

test('허용 외 Origin은 인증 이전에 403으로 거부되고 ACAO를 받지 못한다', async (t) => {
  const fx = await corsFixture(t, [APP_ORIGIN]);

  const evil = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: { authorization: `Bearer ${fx.playerToken}`, origin: 'http://evil.example' },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('vary'), 'Origin');

  // 토큰이 없어도 Origin 거부가 먼저 일어난다(401이 아니라 403).
  const noToken = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(noToken.status, 403);

  // Origin 헤더가 없는 요청(앱 아님·서버 간 호출)은 기존처럼 동작한다.
  const noOrigin = await fetch(`${fx.baseUrl}/health`);
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('프리플라이트는 허용 Origin에만 204와 메서드·헤더 목록을 준다', async (t) => {
  const fx = await corsFixture(t, [APP_ORIGIN]);

  const preflight = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'OPTIONS',
    headers: {
      origin: APP_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), APP_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, content-type');
  assert.equal(preflight.headers.get('access-control-max-age'), '600');
  assert.equal((await preflight.text()).length, 0);

  const rejected = await fetch(`${fx.baseUrl}/v1/cities/${CITY}/constructions`, {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('allowedOrigins 미설정 시 CORS 헤더가 없고 Origin도 차단하지 않는다', async (t) => {
  const fx = await corsFixture(t);

  const response = await fetch(`${fx.baseUrl}/v1/cities/${CITY}`, {
    headers: { authorization: `Bearer ${fx.playerToken}`, origin: APP_ORIGIN },
  });
  assert.equal(response.status, 200, '기존 동작이 보존되어야 한다.');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('vary'), null);

  const preflight = await fetch(`${fx.baseUrl}/health`, {
    method: 'OPTIONS',
    headers: { origin: APP_ORIGIN },
  });
  assert.equal(preflight.status, 404, 'CORS를 켜지 않으면 프리플라이트도 제공하지 않는다.');
});

test('와일드카드·비정규 Origin 설정은 시작 시 거부된다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-cors-bad-'));
  const server = await ConstructionServer.open(join(directory, 'bad.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  for (const bad of [
    '*',
    'http://*.example',
    'localhost:5173',
    'http://localhost:5173/app',
    'http://localhost:5173?x=1',
    '',
  ]) {
    await assert.rejects(
      startHttpApi({ server, clock: () => 10, allowedOrigins: [bad] }),
      (error: unknown) => error instanceof ServerError && error.code === 'INVALID_INPUT',
      `거부되어야 하는 Origin: ${JSON.stringify(bad)}`,
    );
  }
});

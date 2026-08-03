import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConstructionServer, startHttpApi } from '../src/index.js';

const CITY_ID = 'city:http-operations';
const OWNER_ID = 'player:http-operations';
const FORCE = [
  { unitId: 'rifle', count: 10 },
  { unitId: 'scout', count: 1 },
  { unitId: 'medium_tank', count: 2 },
  { unitId: 'howitzer', count: 1 },
];
const DEPLOYMENT = [
  { unitId: 'rifle', count: 10, row: 'front' },
  { unitId: 'medium_tank', count: 2, row: 'front' },
  { unitId: 'scout', count: 1, row: 'mid' },
  { unitId: 'howitzer', count: 1, row: 'back' },
];

test('HTTP 작전 수직 슬라이스: 역할·exact body·201/200 replay·영구 보고서 조회', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-http-operations-'));
  const server = await ConstructionServer.open(join(directory, 'game.sqlite'), {
    seedGenerator: () => 12,
  });
  await server.seedCity({
    cityId: CITY_ID,
    ownerId: OWNER_ID,
    campaignRuleVersion: '0.2.0',
    buildings: { hq: 2 },
  });
  const player = await server.issueToken(
    { actorId: 'admin:http-bootstrap', nowHour: 10 },
    { actorId: OWNER_ID, role: 'player', reason: 'http operation test' },
  );
  const other = await server.issueToken(
    { actorId: 'admin:http-bootstrap', nowHour: 10 },
    { actorId: 'player:other', role: 'player', reason: 'http operation test' },
  );
  const admin = await server.issueToken(
    { actorId: 'admin:http-bootstrap', nowHour: 10 },
    { actorId: 'admin:http', role: 'admin', reason: 'http operation test' },
  );
  const api = await startHttpApi({
    server,
    clock: () => 10,
    prototypeSession: { token: player.token, cityId: CITY_ID },
  });
  t.after(async () => {
    await api.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${api.port}`;

  async function request(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const body = await response.json() as Record<string, unknown>;
    return { response, body };
  }

  const page = await fetch(`${base}/prototype`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await page.text(), /첫 작전 검증판/);

  const extra = await request(
    `/v1/cities/${CITY_ID}/mobilizations`,
    player.token,
    {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'cmd:extra',
        expectedVersion: 0,
        units: FORCE,
        seed: 12,
      }),
    },
  );
  assert.equal(extra.response.status, 400);
  assert.equal(extra.body.code, 'INVALID_INPUT');

  const adminWrite = await request(
    `/v1/cities/${CITY_ID}/mobilizations`,
    admin.token,
    {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'cmd:admin-write',
        expectedVersion: 0,
        units: FORCE,
      }),
    },
  );
  assert.equal(adminWrite.response.status, 403);

  const mobilizationBody = {
    commandId: 'cmd:mobilize',
    expectedVersion: 0,
    units: FORCE,
  };
  const mobilized = await request(
    `/v1/cities/${CITY_ID}/mobilizations`,
    player.token,
    { method: 'POST', body: JSON.stringify(mobilizationBody) },
  );
  assert.equal(mobilized.response.status, 201);
  assert.equal(mobilized.body.replayed, false);
  const replay = await request(
    `/v1/cities/${CITY_ID}/mobilizations`,
    player.token,
    { method: 'POST', body: JSON.stringify(mobilizationBody) },
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);

  const forbiddenRead = await request(
    `/v1/cities/${CITY_ID}/operations`,
    other.token,
  );
  assert.equal(forbiddenRead.response.status, 403);

  const scouted = await request(
    `/v1/cities/${CITY_ID}/recon`,
    player.token,
    {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'cmd:recon',
        expectedVersion: 1,
        scenarioId: 'training_outpost',
      }),
    },
  );
  assert.equal(scouted.response.status, 201);

  const fought = await request(
    `/v1/cities/${CITY_ID}/battles`,
    player.token,
    {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'cmd:attack',
        expectedVersion: 2,
        scenarioId: 'training_outpost',
        deployment: DEPLOYMENT,
        doctrine: 'artillery_support',
      }),
    },
  );
  assert.equal(fought.response.status, 201);
  const response = fought.body.response as Record<string, unknown>;
  const report = response.report as Record<string, unknown>;
  const result = report.result as Record<string, unknown>;
  assert.equal(result.hash, '10c52c4e723a1d1b');

  const operations = await request(
    `/v1/cities/${CITY_ID}/operations`,
    player.token,
  );
  assert.equal(operations.response.status, 200);
  assert.equal(operations.body.version, 3);
  assert.equal((operations.body.battleReports as unknown[]).length, 1);

  const reports = await request(
    `/v1/cities/${CITY_ID}/battle-reports`,
    admin.token,
  );
  assert.equal(reports.response.status, 200);
  assert.equal((reports.body.battleReports as unknown[]).length, 1);
});

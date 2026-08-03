import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { stableStringify } from '../../engine/src/index.js';
import {
  ConstructionServer,
  ServerError,
  type ConstructionServerOptions,
  type FaultPoint,
} from '../src/index.js';

const CITY_ID = 'city:operations';
const OWNER_ID = 'player:operations';
const FORCE = [
  { unitId: 'rifle', count: 10 },
  { unitId: 'scout', count: 1 },
  { unitId: 'medium_tank', count: 2 },
  { unitId: 'howitzer', count: 1 },
] as const;
const DEPLOYMENT = [
  { unitId: 'rifle', count: 10, row: 'front' },
  { unitId: 'medium_tank', count: 2, row: 'front' },
  { unitId: 'scout', count: 1, row: 'mid' },
  { unitId: 'howitzer', count: 1, row: 'back' },
] as const;

async function fixture(
  t: TestContext,
  options: ConstructionServerOptions = {},
): Promise<{ server: ConstructionServer; databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-operations-'));
  const databasePath = join(directory, 'game.sqlite');
  const holder: { server?: ConstructionServer } = {};
  holder.server = await ConstructionServer.open(databasePath, options);
  await holder.server.seedCity({
    cityId: CITY_ID,
    ownerId: OWNER_ID,
    campaignRuleVersion: '0.2.0',
    buildings: { hq: 2 },
  });
  t.after(async () => {
    await holder.server?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get server() {
      return holder.server!;
    },
    databasePath,
  };
}

async function expectCode(promise: Promise<unknown>, code: ServerError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.code, code);
    return true;
  });
}

async function mobilize(server: ConstructionServer, commandId = 'cmd:mobilize') {
  return await server.mobilizeUnits(
    { actorId: OWNER_ID, nowHour: 10 },
    { commandId, cityId: CITY_ID, expectedVersion: 0, units: FORCE },
  );
}

async function recon(server: ConstructionServer, commandId = 'cmd:recon', version = 1) {
  return await server.reconNpc(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId,
      cityId: CITY_ID,
      expectedVersion: version,
      scenarioId: 'training_outpost',
    },
  );
}

async function attack(server: ConstructionServer, commandId = 'cmd:attack', version = 2) {
  return await server.attackNpc(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId,
      cityId: CITY_ID,
      expectedVersion: version,
      scenarioId: 'training_outpost',
      deployment: DEPLOYMENT,
      doctrine: 'artillery_support',
    },
  );
}

test('동원→정찰→NPC 전투는 비용·병력·서버 seed·보고서를 원자 저장하고 재오픈한다', async (t) => {
  let seedCalls = 0;
  const { server, databasePath } = await fixture(t, {
    seedGenerator: () => {
      seedCalls += 1;
      return 12;
    },
  });

  const mobilized = await mobilize(server);
  assert.equal(mobilized.replayed, false);
  assert.deepEqual(mobilized.response.cost, {
    food: 280,
    steel: 420,
    oil: 50,
    manpower: 17,
  });
  assert.deepEqual(mobilized.response.units, FORCE);
  assert.equal(mobilized.response.ruleVersion, '0.1.0');
  assert.equal(mobilized.response.campaignRuleVersion, '0.2.0');

  const replayedMobilization = await server.mobilizeUnits(
    { actorId: OWNER_ID, nowHour: 99 },
    {
      commandId: 'cmd:mobilize',
      cityId: CITY_ID,
      expectedVersion: 0,
      units: [...FORCE].reverse(),
    },
  );
  assert.equal(replayedMobilization.replayed, true);
  assert.deepEqual(replayedMobilization.response, mobilized.response);

  const scouted = await recon(server);
  assert.equal(scouted.response.report.scoutCount, 1);
  assert.equal(scouted.response.report.accuracy, 0.6);
  assert.equal(scouted.response.report.createdAtHour, 10);
  assert.equal(scouted.response.report.expiresAtHour, 16);
  assert.equal(scouted.response.report.campaignRuleVersion, '0.2.0');
  assert.deepEqual(scouted.response.cost, { oil: 5, supplies: 10 });
  for (const threat of scouted.response.report.threats) {
    assert.ok(threat.minimum <= threat.maximum);
  }

  const fought = await attack(server);
  assert.equal(seedCalls, 1);
  assert.equal(fought.response.report.seed, 12);
  assert.equal(fought.response.report.campaignRuleVersion, '0.2.0');
  assert.equal(fought.response.report.result.outcome, 'attacker_win');
  assert.equal(fought.response.report.result.reason, 'annihilation');
  assert.equal(fought.response.report.result.rounds, 2);
  assert.equal(fought.response.report.result.hash, '10c52c4e723a1d1b');
  assert.deepEqual(fought.response.report.sortieCost, { oil: 11, supplies: 32 });
  assert.deepEqual(fought.response.report.reward, { food: 20, scrip: 10 });
  assert.deepEqual(fought.response.report.casualties, [
    { unitId: 'rifle', deployed: 10, survivors: 8, wounded: 1, dead: 1 },
    { unitId: 'scout', deployed: 1, survivors: 1, wounded: 0, dead: 0 },
    { unitId: 'medium_tank', deployed: 2, survivors: 2, wounded: 0, dead: 0 },
    { unitId: 'howitzer', deployed: 1, survivors: 1, wounded: 0, dead: 0 },
  ]);
  assert.equal(fought.response.report.analysis.resultHash, fought.response.report.result.hash);

  const snapshot = await server.getOperations(CITY_ID);
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.ruleVersion, '0.1.0');
  assert.equal(snapshot.campaignRuleVersion, '0.2.0');
  assert.deepEqual(snapshot.resourcesMicro, {
    food: 240_000,
    steel: 80_000,
    oil: 134_000,
    supplies: 58_000,
    manpower: 83_000,
    scrip: 60_000,
  });
  assert.equal(snapshot.army.ready.rifle, 8);
  assert.equal(snapshot.army.wounded.rifle, 1);
  assert.equal(snapshot.army.dead.rifle, 1);
  assert.equal(snapshot.battleReports.length, 1);
  assert.equal(snapshot.ledger.length, 10);
  assert.equal(snapshot.receipts.length, 3);

  await server.close();
  const reopened = await ConstructionServer.open(databasePath, { seedGenerator: () => 999 });
  const restored = await reopened.getOperations(CITY_ID);
  assert.deepEqual(restored, snapshot);
  await reopened.close();
});

test('도시는 경제·캠페인 규칙을 별도 결속하고 0.1.0 입력 집합을 소급 변경하지 않는다', async (t) => {
  const { server } = await fixture(t);
  await expectCode(
    server.seedCity({
      cityId: 'city:unknown-campaign',
      ownerId: 'player:unknown-campaign',
      campaignRuleVersion: '9.9.9',
    }),
    'INVALID_INPUT',
  );

  const legacy = await server.seedCity({
    cityId: 'city:campaign-0-1',
    ownerId: 'player:campaign-0-1',
    campaignRuleVersion: '0.1.0',
  });
  assert.equal(legacy.ruleVersion, '0.1.0');
  assert.equal(legacy.campaignRuleVersion, '0.1.0');
  await server.mobilizeUnits(
    { actorId: legacy.ownerId, nowHour: 10 },
    {
      commandId: 'cmd:legacy:scout',
      cityId: legacy.id,
      expectedVersion: 0,
      units: [{ unitId: 'scout', count: 1 }],
    },
  );
  await expectCode(
    server.reconNpc(
      { actorId: legacy.ownerId, nowHour: 10 },
      {
        commandId: 'cmd:legacy:recon',
        cityId: legacy.id,
        expectedVersion: 1,
        scenarioId: 'training_outpost',
      },
    ),
    'UNKNOWN_SCENARIO',
  );
});

test('정찰·전투 거부: 정찰병, 보고서, 만료 경계, 시나리오·교리·병력 입력을 fail closed한다', async (t) => {
  let seedCalls = 0;
  const { server } = await fixture(t, {
    seedGenerator: () => {
      seedCalls += 1;
      return 12;
    },
  });

  await expectCode(
    server.reconNpc(
      { actorId: OWNER_ID, nowHour: 10 },
      {
        commandId: 'cmd:no-scout',
        cityId: CITY_ID,
        expectedVersion: 0,
        scenarioId: 'training_outpost',
      },
    ),
    'SCOUT_REQUIRED',
  );
  await mobilize(server);
  await expectCode(attack(server, 'cmd:no-recon', 1), 'RECON_REQUIRED');
  await expectCode(
    server.reconNpc(
      { actorId: OWNER_ID, nowHour: 10 },
      {
        commandId: 'cmd:unknown-scenario',
        cityId: CITY_ID,
        expectedVersion: 1,
        scenarioId: 'unknown',
      },
    ),
    'UNKNOWN_SCENARIO',
  );
  const scouted = await recon(server);
  await expectCode(
    server.attackNpc(
      { actorId: OWNER_ID, nowHour: 16 },
      {
        commandId: 'cmd:expired',
        cityId: CITY_ID,
        expectedVersion: 2,
        scenarioId: 'training_outpost',
        deployment: DEPLOYMENT,
        doctrine: 'artillery_support',
      },
    ),
    'RECON_EXPIRED',
  );
  assert.equal(seedCalls, 0);
  const replay = await server.reconNpc(
    { actorId: OWNER_ID, nowHour: 16 },
    {
      commandId: 'cmd:recon',
      cityId: CITY_ID,
      expectedVersion: 1,
      scenarioId: 'training_outpost',
    },
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, scouted.response);
  await expectCode(
    server.attackNpc(
      { actorId: OWNER_ID, nowHour: 15 },
      {
        commandId: 'cmd:bad-doctrine',
        cityId: CITY_ID,
        expectedVersion: 2,
        scenarioId: 'training_outpost',
        deployment: DEPLOYMENT,
        doctrine: 'unknown' as never,
      },
    ),
    'UNKNOWN_DOCTRINE',
  );
  await expectCode(
    server.attackNpc(
      { actorId: OWNER_ID, nowHour: 15 },
      {
        commandId: 'cmd:too-many',
        cityId: CITY_ID,
        expectedVersion: 2,
        scenarioId: 'training_outpost',
        deployment: [{ unitId: 'rifle', count: 11, row: 'front' }],
        doctrine: 'artillery_support',
      },
    ),
    'INSUFFICIENT_UNITS',
  );
  assert.equal(seedCalls, 0);
});

test('작전 멱등 키는 건설과 전역 충돌하고 동시 동일 공격은 seed·효과를 한 번만 만든다', async (t) => {
  let seedCalls = 0;
  const { server } = await fixture(t, {
    seedGenerator: () => {
      seedCalls += 1;
      return 12;
    },
  });
  await server.startConstruction(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId: 'cmd:global',
      cityId: CITY_ID,
      expectedVersion: 0,
      buildingId: 'farm',
    },
  );
  await expectCode(
    server.mobilizeUnits(
      { actorId: OWNER_ID, nowHour: 10 },
      {
        commandId: 'cmd:global',
        cityId: CITY_ID,
        expectedVersion: 1,
        units: FORCE,
      },
    ),
    'IDEMPOTENCY_KEY_REUSED',
  );

  await server.mobilizeUnits(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId: 'cmd:mobilize',
      cityId: CITY_ID,
      expectedVersion: 1,
      units: FORCE,
    },
  );
  await recon(server, 'cmd:recon', 2);
  const command = {
    commandId: 'cmd:attack',
    cityId: CITY_ID,
    expectedVersion: 3,
    scenarioId: 'training_outpost',
    deployment: DEPLOYMENT,
    doctrine: 'artillery_support',
  } as const;
  const [left, right] = await Promise.all([
    server.attackNpc({ actorId: OWNER_ID, nowHour: 10 }, command),
    server.attackNpc({ actorId: OWNER_ID, nowHour: 10 }, command),
  ]);
  assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
  assert.deepEqual(left.response, right.response);
  assert.equal(seedCalls, 1);
  const snapshot = await server.getOperations(CITY_ID);
  assert.equal(snapshot.battleReports.length, 1);

  await expectCode(
    server.startConstruction(
      { actorId: OWNER_ID, nowHour: 10 },
      {
        commandId: 'cmd:mobilize',
        cityId: CITY_ID,
        expectedVersion: snapshot.version,
        buildingId: 'steel_mill',
      },
    ),
    'IDEMPOTENCY_KEY_REUSED',
  );
});

test('작전 failpoint와 잘못된 seed 생성기는 자원·병력·보고서를 완전히 rollback한다', async (t) => {
  const points: readonly FaultPoint[] = [
    'mobilize:after_first_debit',
    'mobilize:after_army',
    'mobilize:after_receipt',
  ];
  for (const point of points) {
    const directory = mkdtempSync(join(tmpdir(), 'victory1944-operation-fault-'));
    const path = join(directory, 'game.sqlite');
    let armed = true;
    const server = await ConstructionServer.open(path, {
      faultInjector: (candidate) => {
        if (armed && candidate === point) {
          armed = false;
          throw new Error(`fault:${point}`);
        }
      },
    });
    try {
      await server.seedCity({ cityId: CITY_ID, ownerId: OWNER_ID });
      const before = await server.getOperations(CITY_ID);
      await expectCode(mobilize(server, `cmd:${point}`), 'DATABASE_FAILURE');
      assert.deepEqual(await server.getOperations(CITY_ID), before);
      const retry = await mobilize(server, `cmd:${point}`);
      assert.equal(retry.replayed, false);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const { server } = await fixture(t, { seedGenerator: () => -1 });
  await mobilize(server);
  await recon(server);
  const beforeBattle = await server.getOperations(CITY_ID);
  await expectCode(attack(server), 'DATA_INTEGRITY');
  assert.deepEqual(await server.getOperations(CITY_ID), beforeBattle);
});

test('전투 중간 실패는 출정 차감·사상자·보상·보고서를 함께 rollback한다', async (t) => {
  let faultArmed = true;
  const { server } = await fixture(t, {
    seedGenerator: () => 12,
    faultInjector: (point) => {
      if (faultArmed && point === 'battle:before_reward') {
        faultArmed = false;
        throw new Error('battle rollback');
      }
    },
  });
  await mobilize(server);
  await recon(server);
  const before = await server.getOperations(CITY_ID);
  await expectCode(attack(server), 'DATABASE_FAILURE');
  assert.deepEqual(await server.getOperations(CITY_ID), before);
  const retry = await attack(server);
  assert.equal(retry.replayed, false);
});

test('getOperations는 현재 병력과 과거 정찰 보고서의 의미 손상을 검출한다', async (t) => {
  const { server, databasePath } = await fixture(t, { seedGenerator: () => 12 });
  await mobilize(server);
  await recon(server, 'cmd:recon:first', 1);
  await server.reconNpc(
    { actorId: OWNER_ID, nowHour: 11 },
    {
      commandId: 'cmd:recon:second',
      cityId: CITY_ID,
      expectedVersion: 2,
      scenarioId: 'training_outpost',
    },
  );
  await server.close();

  const db = new DatabaseSync(databasePath);
  const first = db.prepare(`
    SELECT id, report_json FROM recon_reports WHERE command_id = 'cmd:recon:first'
  `).get() as { id: string; report_json: string };
  const report = JSON.parse(first.report_json) as Record<string, unknown>;
  report.expiresAtHour = 17;
  db.prepare(`
    UPDATE recon_reports SET expires_at_hour = 17, report_json = ? WHERE id = ?
  `).run(stableStringify(report), first.id);
  db.close();

  const reopened = await ConstructionServer.open(databasePath);
  await expectCode(reopened.getOperations(CITY_ID), 'DATA_INTEGRITY');
  await reopened.close();

  const armyDb = new DatabaseSync(databasePath);
  armyDb.prepare(`
    UPDATE recon_reports SET expires_at_hour = 16, report_json = ? WHERE id = ?
  `).run(first.report_json, first.id);
  armyDb.prepare(`
    UPDATE city_armies SET ready = ready + 1
    WHERE city_id = ? AND unit_id = 'rifle'
  `).run(CITY_ID);
  armyDb.close();
  const reopenedArmy = await ConstructionServer.open(databasePath);
  await expectCode(reopenedArmy.getOperations(CITY_ID), 'DATA_INTEGRITY');
  await reopenedArmy.close();
});

test('동원 직접 재생은 현재 병력 효과와 원본 expectedVersion+1 응답을 다시 검증한다', async (t) => {
  const { server, databasePath } = await fixture(t);
  await mobilize(server);
  await server.startConstruction(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId: 'cmd:farm-after-mobilize',
      cityId: CITY_ID,
      expectedVersion: 1,
      buildingId: 'farm',
    },
  );
  await server.close();

  const armyDb = new DatabaseSync(databasePath);
  armyDb.prepare(`
    UPDATE city_armies SET ready = ready + 1
    WHERE city_id = ? AND unit_id = 'rifle'
  `).run(CITY_ID);
  armyDb.close();

  const armyTampered = await ConstructionServer.open(databasePath);
  try {
    await expectCode(mobilize(armyTampered), 'DATA_INTEGRITY');
  } finally {
    await armyTampered.close();
  }

  const versionDb = new DatabaseSync(databasePath);
  versionDb.prepare(`
    UPDATE city_armies SET ready = ready - 1
    WHERE city_id = ? AND unit_id = 'rifle'
  `).run(CITY_ID);
  const receipt = versionDb.prepare(`
    SELECT response_json FROM operation_receipts
    WHERE actor_id = ? AND command_id = 'cmd:mobilize'
  `).get(OWNER_ID) as { response_json: string };
  const response = JSON.parse(receipt.response_json) as Record<string, unknown>;
  response.cityVersion = 2;
  versionDb.prepare(`
    UPDATE operation_receipts SET response_json = ?
    WHERE actor_id = ? AND command_id = 'cmd:mobilize'
  `).run(stableStringify(response), OWNER_ID);
  versionDb.close();

  const versionTampered = await ConstructionServer.open(databasePath);
  try {
    await expectCode(mobilize(versionTampered), 'DATA_INTEGRITY');
  } finally {
    await versionTampered.close();
  }
});

test('getOperations는 같은 시각에 인터리빙된 건설·작전 원장과 현재 자원 잔액을 교차 검증한다', async (t) => {
  const { server, databasePath } = await fixture(t);
  await server.startConstruction(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId: 'cmd:farm',
      cityId: CITY_ID,
      expectedVersion: 0,
      buildingId: 'farm',
    },
  );
  await server.mobilizeUnits(
    { actorId: OWNER_ID, nowHour: 10 },
    {
      commandId: 'cmd:mobilize',
      cityId: CITY_ID,
      expectedVersion: 1,
      units: FORCE,
    },
  );
  const beforeTamper = await server.getOperations(CITY_ID);
  assert.equal(beforeTamper.version, 2);
  assert.equal(beforeTamper.resourcesMicro.food, 200_000);
  await server.close();

  const db = new DatabaseSync(databasePath);
  db.prepare(`
    UPDATE city_resources SET balance_micro = balance_micro + 1000
    WHERE city_id = ? AND resource_id = 'food'
  `).run(CITY_ID);
  db.close();

  const reopened = await ConstructionServer.open(databasePath);
  try {
    await expectCode(reopened.getOperations(CITY_ID), 'DATA_INTEGRITY');
  } finally {
    await reopened.close();
  }
});

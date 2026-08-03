import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  CONSTRUCTION_WORKER_ID,
  ConstructionServer,
  MIGRATIONS,
  SERVER_SCHEMA_VERSION,
  ServerError,
} from '../src/index.js';
import type {
  CommandContext,
  ConstructionServerOptions,
  StartConstructionCommand,
} from '../src/index.js';

const OWNER = 'user:alpha';
const CITY = 'city:alpha';
const WORKER_A = 'worker:alpha';
const WORKER_B = 'worker:beta';
const READY_BUILDINGS = { hq: 2 } as const;

interface Fixture {
  readonly databasePath: string;
  open(options?: ConstructionServerOptions): Promise<ConstructionServer>;
  close(server: ConstructionServer): Promise<void>;
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-job-claims-'));
  const databasePath = join(directory, 'claims.sqlite');
  const openServers = new Set<ConstructionServer>();

  t.after(async () => {
    for (const server of openServers) await server.close();
    openServers.clear();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  });

  return {
    databasePath,
    async open(options = {}) {
      const server = await ConstructionServer.open(databasePath, options);
      openServers.add(server);
      return server;
    },
    async close(server) {
      if (!openServers.delete(server)) return;
      await server.close();
    },
  };
}

function context(actorId: string, nowHour: number): CommandContext {
  return { actorId, nowHour };
}

function startCommand(
  overrides: Partial<StartConstructionCommand> = {},
): StartConstructionCommand {
  return {
    commandId: 'start:farm:1',
    cityId: CITY,
    expectedVersion: 0,
    buildingId: 'farm',
    ...overrides,
  };
}

async function expectCode(operation: () => unknown, code: ServerError['code']): Promise<ServerError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServerError, `expected ServerError ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

/** 도시 seed + 농장 2레벨 건설 시작. due 시각(completesAtHour)을 돌려준다. */
async function seedDueJob(server: ConstructionServer): Promise<{ jobId: string; dueHour: number }> {
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction(context(OWNER, 10), startCommand());
  return { jobId: started.response.jobId, dueHour: started.response.completesAtHour };
}

async function completeJob(server: ConstructionServer, jobId: string, nowHour: number, commandId: string): Promise<void> {
  const execution = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, nowHour),
    { commandId, jobId },
  );
  assert.equal(execution.response.jobId, jobId);
}

test('v1 스키마 DB는 열 때 최신 스키마로 업그레이드되고 기존 데이터가 보존된다', async (t) => {
  const db = fixture(t);
  {
    const raw = new DatabaseSync(db.databasePath, { enableForeignKeyConstraints: true });
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY CHECK(version >= 1),
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    raw.exec(MIGRATIONS[0]!.sql);
    raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)').run('2026-07-19');
    raw.exec('PRAGMA user_version = 1');
    raw.prepare(`
      INSERT INTO cities(id, owner_id, rule_version, version, last_server_hour)
      VALUES (?, ?, '0.1.0', 0, 0)
    `).run(CITY, OWNER);
    const insertResource = raw.prepare(
      'INSERT INTO city_resources(city_id, resource_id, balance_micro) VALUES (?, ?, ?)',
    );
    for (const resourceId of ['food', 'steel', 'oil', 'supplies', 'manpower', 'scrip']) {
      insertResource.run(CITY, resourceId, 500_000);
    }
    const insertBuilding = raw.prepare(
      'INSERT INTO city_buildings(city_id, building_id, level) VALUES (?, ?, ?)',
    );
    for (const buildingId of ['hq', 'farm', 'steel_mill', 'refinery', 'supply_depot', 'housing', 'warehouse']) {
      insertBuilding.run(CITY, buildingId, buildingId === 'hq' ? 2 : 1);
    }
    raw.close();
  }

  const server = await db.open();
  assert.equal(server.schemaVersion, SERVER_SCHEMA_VERSION);
  const city = await server.getCity(CITY);
  assert.equal(city.version, 0);
  assert.equal(city.campaignRuleVersion, '0.1.0');
  assert.equal(city.resourcesMicro.food, 500_000);
  assert.equal(city.buildings.hq, 2);
  const operations = await server.getOperations(CITY);
  assert.equal(Object.values(operations.army.ready).reduce((sum, count) => sum + count, 0), 0);
  assert.equal(Object.keys(operations.army.ready).length, 12);
  assert.deepEqual(await server.listJobClaims(), []);

  // 업그레이드된 DB에서 v2 기능(시작→claim)이 곧바로 동작한다.
  const started = await server.startConstruction(context(OWNER, 10), startCommand());
  const result = await server.claimDueConstructionJobs(
    context(WORKER_A, started.response.completesAtHour),
    { limit: 10 },
  );
  assert.equal(result.claimed.length, 1);
  assert.equal(result.claimed[0]?.jobId, started.response.jobId);

  await db.close(server);
  const raw = new DatabaseSync(db.databasePath, { enableForeignKeyConstraints: true });
  try {
    const userVersion = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    const migrations = raw.prepare(
      'SELECT COUNT(*) AS count, MIN(version) AS minimum, MAX(version) AS maximum FROM schema_migrations',
    ).get() as { count: number; minimum: number; maximum: number };
    assert.equal(userVersion.user_version, SERVER_SCHEMA_VERSION);
    assert.equal(migrations.count, SERVER_SCHEMA_VERSION);
    assert.equal(migrations.minimum, 1);
    assert.equal(migrations.maximum, SERVER_SCHEMA_VERSION);
  } finally {
    raw.close();
  }
});

test('claim 기본 흐름: 기한 전 빈 결과, lease 보유 중 타 워커 차단, 완료 시 claim 제거', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const { jobId, dueHour } = await seedDueJob(server);

  const early = await server.claimDueConstructionJobs(context(WORKER_A, dueHour - 1), { limit: 10 });
  assert.deepEqual(early, { claimed: [], deadLettered: [] });

  const claimed = await server.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });
  assert.equal(claimed.claimed.length, 1);
  assert.deepEqual(claimed.claimed[0], {
    jobId,
    cityId: CITY,
    buildingId: 'farm',
    targetLevel: 2,
    ruleVersion: '0.1.0',
    completesAtHour: dueHour,
    attempt: 1,
    leaseUntilHour: dueHour + 1,
  });

  const blocked = await server.claimDueConstructionJobs(context(WORKER_B, dueHour), { limit: 10 });
  assert.deepEqual(blocked, { claimed: [], deadLettered: [] });

  const snapshots = await server.listJobClaims(CITY);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], {
    jobId,
    workerId: WORKER_A,
    state: 'leased',
    attemptCount: 1,
    claimedAtHour: dueHour,
    leaseUntilHour: dueHour + 1,
    lastError: null,
  });

  await completeJob(server, jobId, dueHour, 'complete:claim-flow');
  assert.deepEqual(await server.listJobClaims(), []);
  const afterComplete = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 1), { limit: 10 });
  assert.deepEqual(afterComplete, { claimed: [], deadLettered: [] });
});

test('claim은 worker 주체 전용이고 형식이 깨진 명령·정책을 거부한다', async (t) => {
  const db = fixture(t);
  await expectCode(
    async () => await db.open({ jobPolicy: { maxAttempts: 0 } }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await db.open({ jobPolicy: { maxAttempts: 5, extra: 1 } as never }),
    'INVALID_INPUT',
  );
  const server = await db.open();
  const { dueHour, jobId } = await seedDueJob(server);

  await expectCode(async () => await server.claimDueConstructionJobs(context(OWNER, dueHour), { limit: 10 }), 'FORBIDDEN');
  await expectCode(async () => await server.claimDueConstructionJobs(context('worker:', dueHour), { limit: 10 }), 'FORBIDDEN');
  await expectCode(
    async () => await server.claimDueConstructionJobs(context(CONSTRUCTION_WORKER_ID, dueHour), { limit: 10 }),
    'FORBIDDEN',
  );
  for (const command of [
    {},
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 10, leaseHours: 0 },
    { limit: 10, leaseHours: 169 },
    { limit: 10, extra: true },
  ]) {
    await expectCode(
      async () => await server.claimDueConstructionJobs(context(WORKER_A, dueHour), command as never),
      'INVALID_INPUT',
    );
  }
  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_A, dueHour), { jobId, error: '' }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_A, dueHour), { jobId, error: 'x'.repeat(201) }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_A, dueHour), { jobId, error: 'boom' }),
    'NOT_FOUND',
  );
  assert.deepEqual(await server.listJobClaims(), []);
});

test('worker crash 복구: lease 만료 전에는 보호되고 만료 후 재claim으로 시도가 증가한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const { jobId, dueHour } = await seedDueJob(server);

  const first = await server.claimDueConstructionJobs(
    context(WORKER_A, dueHour),
    { limit: 10, leaseHours: 2 },
  );
  assert.equal(first.claimed[0]?.leaseUntilHour, dueHour + 2);

  // WORKER_A가 crash했다고 가정 — 보고 없음. lease 만료 전에는 아무도 못 가져간다.
  const beforeExpiry = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 1), { limit: 10 });
  assert.deepEqual(beforeExpiry, { claimed: [], deadLettered: [] });

  const reclaimed = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 2), { limit: 10 });
  assert.equal(reclaimed.claimed.length, 1);
  assert.equal(reclaimed.claimed[0]?.attempt, 2);
  assert.equal(reclaimed.claimed[0]?.leaseUntilHour, dueHour + 3);
  assert.equal((await server.listJobClaims())[0]?.workerId, WORKER_B);

  await completeJob(server, jobId, dueHour + 2, 'complete:crash-recovery');
  const city = await server.getCity(CITY);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.completionEffectCount, 1);
  assert.deepEqual(await server.listJobClaims(), []);
});

test('failClaimedJob은 지수 백오프로 재claim을 늦추고 last_error를 보존한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const { jobId, dueHour } = await seedDueJob(server);

  await server.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });
  const firstFail = await server.failClaimedConstructionJob(
    context(WORKER_A, dueHour),
    { jobId, error: 'engine timeout' },
  );
  assert.deepEqual(firstFail, {
    jobId,
    state: 'retry_scheduled',
    attempt: 1,
    nextEligibleHour: dueHour + 1,
  });

  assert.deepEqual(
    await server.claimDueConstructionJobs(context(WORKER_B, dueHour), { limit: 10 }),
    { claimed: [], deadLettered: [] },
  );
  const second = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 1), { limit: 10 });
  assert.equal(second.claimed[0]?.attempt, 2);

  const secondFail = await server.failClaimedConstructionJob(
    context(WORKER_B, dueHour + 1),
    { jobId, error: 'still failing' },
  );
  assert.deepEqual(secondFail, {
    jobId,
    state: 'retry_scheduled',
    attempt: 2,
    nextEligibleHour: dueHour + 3,
  });

  const snapshot = (await server.listJobClaims())[0];
  assert.equal(snapshot?.state, 'leased');
  assert.equal(snapshot?.lastError, 'still failing');
  assert.deepEqual(
    await server.claimDueConstructionJobs(context(WORKER_A, dueHour + 2), { limit: 10 }),
    { claimed: [], deadLettered: [] },
  );
  assert.equal(
    (await server.claimDueConstructionJobs(context(WORKER_A, dueHour + 3), { limit: 10 })).claimed[0]?.attempt,
    3,
  );
});

test('최대 시도 소진 시 fail 보고가 dead letter로 전환하고 이후 스캔에서 제외한다', async (t) => {
  const db = fixture(t);
  const server = await db.open({ jobPolicy: { maxAttempts: 2 } });
  const { jobId, dueHour } = await seedDueJob(server);

  await server.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });
  const firstFail = await server.failClaimedConstructionJob(
    context(WORKER_A, dueHour),
    { jobId, error: 'attempt 1 failed' },
  );
  assert.equal(firstFail.state, 'retry_scheduled');

  await server.claimDueConstructionJobs(context(WORKER_A, dueHour + 1), { limit: 10 });
  const finalFail = await server.failClaimedConstructionJob(
    context(WORKER_A, dueHour + 1),
    { jobId, error: 'attempt 2 failed' },
  );
  assert.deepEqual(finalFail, {
    jobId,
    state: 'dead',
    attempt: 2,
    nextEligibleHour: null,
  });

  const snapshot = (await server.listJobClaims())[0];
  assert.equal(snapshot?.state, 'dead');
  assert.equal(snapshot?.attemptCount, 2);
  assert.equal(snapshot?.lastError, 'attempt 2 failed');

  // dead job은 스캔 대상이 아니며 재전환도 없다.
  assert.deepEqual(
    await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 100), { limit: 10 }),
    { claimed: [], deadLettered: [] },
  );
  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_A, dueHour + 100), { jobId, error: 'late' }),
    'CLAIM_EXPIRED',
  );
});

test('보고 없이 crash한 워커의 시도 소진은 재claim 스캔이 dead letter로 전환한다', async (t) => {
  const db = fixture(t);
  const server = await db.open({ jobPolicy: { maxAttempts: 1 } });
  const { jobId, dueHour } = await seedDueJob(server);

  const first = await server.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });
  assert.equal(first.claimed.length, 1);

  // 보고 없이 lease 만료 → 스캔이 시도 소진을 발견하고 dead letter로 전환한다.
  const scan = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 1), { limit: 10 });
  assert.deepEqual(scan, { claimed: [], deadLettered: [jobId] });

  const snapshot = (await server.listJobClaims())[0];
  assert.equal(snapshot?.state, 'dead');
  assert.equal(snapshot?.attemptCount, 1);
  assert.equal(snapshot?.lastError, '최대 시도 소진: lease 만료 재claim 스캔에서 전환');

  assert.deepEqual(
    await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 2), { limit: 10 }),
    { claimed: [], deadLettered: [] },
  );
});

test('fail·release의 소유권 검증과 release 후 즉시 재claim', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const { jobId, dueHour } = await seedDueJob(server);

  await server.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });

  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_B, dueHour), { jobId, error: 'not mine' }),
    'CLAIM_EXPIRED',
  );
  await expectCode(
    async () => await server.releaseConstructionJobClaim(context(WORKER_B, dueHour), { jobId }),
    'CLAIM_EXPIRED',
  );
  // lease 만료 후에는 원 소유자도 보고할 수 없다(다른 워커가 소유할 수 있으므로).
  await expectCode(
    async () => await server.failClaimedConstructionJob(context(WORKER_A, dueHour + 1), { jobId, error: 'late' }),
    'CLAIM_EXPIRED',
  );

  const reclaimed = await server.claimDueConstructionJobs(context(WORKER_A, dueHour + 1), { limit: 10 });
  assert.equal(reclaimed.claimed[0]?.attempt, 2);

  const release = await server.releaseConstructionJobClaim(context(WORKER_A, dueHour + 1), { jobId });
  assert.deepEqual(release, { jobId, released: true });

  // 반납 즉시(같은 시각) 다른 워커가 가져갈 수 있고 시도는 유지된다.
  const afterRelease = await server.claimDueConstructionJobs(context(WORKER_B, dueHour + 1), { limit: 10 });
  assert.equal(afterRelease.claimed[0]?.attempt, 3);
  assert.equal((await server.listJobClaims())[0]?.workerId, WORKER_B);

  await completeJob(server, jobId, dueHour + 1, 'complete:release-flow');
  assert.deepEqual(
    await server.releaseConstructionJobClaim(context(WORKER_B, dueHour + 1), { jobId }),
    { jobId, released: false },
  );
});

test('claim과 완료의 failpoint는 완전 rollback되고 재시도가 성공한다', async (t) => {
  const db = fixture(t);
  let faultArmed = true;
  const faulty = await db.open({
    faultInjector: (point) => {
      if (faultArmed && point === 'claim:after_upsert') {
        throw new Error('injected claim fault');
      }
    },
  });
  const { jobId, dueHour } = await seedDueJob(faulty);

  await expectCode(
    async () => await faulty.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 }),
    'DATABASE_FAILURE',
  );
  assert.equal(faulty.isTransaction, false);
  assert.deepEqual(await faulty.listJobClaims(), []);

  faultArmed = false;
  const retried = await faulty.claimDueConstructionJobs(context(WORKER_A, dueHour), { limit: 10 });
  assert.equal(retried.claimed[0]?.attempt, 1);
  await db.close(faulty);

  let completeArmed = true;
  const completeFaulty = await db.open({
    faultInjector: (point) => {
      if (completeArmed && point === 'complete:after_claim_delete') {
        throw new Error('injected complete fault');
      }
    },
  });
  await expectCode(
    async () => await completeFaulty.completeConstruction(
      context(CONSTRUCTION_WORKER_ID, dueHour),
      { commandId: 'complete:fault', jobId },
    ),
    'DATABASE_FAILURE',
  );
  assert.equal(completeFaulty.isTransaction, false);
  // rollback으로 claim·job·건물이 모두 유지된다.
  assert.equal((await completeFaulty.listJobClaims())[0]?.state, 'leased');
  const cityBefore = await completeFaulty.getCity(CITY);
  assert.equal(cityBefore.buildings.farm, 1);
  assert.equal(cityBefore.jobs[0]?.status, 'pending');

  completeArmed = false;
  await completeJob(completeFaulty, jobId, dueHour, 'complete:fault');
  assert.deepEqual(await completeFaulty.listJobClaims(), []);
  const cityAfter = await completeFaulty.getCity(CITY);
  assert.equal(cityAfter.buildings.farm, 2);
  assert.equal(cityAfter.completionEffectCount, 1);
});

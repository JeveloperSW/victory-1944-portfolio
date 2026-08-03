import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { stableStringify } from '../../engine/src/index.js';
import {
  CONSTRUCTION_WORKER_ID,
  ConstructionServer,
  SERVER_SCHEMA_VERSION,
  ServerError,
} from '../src/index.js';
import type {
  ClaimDueJobsCommand,
  CommandContext,
  CompleteConstructionCommand,
  ConstructionServerOptions,
  FaultPoint,
  StartConstructionCommand,
} from '../src/index.js';

const OWNER = 'user:alpha';
const CITY = 'city:alpha';
const READY_BUILDINGS = { hq: 2 } as const;
const MAX_CITY_VERSION = 2_147_483_647;

interface Fixture {
  readonly databasePath: string;
  open(options?: ConstructionServerOptions): Promise<ConstructionServer>;
  close(server: ConstructionServer): Promise<void>;
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-construction-'));
  const databasePath = join(directory, 'construction.sqlite');
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

function context(actorId = OWNER, nowHour = 10): CommandContext {
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

function completeCommand(
  jobId: string,
  overrides: Partial<CompleteConstructionCommand> = {},
): CompleteConstructionCommand {
  return {
    commandId: 'complete:farm:1',
    jobId,
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

async function expectNoCityChange(
  server: ConstructionServer,
  cityId: string,
  code: ServerError['code'],
  operation: () => unknown,
): Promise<void> {
  const before = structuredClone(await server.getCity(cityId));
  await expectCode(operation, code);
  assert.deepEqual(await server.getCity(cityId), before);
  assert.equal(server.isTransaction, false);
}

function withRawDatabase<T>(databasePath: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
  });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

test('startConstruction은 micro 비용·원장·job·version·SHA-256 receipt를 한 번 기록한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const seeded = await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const command = startCommand();

  const execution = await server.startConstruction(context(), command);

  assert.equal(execution.replayed, false);
  assert.deepEqual(execution.response.cost, { food: 20, steel: 50 });
  assert.deepEqual(execution.response, {
    cityId: CITY,
    cityVersion: 1,
    jobId: execution.response.jobId,
    buildingId: 'farm',
    targetLevel: 2,
    startedAtHour: 10,
    completesAtHour: 11,
    cost: { food: 20, steel: 50 },
    ruleVersion: '0.1.0',
  });
  assert.match(execution.response.jobId, /^job:[0-9a-f]{48}$/);

  const city = await server.getCity(CITY);
  assert.equal(city.version, 1);
  assert.equal(city.lastServerHour, 10);
  assert.equal(city.resourcesMicro.food, seeded.resourcesMicro.food - 20_000);
  assert.equal(city.resourcesMicro.steel, seeded.resourcesMicro.steel - 50_000);
  assert.equal(city.resourcesMicro.oil, seeded.resourcesMicro.oil);
  assert.deepEqual(city.jobs, [{
    id: execution.response.jobId,
    cityId: CITY,
    buildingId: 'farm',
    targetLevel: 2,
    ruleVersion: '0.1.0',
    startedAtHour: 10,
    completesAtHour: 11,
    effectiveAtHour: null,
    processedAtHour: null,
    status: 'pending',
  }]);
  assert.deepEqual(city.ledger.map((entry) => ({
    resourceId: entry.resourceId,
    commandId: entry.commandId,
    jobId: entry.jobId,
    reason: entry.reason,
    deltaMicro: entry.deltaMicro,
    balanceBeforeMicro: entry.balanceBeforeMicro,
    balanceAfterMicro: entry.balanceAfterMicro,
    createdAtHour: entry.createdAtHour,
  })), [
    {
      resourceId: 'food',
      commandId: command.commandId,
      jobId: execution.response.jobId,
      reason: 'construction_start',
      deltaMicro: -20_000,
      balanceBeforeMicro: seeded.resourcesMicro.food,
      balanceAfterMicro: seeded.resourcesMicro.food - 20_000,
      createdAtHour: 10,
    },
    {
      resourceId: 'steel',
      commandId: command.commandId,
      jobId: execution.response.jobId,
      reason: 'construction_start',
      deltaMicro: -50_000,
      balanceBeforeMicro: seeded.resourcesMicro.steel,
      balanceAfterMicro: seeded.resourcesMicro.steel - 50_000,
      createdAtHour: 10,
    },
  ]);

  const payloadJson = stableStringify({
    kind: 'start_construction',
    commandId: command.commandId,
    cityId: command.cityId,
    expectedVersion: command.expectedVersion,
    buildingId: command.buildingId,
  });
  assert.equal(city.receipts.length, 1);
  assert.deepEqual(city.receipts[0], {
    actorId: OWNER,
    commandId: command.commandId,
    cityId: CITY,
    commandKind: 'start_construction',
    payloadSha256: createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
    payloadJson,
    responseJson: stableStringify(execution.response),
    createdAtHour: 10,
  });
  assert.equal(city.receipts[0]?.payloadSha256.length, 64);
  assert.equal(city.completionEffectCount, 0);
});

test('재시작 뒤 동일 start payload는 저장 응답을 재생하고 key 재사용은 stale보다 먼저 거부한다', async (t) => {
  const db = fixture(t);
  let server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const command = startCommand();
  const first = await server.startConstruction(context(), command);
  const afterFirst = structuredClone(await server.getCity(CITY));
  await db.close(server);

  server = await db.open();
  const replay = await server.startConstruction(context(OWNER, 500), command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);
  assert.deepEqual(await server.getCity(CITY), afterFirst);

  await expectNoCityChange(server, CITY, 'IDEMPOTENCY_KEY_REUSED', async () => {
    await server.startConstruction(context(OWNER, 500), {
      ...command,
      buildingId: 'steel_mill',
    });
  });
  await expectNoCityChange(server, CITY, 'IDEMPOTENCY_KEY_REUSED', async () => {
    await server.startConstruction(context(OWNER, 500), {
      ...command,
      expectedVersion: 1,
    });
  });
});

test('타인·extra field·unknown ID·stale·시간 역행·단일 자원 부족은 상태를 바꾸지 않는다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });

  await expectNoCityChange(server, CITY, 'FORBIDDEN', async () => {
    await server.startConstruction(context('user:outsider'), startCommand({ commandId: 'reject:outsider' }));
  });
  await expectNoCityChange(server, CITY, 'INVALID_INPUT', async () => {
    await server.startConstruction(
      context(),
      { ...startCommand({ commandId: 'reject:extra' }), clientCost: 0 } as unknown as StartConstructionCommand,
    );
  });
  await expectNoCityChange(server, CITY, 'UNKNOWN_BUILDING', async () => {
    await server.startConstruction(
      context(),
      { ...startCommand({ commandId: 'reject:building' }), buildingId: 'gold_mine' } as unknown as StartConstructionCommand,
    );
  });
  await expectNoCityChange(server, CITY, 'NOT_FOUND', async () => {
    await server.startConstruction(context(), startCommand({
      commandId: 'reject:unknown-city',
      cityId: 'city:missing',
    }));
  });
  await expectNoCityChange(server, CITY, 'STALE_VERSION', async () => {
    await server.startConstruction(context(), startCommand({
      commandId: 'reject:stale',
      expectedVersion: 9,
    }));
  });

  await server.seedCity({
    cityId: 'city:future',
    ownerId: 'user:future',
    lastServerHour: 20,
    buildings: READY_BUILDINGS,
  });
  await expectNoCityChange(server, 'city:future', 'TIME_REVERSED', async () => {
    await server.startConstruction(
      context('user:future', 19),
      startCommand({ commandId: 'reject:time', cityId: 'city:future' }),
    );
  });

  await server.seedCity({
    cityId: 'city:low-food',
    ownerId: 'user:low-food',
    resources: { food: 19, steel: 500 },
    buildings: READY_BUILDINGS,
  });
  await expectNoCityChange(server, 'city:low-food', 'INSUFFICIENT_RESOURCES', async () => {
    await server.startConstruction(
      context('user:low-food'),
      startCommand({ commandId: 'reject:food', cityId: 'city:low-food' }),
    );
  });

  await server.seedCity({
    cityId: 'city:low-steel',
    ownerId: 'user:low-steel',
    resources: { food: 500, steel: 49 },
    buildings: READY_BUILDINGS,
  });
  await expectNoCityChange(server, 'city:low-steel', 'INSUFFICIENT_RESOURCES', async () => {
    await server.startConstruction(
      context('user:low-steel'),
      startCommand({ commandId: 'reject:steel', cityId: 'city:low-steel' }),
    );
  });

  await expectNoCityChange(server, CITY, 'NOT_FOUND', async () => {
    await server.completeConstruction(
      context(CONSTRUCTION_WORKER_ID),
      completeCommand('job:missing', { commandId: 'reject:unknown-job' }),
    );
  });
});

test('expectedVersion과 nowHour의 fraction·NaN·Infinity·상한 초과를 표 기반으로 거부한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });

  const invalidVersions = [0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CITY_VERSION + 1];
  for (const [index, expectedVersion] of invalidVersions.entries()) {
    await expectNoCityChange(server, CITY, 'INVALID_INPUT', async () => {
      await server.startConstruction(
        context(),
        startCommand({
          commandId: `invalid:version:${index}`,
          expectedVersion,
        }),
      );
    });
  }

  const invalidHours = [0.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001];
  for (const [index, nowHour] of invalidHours.entries()) {
    await expectNoCityChange(server, CITY, 'INVALID_INPUT', async () => {
      await server.startConstruction(
        context(OWNER, nowHour),
        startCommand({ commandId: `invalid:hour:${index}` }),
      );
    });
  }
});

test('seed 자원의 NaN·Infinity·소수 3자리 초과·MAX_SAFE micro 초과는 도시를 남기지 않는다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const invalidResources = [
    { label: 'nan', value: Number.NaN },
    { label: 'infinity', value: Number.POSITIVE_INFINITY },
    { label: 'four-decimals', value: 1.0001 },
    { label: 'micro-overflow', value: (Number.MAX_SAFE_INTEGER + 1) / 1000 },
  ] as const;

  for (const { label, value } of invalidResources) {
    const cityId = `city:invalid-resource:${label}`;
    await expectCode(async () => await server.seedCity({
      cityId,
      ownerId: `user:invalid-resource:${label}`,
      resources: { food: value },
      buildings: READY_BUILDINGS,
    }), 'INVALID_INPUT');
    assert.equal(server.isTransaction, false);
    await expectCode(async () => await server.getCity(cityId), 'NOT_FOUND');
  }
});

test('HQ 게이트·최대 레벨·같은 건물 pending·동시 2슬롯을 강제한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();

  await server.seedCity({
    cityId: 'city:hq-gate',
    ownerId: 'user:hq-gate',
    buildings: { hq: 1, farm: 2 },
  });
  await expectNoCityChange(server, 'city:hq-gate', 'HQ_LEVEL_REQUIRED', async () => {
    await server.startConstruction(
      context('user:hq-gate'),
      startCommand({ commandId: 'gate:farm', cityId: 'city:hq-gate' }),
    );
  });

  await server.seedCity({
    cityId: 'city:max',
    ownerId: 'user:max',
    buildings: { hq: 10, farm: 10 },
  });
  await expectNoCityChange(server, 'city:max', 'MAX_LEVEL', async () => {
    await server.startConstruction(
      context('user:max'),
      startCommand({ commandId: 'max:farm', cityId: 'city:max' }),
    );
  });

  await server.seedCity({
    cityId: 'city:slots',
    ownerId: 'user:slots',
    resources: { food: 1_000, steel: 1_000 },
    buildings: READY_BUILDINGS,
  });
  await server.startConstruction(
    context('user:slots'),
    startCommand({ commandId: 'slots:farm', cityId: 'city:slots' }),
  );
  await expectNoCityChange(server, 'city:slots', 'BUILDING_ALREADY_PENDING', async () => {
    await server.startConstruction(
      context('user:slots'),
      startCommand({
        commandId: 'slots:farm-again',
        cityId: 'city:slots',
        expectedVersion: 1,
      }),
    );
  });
  await server.startConstruction(
    context('user:slots'),
    startCommand({
      commandId: 'slots:steel',
      cityId: 'city:slots',
      expectedVersion: 1,
      buildingId: 'steel_mill',
    }),
  );
  assert.equal((await server.getCity('city:slots')).jobs.filter((job) => job.status === 'pending').length, 2);
  await expectNoCityChange(server, 'city:slots', 'BUILD_SLOT_FULL', async () => {
    await server.startConstruction(
      context('user:slots'),
      startCommand({
        commandId: 'slots:third',
        cityId: 'city:slots',
        expectedVersion: 2,
        buildingId: 'refinery',
      }),
    );
  });
});

test('completeConstruction은 worker 전용이며 직전은 거부하고 정확한 완료 경계부터 적용한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction(context(), startCommand());
  const beforeComplete = structuredClone(await server.getCity(CITY));
  const command = completeCommand(started.response.jobId);

  await expectNoCityChange(server, CITY, 'FORBIDDEN', async () => {
    await server.completeConstruction(context(OWNER, 11), command);
  });
  await expectNoCityChange(server, CITY, 'TOO_EARLY', async () => {
    await server.completeConstruction(context(CONSTRUCTION_WORKER_ID, 10), command);
  });
  assert.deepEqual(await server.getCity(CITY), beforeComplete);

  const completed = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, 11),
    command,
  );
  assert.equal(completed.replayed, false);
  assert.deepEqual(completed.response, {
    cityId: CITY,
    cityVersion: 2,
    jobId: started.response.jobId,
    buildingId: 'farm',
    targetLevel: 2,
    effectiveAtHour: 11,
    processedAtHour: 11,
    ruleVersion: '0.1.0',
  });
  const city = await server.getCity(CITY);
  assert.equal(city.version, 2);
  assert.equal(city.lastServerHour, 11);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.jobs[0]?.status, 'completed');
  assert.equal(city.jobs[0]?.effectiveAtHour, 11);
  assert.equal(city.jobs[0]?.processedAtHour, 11);
  assert.equal(city.completionEffectCount, 1);
  assert.equal(city.receipts.length, 2);
});

test('완료 동일·다른 key와 재시작 재시도에도 effect·level·version은 한 번만 증가한다', async (t) => {
  const db = fixture(t);
  let server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction(context(), startCommand());
  const firstCommand = completeCommand(started.response.jobId);
  const first = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, 11),
    firstCommand,
  );
  const sameKey = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, 50),
    firstCommand,
  );
  assert.equal(sameKey.replayed, true);
  assert.deepEqual(sameKey.response, first.response);

  const anotherKey = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, 60),
    completeCommand(started.response.jobId, { commandId: 'complete:farm:2' }),
  );
  assert.equal(anotherKey.replayed, true);
  assert.deepEqual(anotherKey.response, first.response);
  assert.equal((await server.getCity(CITY)).receipts.length, 3);
  await db.close(server);

  server = await db.open();
  const afterRestart = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, 70),
    completeCommand(started.response.jobId, { commandId: 'complete:farm:3' }),
  );
  assert.equal(afterRestart.replayed, true);
  assert.deepEqual(afterRestart.response, first.response);
  const city = await server.getCity(CITY);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.version, 2);
  assert.equal(city.completionEffectCount, 1);
  assert.equal(city.jobs.length, 1);
  assert.equal(city.jobs[0]?.status, 'completed');
  assert.equal(city.receipts.length, 4);
});

test('complete same key의 jobId 변경과 같은 actor/key의 cross-kind 재사용을 거부한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await server.seedCity({
    cityId: CITY,
    ownerId: OWNER,
    buildings: READY_BUILDINGS,
    resources: { food: 1_000, steel: 1_000 },
  });
  const farm = await server.startConstruction(
    context(),
    startCommand({ commandId: 'reuse:start:farm' }),
  );
  const steel = await server.startConstruction(
    context(),
    startCommand({
      commandId: 'reuse:start:steel',
      expectedVersion: 1,
      buildingId: 'steel_mill',
    }),
  );
  const completionKey = 'reuse:complete:key';
  await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, farm.response.completesAtHour),
    completeCommand(farm.response.jobId, { commandId: completionKey }),
  );
  await expectNoCityChange(server, CITY, 'IDEMPOTENCY_KEY_REUSED', async () => {
    await server.completeConstruction(
      context(CONSTRUCTION_WORKER_ID, steel.response.completesAtHour),
      completeCommand(steel.response.jobId, { commandId: completionKey }),
    );
  });
  assert.equal((await server.getCity(CITY)).jobs.find((job) => job.id === steel.response.jobId)?.status, 'pending');

  const crossCityId = 'city:cross-kind';
  await server.seedCity({
    cityId: crossCityId,
    ownerId: CONSTRUCTION_WORKER_ID,
    buildings: READY_BUILDINGS,
  });
  const crossKey = 'reuse:cross-kind';
  const crossStart = await server.startConstruction(
    context(CONSTRUCTION_WORKER_ID),
    startCommand({
      commandId: crossKey,
      cityId: crossCityId,
    }),
  );
  await expectNoCityChange(server, crossCityId, 'IDEMPOTENCY_KEY_REUSED', async () => {
    await server.completeConstruction(
      context(CONSTRUCTION_WORKER_ID, crossStart.response.completesAtHour),
      completeCommand(crossStart.response.jobId, { commandId: crossKey }),
    );
  });
});

test('start와 pending complete는 city version 상한에서 상태 변경 없이 거부된다', async (t) => {
  const db = fixture(t);
  const server = await db.open();

  await server.seedCity({
    cityId: 'city:max-version-start',
    ownerId: 'user:max-version-start',
    version: MAX_CITY_VERSION,
    buildings: READY_BUILDINGS,
  });
  await expectNoCityChange(server, 'city:max-version-start', 'VERSION_EXHAUSTED', async () => {
    await server.startConstruction(
      context('user:max-version-start'),
      startCommand({
        commandId: 'version:start',
        cityId: 'city:max-version-start',
        expectedVersion: MAX_CITY_VERSION,
      }),
    );
  });

  await server.seedCity({
    cityId: 'city:max-version-complete',
    ownerId: 'user:max-version-complete',
    version: MAX_CITY_VERSION - 1,
    buildings: READY_BUILDINGS,
  });
  const started = await server.startConstruction(
    context('user:max-version-complete'),
    startCommand({
      commandId: 'version:pending',
      cityId: 'city:max-version-complete',
      expectedVersion: MAX_CITY_VERSION - 1,
    }),
  );
  assert.equal((await server.getCity('city:max-version-complete')).version, MAX_CITY_VERSION);
  await expectNoCityChange(server, 'city:max-version-complete', 'VERSION_EXHAUSTED', async () => {
    await server.completeConstruction(
      context(CONSTRUCTION_WORKER_ID, started.response.completesAtHour),
      completeCommand(started.response.jobId, { commandId: 'version:complete' }),
    );
  });
});

type CanonicalCorruption = 'field_set' | 'city' | 'job';

function corruptCanonicalResponse(
  response: object,
  corruption: CanonicalCorruption,
): string {
  const record = structuredClone(response) as Record<string, unknown>;
  if (corruption === 'field_set') record.unexpectedCanonicalField = true;
  if (corruption === 'city') record.cityId = 'city:semantic-corruption';
  if (corruption === 'job') record.jobId = 'job:semantic-corruption';
  return stableStringify(record);
}

test('canonical start receipt의 필드 집합·도시·job 손상은 재생되지 않는다', async (t) => {
  for (const corruption of ['field_set', 'city', 'job'] as const) {
    await t.test(corruption, async (subtest) => {
      const db = fixture(subtest);
      let server = await db.open();
      await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
      const command = startCommand({ commandId: `corrupt:start:${corruption}` });
      const started = await server.startConstruction(context(), command);
      await db.close(server);

      const corrupted = corruptCanonicalResponse(started.response, corruption);
      withRawDatabase(db.databasePath, (database) => {
        const updated = database.prepare(`
          UPDATE command_receipts SET response_json = ?
          WHERE actor_id = ? AND command_id = ?
        `).run(corrupted, OWNER, command.commandId);
        assert.equal(updated.changes, 1);
      });

      server = await db.open();
      await expectNoCityChange(server, CITY, 'DATA_INTEGRITY', async () => {
        await server.startConstruction(context(OWNER, 50), command);
      });
      assert.equal((await server.getCity(CITY)).receipts.length, 1);
      assert.equal((await server.getCity(CITY)).receipts[0]?.responseJson, corrupted);
    });
  }
});

test('canonical completion receipt가 effect와 달라지면 동일 key 재생을 fail closed한다', async (t) => {
  const db = fixture(t);
  let server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction(context(), startCommand());
  const command = completeCommand(started.response.jobId, {
    commandId: 'corrupt:complete:receipt',
  });
  const completed = await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, started.response.completesAtHour),
    command,
  );
  await db.close(server);

  const corrupted = corruptCanonicalResponse(completed.response, 'field_set');
  withRawDatabase(db.databasePath, (database) => {
    const updated = database.prepare(`
      UPDATE command_receipts SET response_json = ?
      WHERE actor_id = ? AND command_id = ?
    `).run(corrupted, CONSTRUCTION_WORKER_ID, command.commandId);
    assert.equal(updated.changes, 1);
  });

  server = await db.open();
  await expectNoCityChange(server, CITY, 'DATA_INTEGRITY', async () => {
    await server.completeConstruction(
      context(CONSTRUCTION_WORKER_ID, 50),
      command,
    );
  });
  assert.equal((await server.getCity(CITY)).receipts.length, 2);
});

test('canonical completion effect의 필드 집합·도시·job 손상은 alias receipt 없이 거부된다', async (t) => {
  for (const corruption of ['field_set', 'city', 'job'] as const) {
    await t.test(corruption, async (subtest) => {
      const db = fixture(subtest);
      let server = await db.open();
      await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
      const started = await server.startConstruction(context(), startCommand());
      const completed = await server.completeConstruction(
        context(CONSTRUCTION_WORKER_ID, started.response.completesAtHour),
        completeCommand(started.response.jobId),
      );
      await db.close(server);

      const corrupted = corruptCanonicalResponse(completed.response, corruption);
      withRawDatabase(db.databasePath, (database) => {
        const updated = database.prepare(`
          UPDATE completion_effects SET response_json = ? WHERE job_id = ?
        `).run(corrupted, started.response.jobId);
        assert.equal(updated.changes, 1);
      });

      server = await db.open();
      const aliasCommandId = `corrupt:alias:${corruption}`;
      await expectNoCityChange(server, CITY, 'DATA_INTEGRITY', async () => {
        await server.completeConstruction(
          context(CONSTRUCTION_WORKER_ID, 50),
          completeCommand(started.response.jobId, { commandId: aliasCommandId }),
        );
      });
      const city = await server.getCity(CITY);
      assert.equal(city.receipts.length, 2);
      assert.equal(city.receipts.some((receipt) => receipt.commandId === aliasCommandId), false);
    });
  }
});

test('completed job의 effective 또는 processed 시각을 NULL로 바꾸는 쓰기는 DB CHECK가 거부한다', async (t) => {
  const db = fixture(t);
  let server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction(context(), startCommand());
  await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, started.response.completesAtHour),
    completeCommand(started.response.jobId),
  );
  const completed = structuredClone(await server.getCity(CITY));
  await db.close(server);

  withRawDatabase(db.databasePath, (database) => {
    for (const column of ['effective_at_hour', 'processed_at_hour'] as const) {
      assert.throws(
        () => database.prepare(`
          UPDATE construction_jobs SET ${column} = NULL WHERE id = ?
        `).run(started.response.jobId),
        (error: unknown) => error instanceof Error && /CHECK constraint failed/i.test(error.message),
      );
    }
    const row = database.prepare(`
      SELECT status, effective_at_hour, processed_at_hour
      FROM construction_jobs WHERE id = ?
    `).get(started.response.jobId) as {
      status: string;
      effective_at_hour: number | null;
      processed_at_hour: number | null;
    };
    assert.equal(row.status, 'completed');
    assert.equal(row.effective_at_hour, started.response.completesAtHour);
    assert.equal(row.processed_at_hour, started.response.completesAtHour);
  });

  server = await db.open();
  assert.deepEqual(await server.getCity(CITY), completed);
});

const START_FAULT_POINTS: readonly FaultPoint[] = [
  'start:after_first_debit',
  'start:after_ledger',
  'start:after_job',
  'start:after_version',
  'start:after_receipt',
];

const COMPLETE_FAULT_POINTS: readonly FaultPoint[] = [
  'complete:after_building',
  'complete:after_job',
  'complete:after_effect',
  'complete:after_version',
  'complete:after_receipt',
];

test('start의 모든 failpoint는 연결과 파일에서 완전 rollback되고 같은 key 재시도가 성공한다', async (t) => {
  for (const point of START_FAULT_POINTS) {
    await t.test(point, async (subtest) => {
      const db = fixture(subtest);
      let server = await db.open({
        faultInjector(candidate) {
          if (candidate === point) throw new Error(`forced:${point}`);
        },
      });
      const baseline = await server.seedCity({
        cityId: CITY,
        ownerId: OWNER,
        buildings: READY_BUILDINGS,
      });
      const command = startCommand();

      await expectCode(async () => await server.startConstruction(context(), command), 'DATABASE_FAILURE');
      assert.equal(server.isTransaction, false);
      assert.deepEqual(await server.getCity(CITY), baseline);
      await db.close(server);

      server = await db.open();
      assert.deepEqual(await server.getCity(CITY), baseline);
      const retry = await server.startConstruction(context(), command);
      assert.equal(retry.replayed, false);
      const city = await server.getCity(CITY);
      assert.equal(city.version, 1);
      assert.equal(city.jobs.length, 1);
      assert.equal(city.ledger.length, 2);
      assert.equal(city.receipts.length, 1);
    });
  }
});

test('complete의 모든 failpoint는 연결과 파일에서 완전 rollback되고 같은 key 재시도가 성공한다', async (t) => {
  for (const point of COMPLETE_FAULT_POINTS) {
    await t.test(point, async (subtest) => {
      const db = fixture(subtest);
      let server = await db.open();
      await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
      const started = await server.startConstruction(context(), startCommand());
      const command = completeCommand(started.response.jobId);
      const baseline = structuredClone(await server.getCity(CITY));
      await db.close(server);

      server = await db.open({
        faultInjector(candidate) {
          if (candidate === point) throw new Error(`forced:${point}`);
        },
      });
      await expectCode(
        async () => await server.completeConstruction(context(CONSTRUCTION_WORKER_ID, 11), command),
        'DATABASE_FAILURE',
      );
      assert.equal(server.isTransaction, false);
      assert.deepEqual(await server.getCity(CITY), baseline);
      await db.close(server);

      server = await db.open();
      assert.deepEqual(await server.getCity(CITY), baseline);
      const retry = await server.completeConstruction(
        context(CONSTRUCTION_WORKER_ID, 11),
        command,
      );
      assert.equal(retry.replayed, false);
      const city = await server.getCity(CITY);
      assert.equal(city.version, 2);
      assert.equal(city.buildings.farm, 2);
      assert.equal(city.completionEffectCount, 1);
      assert.equal(city.receipts.length, 2);
    });
  }
});

test('지원 범위를 넘는 user_version 99는 자동 추측 없이 fail closed한다', async (t) => {
  const db = fixture(t);
  const raw = new DatabaseSync(db.databasePath);
  raw.exec('PRAGMA user_version = 99');
  const initialJournal = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const initialMigrationTable = raw.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  assert.equal(initialMigrationTable, undefined);
  raw.close();

  await expectCode(async () => ConstructionServer.open(db.databasePath), 'UNSUPPORTED_SCHEMA');

  const reopened = new DatabaseSync(db.databasePath, { readOnly: true });
  const version = reopened.prepare('PRAGMA user_version').get() as { user_version: number };
  const journal = reopened.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const migrationTable = reopened.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  assert.equal(version.user_version, 99);
  assert.equal(journal.journal_mode, initialJournal.journal_mode);
  assert.equal(migrationTable, undefined);
  reopened.close();
});

interface WorkerSuccess {
  readonly ok: true;
  readonly execution: {
    readonly replayed: boolean;
    readonly response: Record<string, unknown>;
  };
}

interface WorkerFailure {
  readonly ok: false;
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
  readonly causeMessage?: string;
}

type WorkerOutcome = WorkerSuccess | WorkerFailure;

interface WorkerMessage {
  readonly type: 'ready' | 'result';
  readonly result?: WorkerOutcome;
}

type RaceInput = {
  readonly operation: 'open';
} | {
  readonly operation: 'start' | 'complete';
  readonly context: CommandContext;
  readonly command: StartConstructionCommand | CompleteConstructionCommand;
} | {
  readonly operation: 'claim';
  readonly context: CommandContext;
  readonly command: ClaimDueJobsCommand;
};

interface WorkerHandle {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  readonly result: Promise<WorkerOutcome>;
  readonly exited: Promise<void>;
}

function launchWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  input: RaceInput,
): WorkerHandle {
  const tsxPreflight = fileURLToPath(
    new URL('../../engine/node_modules/tsx/dist/preflight.cjs', import.meta.url),
  );
  const tsxLoader = new URL(
    '../../engine/node_modules/tsx/dist/loader.mjs',
    import.meta.url,
  ).href;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: {
      databasePath,
      gate,
      busyTimeoutMs: 5_000,
      ...input,
    },
    execArgv: ['--require', tsxPreflight, '--import', tsxLoader],
  });

  let readySettled = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: WorkerOutcome) => void;
  let rejectResult!: (error: Error) => void;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerOutcome>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') {
      readySettled = true;
      resolveReady();
      return;
    }
    if (message.result === undefined) return;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(`worker failed before barrier: ${JSON.stringify(message.result)}`));
    }
    resultSettled = true;
    resolveResult(message.result);
  });
  worker.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
    rejectExit(error);
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`construction worker exited with code ${code}`);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(error);
      }
      rejectExit(error);
      return;
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(new Error('construction worker exited without a result'));
    }
    resolveExit();
  });

  return { worker, ready, result, exited };
}

async function raceWorkers(
  databasePath: string,
  first: RaceInput,
  second: RaceInput,
): Promise<readonly [WorkerOutcome, WorkerOutcome]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const handles = [
    launchWorker(databasePath, gate, first),
    launchWorker(databasePath, gate, second),
  ] as const;
  try {
    await Promise.all(handles.map((handle) => handle.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, handles.length);
    const outcomes = await Promise.all(handles.map((handle) => handle.result));
    await Promise.all(handles.map((handle) => handle.exited));
    return [outcomes[0]!, outcomes[1]!];
  } catch (error) {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, handles.length);
    await Promise.allSettled(handles.map((handle) => handle.worker.terminate()));
    throw error;
  }
}

function successful(outcomes: readonly WorkerOutcome[]): WorkerSuccess[] {
  return outcomes.filter((outcome): outcome is WorkerSuccess => outcome.ok);
}

function failed(outcomes: readonly WorkerOutcome[]): WorkerFailure[] {
  return outcomes.filter((outcome): outcome is WorkerFailure => !outcome.ok);
}

test('빈 파일 DB의 최초 schema migration(v1→최신)을 두 Worker가 동시에 안전하게 연다', async (t) => {
  const db = fixture(t);

  const outcomes = await raceWorkers(
    db.databasePath,
    { operation: 'open' },
    { operation: 'open' },
  );

  const successes = successful(outcomes);
  assert.equal(successes.length, 2, JSON.stringify(outcomes));
  assert.equal(failed(outcomes).length, 0, JSON.stringify(outcomes));
  for (const outcome of successes) {
    assert.equal(outcome.execution.replayed, false);
    assert.equal(outcome.execution.response.schemaVersion, SERVER_SCHEMA_VERSION);
    assert.equal(typeof outcome.execution.response.sqliteVersion, 'string');
  }

  const server = await db.open();
  assert.equal(server.schemaVersion, SERVER_SCHEMA_VERSION);
  await db.close(server);
  withRawDatabase(db.databasePath, (database) => {
    const userVersion = database.prepare('PRAGMA user_version').get() as { user_version: number };
    const migrations = database.prepare(`
      SELECT COUNT(*) AS count, MIN(version) AS minimum, MAX(version) AS maximum
      FROM schema_migrations
    `).get() as { count: number; minimum: number; maximum: number };
    assert.equal(userVersion.user_version, SERVER_SCHEMA_VERSION);
    assert.equal(migrations.count, SERVER_SCHEMA_VERSION);
    assert.equal(migrations.minimum, 1);
    assert.equal(migrations.maximum, SERVER_SCHEMA_VERSION);
  });
});

test('두 Worker의 동일 start key 경쟁은 1회 신규 처리와 1회 동일 응답 replay만 만든다', async (t) => {
  const db = fixture(t);
  const setup = await db.open();
  await setup.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  await db.close(setup);
  const command = startCommand({ commandId: 'race:same-key' });

  const outcomes = await raceWorkers(
    db.databasePath,
    { operation: 'start', context: context(), command },
    { operation: 'start', context: context(), command },
  );

  const successes = successful(outcomes);
  assert.equal(successes.length, 2, JSON.stringify(outcomes));
  assert.deepEqual(successes.map((outcome) => outcome.execution.replayed).sort(), [false, true]);
  assert.deepEqual(successes[0]?.execution.response, successes[1]?.execution.response);
  const server = await db.open();
  const city = await server.getCity(CITY);
  assert.equal(city.version, 1);
  assert.equal(city.jobs.length, 1);
  assert.equal(city.ledger.length, 2);
  assert.equal(city.receipts.length, 1);
  assert.equal(city.resourcesMicro.food, 480_000);
  assert.equal(city.resourcesMicro.steel, 450_000);
});

test('두 Worker의 다른 start key·같은 version 경쟁은 정확히 하나만 상태를 변경한다', async (t) => {
  const db = fixture(t);
  const setup = await db.open();
  await setup.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  await db.close(setup);

  const outcomes = await raceWorkers(
    db.databasePath,
    {
      operation: 'start',
      context: context(),
      command: startCommand({ commandId: 'race:farm', buildingId: 'farm' }),
    },
    {
      operation: 'start',
      context: context(),
      command: startCommand({ commandId: 'race:steel', buildingId: 'steel_mill' }),
    },
  );

  const successes = successful(outcomes);
  const failures = failed(outcomes);
  assert.equal(successes.length, 1, JSON.stringify(outcomes));
  assert.equal(failures.length, 1, JSON.stringify(outcomes));
  assert.ok(
    failures[0]?.code === 'STALE_VERSION' || failures[0]?.code === 'DB_BUSY_RETRYABLE',
    JSON.stringify(outcomes),
  );
  if (failures[0]?.code === 'DB_BUSY_RETRYABLE') assert.equal(failures[0].retryable, true);

  const server = await db.open();
  const city = await server.getCity(CITY);
  assert.equal(city.version, 1);
  assert.equal(city.jobs.length, 1);
  assert.equal(city.ledger.length, 2);
  assert.equal(city.receipts.length, 1);
  assert.equal(city.jobs[0]?.buildingId, successes[0]?.execution.response.buildingId);
  const spentFood = 500_000 - city.resourcesMicro.food;
  const spentSteel = 500_000 - city.resourcesMicro.steel;
  assert.deepEqual(
    [spentFood, spentSteel],
    city.jobs[0]?.buildingId === 'farm' ? [20_000, 50_000] : [30_000, 60_000],
  );
});

test('두 Worker의 다른 complete key 경쟁도 건물 effect를 한 번만 적용한다', async (t) => {
  const db = fixture(t);
  const setup = await db.open();
  await setup.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await setup.startConstruction(context(), startCommand());
  await db.close(setup);

  const outcomes = await raceWorkers(
    db.databasePath,
    {
      operation: 'complete',
      context: context(CONSTRUCTION_WORKER_ID, 11),
      command: completeCommand(started.response.jobId, { commandId: 'race:complete:1' }),
    },
    {
      operation: 'complete',
      context: context(CONSTRUCTION_WORKER_ID, 11),
      command: completeCommand(started.response.jobId, { commandId: 'race:complete:2' }),
    },
  );

  const successes = successful(outcomes);
  assert.equal(successes.length, 2, JSON.stringify(outcomes));
  assert.deepEqual(successes.map((outcome) => outcome.execution.replayed).sort(), [false, true]);
  assert.deepEqual(successes[0]?.execution.response, successes[1]?.execution.response);

  const server = await db.open();
  const city = await server.getCity(CITY);
  assert.equal(city.version, 2);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.completionEffectCount, 1);
  assert.equal(city.jobs.length, 1);
  assert.equal(city.jobs[0]?.status, 'completed');
  assert.equal(city.receipts.length, 3);
});

test('두 Worker의 동시 claim 경쟁은 due job을 정확히 한 명에게만 준다', async (t) => {
  const db = fixture(t);
  const setup = await db.open();
  await setup.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await setup.startConstruction(context(), startCommand({ commandId: 'race:claim:start' }));
  await db.close(setup);
  const dueHour = started.response.completesAtHour;

  const outcomes = await raceWorkers(
    db.databasePath,
    { operation: 'claim', context: context('worker:alpha', dueHour), command: { limit: 10 } },
    { operation: 'claim', context: context('worker:beta', dueHour), command: { limit: 10 } },
  );

  const successes = successful(outcomes);
  assert.equal(successes.length, 2, JSON.stringify(outcomes));
  const claimedCounts = successes
    .map((outcome) => (outcome.execution.response.claimed as unknown[]).length)
    .sort();
  assert.deepEqual(claimedCounts, [0, 1]);
  for (const outcome of successes) {
    assert.deepEqual(outcome.execution.response.deadLettered, []);
  }

  const server = await db.open();
  const claims = await server.listJobClaims(CITY);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.jobId, started.response.jobId);
  assert.equal(claims[0]?.state, 'leased');
  assert.equal(claims[0]?.attemptCount, 1);
  assert.ok(['worker:alpha', 'worker:beta'].includes(claims[0]!.workerId));
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  ConstructionServer,
  ConstructionWorkerDaemon,
  ServerError,
} from '../src/index.js';
import type {
  ConstructionServerOptions,
  StartConstructionCommand,
  WorkerTickReport,
} from '../src/index.js';

const OWNER = 'user:alpha';
const CITY = 'city:alpha';
const WORKER = 'worker:daemon-a';
const READY_BUILDINGS = { hq: 2 } as const;

interface Fixture {
  readonly databasePath: string;
  open(options?: ConstructionServerOptions): Promise<ConstructionServer>;
  close(server: ConstructionServer): Promise<void>;
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-worker-daemon-'));
  const databasePath = join(directory, 'daemon.sqlite');
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

async function seedDueJob(server: ConstructionServer): Promise<{ jobId: string; dueHour: number }> {
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: READY_BUILDINGS });
  const started = await server.startConstruction({ actorId: OWNER, nowHour: 10 }, startCommand());
  return { jobId: started.response.jobId, dueHour: started.response.completesAtHour };
}

function daemonWith(
  server: ConstructionServer,
  hourRef: { value: number },
  overrides: Partial<Parameters<typeof buildOptions>[2]> = {},
): ConstructionWorkerDaemon {
  return new ConstructionWorkerDaemon(buildOptions(server, hourRef, overrides));
}

function buildOptions(
  server: ConstructionServer,
  hourRef: { value: number },
  overrides: Record<string, unknown>,
) {
  return {
    server,
    workerId: WORKER,
    clock: () => hourRef.value,
    ...overrides,
  } as ConstructorParameters<typeof ConstructionWorkerDaemon>[0];
}

async function expectCode(operation: () => unknown, code: ServerError['code']): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServerError, `expected ServerError ${code}`);
  assert.equal(caught.code, code);
}

test('runOnce는 due job을 claim하고 완료하며 claim을 남기지 않는다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const { jobId, dueHour } = await seedDueJob(server);
  const hour = { value: dueHour - 1 };
  const daemon = daemonWith(server, hour);

  const early = await daemon.runOnce();
  assert.deepEqual(early, {
    workerId: WORKER,
    nowHour: dueHour - 1,
    claimed: 0,
    deadLetteredOnScan: [],
    jobs: [],
    recoveriesCompleted: [],
    citiesProduced: [],
  });

  hour.value = dueHour;
  const tick = await daemon.runOnce();
  assert.equal(tick.claimed, 1);
  assert.deepEqual(tick.jobs, [{
    jobId,
    attempt: 1,
    outcome: 'completed',
    replayed: false,
  }]);

  const city = await server.getCity(CITY);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.completionEffectCount, 1);
  assert.deepEqual(await server.listJobClaims(), []);

  const idle = await daemon.runOnce();
  assert.equal(idle.claimed, 0);
});

test('처리 실패는 백오프로 보고되고 다음 자격 시각에 재claim되어 정확히 한 번 완료된다', async (t) => {
  const db = fixture(t);
  let faultArmed = true;
  const server = await db.open({
    faultInjector: (point) => {
      if (faultArmed && point === 'complete:after_building') {
        throw new Error('injected completion fault');
      }
    },
  });
  const { jobId, dueHour } = await seedDueJob(server);
  const hour = { value: dueHour };
  const daemon = daemonWith(server, hour);

  const failedTick = await daemon.runOnce();
  assert.equal(failedTick.claimed, 1);
  assert.equal(failedTick.jobs[0]?.outcome, 'retry_scheduled');
  assert.equal(failedTick.jobs[0]?.attempt, 1);
  assert.equal(failedTick.jobs[0]?.nextEligibleHour, dueHour + 1);
  assert.match(failedTick.jobs[0]?.error ?? '', /DATABASE_FAILURE/);
  assert.match((await server.listJobClaims())[0]?.lastError ?? '', /DATABASE_FAILURE/);

  // 백오프 중에는 재claim되지 않는다.
  const backoffTick = await daemon.runOnce();
  assert.equal(backoffTick.claimed, 0);

  faultArmed = false;
  hour.value = dueHour + 1;
  const recoveredTick = await daemon.runOnce();
  assert.deepEqual(recoveredTick.jobs, [{
    jobId,
    attempt: 2,
    outcome: 'completed',
    replayed: false,
  }]);

  const city = await server.getCity(CITY);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.completionEffectCount, 1, '재시도에도 완료 효과는 한 번이어야 한다.');
  assert.deepEqual(await server.listJobClaims(), []);
});

test('영구 실패는 dead letter로 보고되고 이후 tick에서 제외된다', async (t) => {
  const db = fixture(t);
  const server = await db.open({
    jobPolicy: { maxAttempts: 1 },
    faultInjector: (point) => {
      if (point === 'complete:after_building') {
        throw new Error('permanent failure');
      }
    },
  });
  const { jobId, dueHour } = await seedDueJob(server);
  const hour = { value: dueHour };
  const daemon = daemonWith(server, hour);

  const tick = await daemon.runOnce();
  assert.equal(tick.jobs[0]?.outcome, 'dead');
  assert.equal(tick.jobs[0]?.attempt, 1);
  assert.equal(tick.jobs[0]?.nextEligibleHour, null);

  const snapshot = (await server.listJobClaims())[0];
  assert.equal(snapshot?.jobId, jobId);
  assert.equal(snapshot?.state, 'dead');

  hour.value = dueHour + 100;
  const later = await daemon.runOnce();
  assert.equal(later.claimed, 0);
  assert.deepEqual(later.deadLetteredOnScan, []);
  assert.equal((await server.getCity(CITY)).buildings.farm, 1, 'dead job은 완료되면 안 된다.');
});

test('retryable 오류는 같은 tick 안에서 재시도해 성공한다', async (t) => {
  const db = fixture(t);
  let busyRemaining = 2;
  const server = await db.open({
    faultInjector: (point) => {
      if (point === 'complete:after_building' && busyRemaining > 0) {
        busyRemaining -= 1;
        throw new ServerError('DB_BUSY_RETRYABLE', '주입된 일시 잠금', { retryable: true });
      }
    },
  });
  const { jobId, dueHour } = await seedDueJob(server);
  const hour = { value: dueHour };
  const daemon = daemonWith(server, hour, { busyRetries: 2 });

  const tick = await daemon.runOnce();
  assert.deepEqual(tick.jobs, [{
    jobId,
    attempt: 1,
    outcome: 'completed',
    replayed: false,
  }]);
  assert.equal(busyRemaining, 0, 'busy 주입이 두 번 소비되어야 한다.');
  assert.equal((await server.getCity(CITY)).completionEffectCount, 1);
});

test('busyRetries를 초과하는 retryable 오류는 실패로 보고된다', async (t) => {
  const db = fixture(t);
  const server = await db.open({
    faultInjector: (point) => {
      if (point === 'complete:after_building') {
        throw new ServerError('DB_BUSY_RETRYABLE', '항상 잠김', { retryable: true });
      }
    },
  });
  const { dueHour } = await seedDueJob(server);
  const hour = { value: dueHour };
  const daemon = daemonWith(server, hour, { busyRetries: 1 });

  const tick = await daemon.runOnce();
  assert.equal(tick.jobs[0]?.outcome, 'retry_scheduled');
  assert.match(tick.jobs[0]?.error ?? '', /DB_BUSY_RETRYABLE/);
});

test('run 루프는 주입 sleep으로 tick을 반복하고 stop은 tick 경계에서 멈춘다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await seedDueJob(server);
  const hour = { value: 10 };
  let sleeps = 0;
  const reports: WorkerTickReport[] = [];
  const daemon = daemonWith(server, hour, {
    pollIntervalMs: 5,
    sleep: async () => {
      sleeps += 1;
    },
    onTick: (report: WorkerTickReport) => {
      reports.push(report);
      if (reports.length === 3) daemon.stop();
    },
  });

  await daemon.run();
  assert.equal(reports.length, 3, 'stop 이후 추가 tick이 없어야 한다.');
  assert.equal(sleeps, 2, '마지막 tick 뒤에는 sleep하지 않아야 한다.');
  assert.equal(daemon.isRunning, false);

  // 실행 중 중복 run은 거부되고, stop은 sleep 중인 루프를 즉시 깨워 종료한다.
  const parked = daemonWith(server, hour, {
    pollIntervalMs: 3_600_000,
    sleep: () => new Promise<void>(() => {}),
  });
  const running = parked.run();
  assert.equal(parked.isRunning, true);
  await assert.rejects(
    parked.run(),
    (error: unknown) => error instanceof ServerError && error.code === 'INVALID_INPUT',
  );
  parked.stop();
  await running;
  assert.equal(parked.isRunning, false);
});

test('생성자·시계 검증: worker 접두, 옵션 범위, 비정수 시각을 거부한다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  const hour = { value: 10 };

  await expectCode(async () => daemonWith(server, hour, { workerId: OWNER }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { workerId: 'worker:' }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { batchSize: 0 }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { batchSize: 101 }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { pollIntervalMs: 0 }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { busyRetries: 11 }), 'INVALID_INPUT');
  await expectCode(async () => daemonWith(server, hour, { leaseHours: 0 }), 'INVALID_INPUT');
  await expectCode(
    async () => new ConstructionWorkerDaemon({ server, workerId: WORKER, clock: 5 as never }),
    'INVALID_INPUT',
  );

  const badClock = daemonWith(server, hour, { clock: () => 1.5 } as never);
  await expectCode(async () => await badClock.runOnce(), 'INVALID_INPUT');
  const negativeClock = daemonWith(server, hour, { clock: () => -1 } as never);
  await expectCode(async () => await negativeClock.runOnce(), 'INVALID_INPUT');
});

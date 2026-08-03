import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEpochHourClock, REAL_HOUR_MS } from '../src/clock.js';
import { ConstructionServer, ServerError } from '../src/index.js';

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

test('시계 어댑터: epoch 기준 hour 변환, 압축 시계, 상한·기점 이전 거부', async () => {
  let nowMs = 1_000_000;
  const clock = createEpochHourClock({ epochMs: 1_000_000, hourDurationMs: 100, now: () => nowMs });

  assert.equal(clock(), 0);
  nowMs = 1_000_099;
  assert.equal(clock(), 0, '한 시간이 지나기 전에는 같은 hour여야 한다.');
  nowMs = 1_000_100;
  assert.equal(clock(), 1);
  nowMs = 1_000_100 + 41 * 100;
  assert.equal(clock(), 42);

  const preEpoch = createEpochHourClock({ epochMs: 5_000, hourDurationMs: 100, now: () => 4_999 });
  await expectCode(async () => preEpoch(), 'TIME_REVERSED');

  await expectCode(async () => createEpochHourClock({ epochMs: -1 }), 'INVALID_INPUT');
  await expectCode(async () => createEpochHourClock({ epochMs: 0, hourDurationMs: 5 }), 'INVALID_INPUT');
  await expectCode(
    async () => createEpochHourClock({ epochMs: 0, hourDurationMs: REAL_HOUR_MS + 1 }),
    'INVALID_INPUT',
  );

  const overflow = createEpochHourClock({ epochMs: 0, hourDurationMs: 10, now: () => 20_000_001 * 10 });
  await expectCode(async () => overflow(), 'INVALID_INPUT');
});

test('시계 어댑터: 벽시계가 뒤로 가도 권위 hour는 단조를 유지한다', async () => {
  let nowMs = 10_000;
  const clock = createEpochHourClock({ epochMs: 0, hourDurationMs: 100, now: () => nowMs });
  assert.equal(clock(), 100);
  nowMs = 9_000; // NTP 보정 등으로 벽시계 역행
  assert.equal(clock(), 100, '역행 시 마지막 권위 hour를 유지해야 한다.');
  nowMs = 10_150;
  assert.equal(clock(), 101, '벽시계가 따라잡으면 다시 전진한다.');
});

test('worker-main 프로세스: 유한 tick 실행으로 due job을 완료하고 정상 종료한다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-worker-main-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const databasePath = join(directory, 'world.sqlite');

  // seed: hour 10에 시작한 farm 건설(완료 hour 11)
  const seedServer = await ConstructionServer.open(databasePath);
  await seedServer.seedCity({ cityId: 'city:main', ownerId: 'user:main', buildings: { hq: 2 } });
  const started = await seedServer.startConstruction(
    { actorId: 'user:main', nowHour: 10 },
    { commandId: 'start:farm', cityId: 'city:main', expectedVersion: 0, buildingId: 'farm' },
  );
  await seedServer.close();

  // 압축 시계: hour 50ms. epoch를 지금-12hour로 잡아 현재 권위 hour ≈ 12 (> 완료 11).
  const hourMs = 50;
  const epochMs = Date.now() - 12 * hourMs;
  const tsxCli = fileURLToPath(new URL('../../engine/node_modules/tsx/dist/cli.mjs', import.meta.url));
  const entry = fileURLToPath(new URL('../src/cli/worker-main.ts', import.meta.url));

  const child = spawn(process.execPath, [
    tsxCli, entry,
    '--db', databasePath,
    '--worker', 'worker:main-smoke',
    '--epoch-ms', String(epochMs),
    '--hour-ms', String(hourMs),
    '--poll-ms', '20',
    '--ticks', '3',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`worker-main이 시간 안에 끝나지 않았다.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.equal(exitCode, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
  const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.kind, 'start');
  const tickLines = lines.filter((line) => line.kind === 'tick');
  assert.equal(tickLines.length, 3, '요청한 tick 수만큼만 실행해야 한다.');
  assert.equal(lines[lines.length - 1]?.kind, 'stopped');

  const verify = await ConstructionServer.open(databasePath);
  try {
    const city = await verify.getCity('city:main');
    assert.equal(city.buildings.farm, 2, '프로세스 실행으로 due job이 완료되어야 한다.');
    assert.equal(city.completionEffectCount, 1);
    assert.deepEqual(await verify.listJobClaims(), []);
    const completedJob = city.jobs.find((job) => job.id === started.response.jobId);
    assert.equal(completedJob?.status, 'completed');
  } finally {
    await verify.close();
  }
});

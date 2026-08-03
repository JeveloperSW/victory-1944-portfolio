/**
 * 단일 호스트 부하 스모크 — 200명 월드 가정의 HTTP 쓰기 경로와 워커 드레인 측정.
 * 증거 범위: 이 호스트의 SQLite 파일 DB + node:http 한정. 다중 호스트·PostgreSQL·실네트워크 아님.
 * 실행: npm run load:smoke [-- --cities 200 --concurrency 32]
 */
import { strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ConstructionServer } from '../construction-server.js';
import { startHttpApi } from '../http-api.js';
import { ConstructionWorkerDaemon } from '../worker-daemon.js';

function removeTemporaryDirectory(directory: string): void {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const childPath = relative(root, target);
  if (childPath.length === 0 || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error(`임시 디렉터리가 tmpdir 밖에 있어 정리를 거부했다: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return sortedValues[index]!;
}

async function runPool<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cities: { type: 'string' },
      concurrency: { type: 'string' },
    },
    strict: true,
  });
  const cityCount = values.cities === undefined ? 200 : Number(values.cities);
  const concurrency = values.concurrency === undefined ? 32 : Number(values.concurrency);
  if (!Number.isSafeInteger(cityCount) || cityCount < 1 || cityCount > 2_000) {
    throw new Error('--cities는 1..2000 정수여야 한다.');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error('--concurrency는 1..256 정수여야 한다.');
  }

  const directory = mkdtempSync(join(resolve(tmpdir()), 'victory1944-load-'));
  const databasePath = join(directory, 'load.sqlite');
  let server: ConstructionServer | undefined;
  let api: Awaited<ReturnType<typeof startHttpApi>> | undefined;

  try {
    server = await ConstructionServer.open(databasePath);
    const clockRef = { hour: 10 };
    api = await startHttpApi({ server, clock: () => clockRef.hour });

    console.log('=== Victory 1944 단일 호스트 부하 스모크 ===');
    console.log(`런타임: Node ${process.versions.node}, SQLite ${await server.sqliteVersion()}, schema v${server.schemaVersion}`);
    console.log(`대상: 도시 ${cityCount}개, HTTP 동시성 ${concurrency}, 경로 POST /v1/cities/{id}/constructions`);

    // 1) seed: 도시·플레이어 토큰
    const seedStart = performance.now();
    const adminContext = { actorId: 'admin:load', nowHour: 10 } as const;
    const tokens: string[] = [];
    for (let index = 0; index < cityCount; index += 1) {
      const cityId = `city:load-${index}`;
      const ownerId = `user:load-${index}`;
      await server.seedCity({ cityId, ownerId, buildings: { hq: 2 } });
      tokens.push((await server.issueToken(adminContext, { actorId: ownerId, role: 'player', reason: 'load' })).token);
    }
    const seedMs = performance.now() - seedStart;
    console.log(`seed: 도시·토큰 ${cityCount}건, ${seedMs.toFixed(0)}ms`);

    // 2) HTTP 쓰기 파도: 도시당 건설 시작 1건
    const baseUrl = `http://127.0.0.1:${api.port}`;
    const latencies: number[] = [];
    const waveStart = performance.now();
    const statuses = await runPool(
      Array.from({ length: cityCount }, (_, index) => async () => {
        const requestStart = performance.now();
        const response = await fetch(`${baseUrl}/v1/cities/city:load-${index}/constructions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens[index]}`, 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: `load:start:${index}`, expectedVersion: 0, buildingId: 'farm' }),
        });
        await response.arrayBuffer();
        latencies.push(performance.now() - requestStart);
        return response.status;
      }),
      concurrency,
    );
    const waveMs = performance.now() - waveStart;
    const failures = statuses.filter((status) => status !== 201);
    strictEqual(failures.length, 0, `실패 응답 ${failures.length}건: ${failures.slice(0, 5).join(',')}`);
    latencies.sort((a, b) => a - b);
    console.log(
      `HTTP 쓰기: ${cityCount}건 성공(201), ${waveMs.toFixed(0)}ms, `
      + `${(cityCount / (waveMs / 1000)).toFixed(1)} req/s, `
      + `지연 p50=${percentile(latencies, 0.5).toFixed(1)}ms `
      + `p95=${percentile(latencies, 0.95).toFixed(1)}ms `
      + `max=${latencies[latencies.length - 1]!.toFixed(1)}ms`,
    );

    // 3) 워커 드레인: 완료 예정 hour로 진행 후 daemon이 전부 완료
    clockRef.hour = 11;
    const daemon = new ConstructionWorkerDaemon({
      server,
      workerId: 'worker:load-1',
      clock: () => clockRef.hour,
      batchSize: 100,
    });
    const drainStart = performance.now();
    let completed = 0;
    while (true) {
      const tick = await daemon.runOnce();
      completed += tick.jobs.filter((job) => job.outcome === 'completed').length;
      if (tick.claimed === 0) break;
    }
    const drainMs = performance.now() - drainStart;
    strictEqual(completed, cityCount, '모든 건설이 완료되어야 한다.');
    console.log(
      `워커 드레인: ${completed}건 완료, ${drainMs.toFixed(0)}ms, `
      + `${(completed / (drainMs / 1000)).toFixed(1)} job/s`,
    );

    // 4) 정합성: 표본 검사 + 전수 카운트
    for (const index of [0, Math.floor(cityCount / 2), cityCount - 1]) {
      const city = await server.getCity(`city:load-${index}`);
      strictEqual(city.buildings.farm, 2);
      strictEqual(city.completionEffectCount, 1);
      strictEqual(city.jobs.length, 1);
      strictEqual(city.jobs[0]?.status, 'completed');
    }
    strictEqual((await server.listJobClaims()).length, 0, '드레인 후 잔여 claim이 없어야 한다.');
    const databaseBytes = statSync(databasePath).size;
    console.log(`정합성: 표본 도시 3곳 farm=2·effect=1, 잔여 claim 0, DB 파일 ${(databaseBytes / 1024).toFixed(0)}KiB`);
    console.log(
      '증거 범위: 단일 호스트 SQLite(WAL)+node:http 루프백 한정. '
      + '다중 호스트, PostgreSQL, 실네트워크 지연, 지속 부하는 검증하지 않았다.',
    );
  } finally {
    try {
      await api?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        removeTemporaryDirectory(directory);
      }
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`부하 스모크 실패: ${message}`);
  process.exitCode = 1;
});

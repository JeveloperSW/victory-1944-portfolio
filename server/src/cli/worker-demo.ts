import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ConstructionServer,
  ConstructionWorkerDaemon,
} from '../index.js';
import type { WorkerTickReport } from '../index.js';

const CITY_ID = 'city:daemon-demo';
const OWNER_ID = 'player:daemon-demo';

function removeTemporaryDirectory(directory: string): void {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const childPath = relative(root, target);
  if (childPath.length === 0
    || childPath === '..'
    || childPath.startsWith(`..${sep}`)
    || isAbsolute(childPath)) {
    throw new Error(`임시 디렉터리가 tmpdir 밖에 있어 정리를 거부했다: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function tickLine(report: WorkerTickReport): string {
  const jobs = report.jobs.map((job) => {
    const suffix = job.outcome === 'retry_scheduled'
      ? `→hour=${job.nextEligibleHour}`
      : job.outcome === 'completed'
        ? (job.replayed ? '(replay)' : '')
        : '';
    return `${job.jobId.slice(0, 12)}… attempt=${job.attempt} ${job.outcome}${suffix}`;
  }).join(' | ');
  return `  tick hour=${report.nowHour} claimed=${report.claimed}`
    + `${report.deadLetteredOnScan.length > 0 ? ` deadOnScan=${report.deadLetteredOnScan.length}` : ''}`
    + `${jobs.length > 0 ? ` :: ${jobs}` : ''}`;
}

async function runDemo(): Promise<void> {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'victory1944-worker-demo-'));
  let server: ConstructionServer | undefined;

  try {
    console.log('=== Victory 1944 건설 워커 데몬 PoC ===');
    console.log(`런타임: Node ${process.versions.node}`);

    // 1단계: 2건 동시 처리 — 1건은 일시 실패 후 백오프 재시도로 복구
    let faultArmed = true;
    server = await ConstructionServer.open(join(directory, 'phase1.sqlite'), {
      faultInjector: (point) => {
        if (faultArmed && point === 'complete:after_building') {
          faultArmed = false;
          throw new Error('데모: 첫 완료 시도에 주입된 일시 장애');
        }
      },
    });
    await server.seedCity({ cityId: CITY_ID, ownerId: OWNER_ID, buildings: { hq: 2 } });
    const farm = await server.startConstruction(
      { actorId: OWNER_ID, nowHour: 10 },
      { commandId: 'cmd:start:farm', cityId: CITY_ID, expectedVersion: 0, buildingId: 'farm' },
    );
    const mill = await server.startConstruction(
      { actorId: OWNER_ID, nowHour: 10 },
      { commandId: 'cmd:start:mill', cityId: CITY_ID, expectedVersion: 1, buildingId: 'steel_mill' },
    );
    const dueHour = Math.max(farm.response.completesAtHour, mill.response.completesAtHour);
    console.log(`도시 준비: farm·steel_mill 건설 시작, 완료 예정 hour=${dueHour}`);

    const hour = { value: dueHour };
    const daemon = new ConstructionWorkerDaemon({
      server,
      workerId: 'worker:demo-1',
      clock: () => hour.value,
      batchSize: 10,
    });

    const tick1 = await daemon.runOnce();
    console.log(tickLine(tick1));
    strictEqual(tick1.claimed, 2, '두 due job이 한 tick에 claim되어야 한다.');
    const outcomes1 = tick1.jobs.map((job) => job.outcome).sort();
    deepStrictEqual(outcomes1, ['completed', 'retry_scheduled'], '1건 완료·1건 백오프여야 한다.');

    const backoffTick = await daemon.runOnce();
    console.log(tickLine(backoffTick));
    strictEqual(backoffTick.claimed, 0, '백오프 중에는 재claim이 없어야 한다.');

    hour.value = dueHour + 1;
    const tick2 = await daemon.runOnce();
    console.log(tickLine(tick2));
    strictEqual(tick2.jobs[0]?.outcome, 'completed', '백오프 후 재시도가 완료되어야 한다.');
    strictEqual(tick2.jobs[0]?.attempt, 2);

    const city = await server.getCity(CITY_ID);
    strictEqual(city.buildings.farm, 2);
    strictEqual(city.buildings.steel_mill, 2);
    strictEqual(city.completionEffectCount, 2, '완료 효과는 job당 정확히 하나여야 한다.');
    deepStrictEqual(await server.listJobClaims(), [], '완료가 claim을 모두 제거해야 한다.');
    console.log(`1단계 결과: farm=2, steel_mill=2, effect=2, 잔여 claim=0`);
    await server.close();
    server = undefined;

    // 2단계: 영구 실패 → dead letter 격리
    server = await ConstructionServer.open(join(directory, 'phase2.sqlite'), {
      jobPolicy: { maxAttempts: 2 },
      faultInjector: (point) => {
        if (point === 'complete:after_building') {
          throw new Error('데모: 항상 실패하는 완료 처리');
        }
      },
    });
    await server.seedCity({ cityId: CITY_ID, ownerId: OWNER_ID, buildings: { hq: 2 } });
    const doomed = await server.startConstruction(
      { actorId: OWNER_ID, nowHour: 10 },
      { commandId: 'cmd:start:doomed', cityId: CITY_ID, expectedVersion: 0, buildingId: 'farm' },
    );
    const hour2 = { value: doomed.response.completesAtHour };
    const daemon2 = new ConstructionWorkerDaemon({
      server,
      workerId: 'worker:demo-2',
      clock: () => hour2.value,
    });

    const firstFail = await daemon2.runOnce();
    console.log(tickLine(firstFail));
    strictEqual(firstFail.jobs[0]?.outcome, 'retry_scheduled');

    hour2.value += 1;
    const finalFail = await daemon2.runOnce();
    console.log(tickLine(finalFail));
    strictEqual(finalFail.jobs[0]?.outcome, 'dead', '최대 시도 소진은 dead여야 한다.');

    hour2.value += 100;
    const idle = await daemon2.runOnce();
    strictEqual(idle.claimed, 0, 'dead job은 더 이상 claim되지 않아야 한다.');
    const deadClaim = (await server.listJobClaims())[0];
    strictEqual(deadClaim?.state, 'dead');
    console.log(
      `2단계 결과: dead letter 격리 — job=${deadClaim?.jobId.slice(0, 12)}…, `
      + `attempts=${deadClaim?.attemptCount}, lastError="${deadClaim?.lastError}"`,
    );

    console.log('검증 결과: 데몬 tick 처리→일시 장애 백오프 복구→영구 실패 dead letter 격리 통과');
    console.log(
      '범위 제한: 데몬은 디스패치 API의 소비자이며 권위가 아니다. '
      + '시계는 주입식(정수 hour)이고 OS 프로세스·서비스 등록, 실시간 벽시계, '
      + 'dead letter 재가동 도구, HTTP·인증, 다중 호스트는 검증하지 않았다.',
    );
  } finally {
    try {
      await server?.close();
    } finally {
      removeTemporaryDirectory(directory);
    }
  }
}

runDemo().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`워커 데몬 PoC 검증 실패: ${message}`);
  process.exitCode = 1;
});

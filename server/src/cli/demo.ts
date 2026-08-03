import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CONSTRUCTION_WORKER_ID,
  ConstructionServer,
  ServerError,
} from '../index.js';
import type { CitySnapshot } from '../index.js';

const MICRO_SCALE = 1_000;
const CITY_ID = 'city:demo';
const OWNER_ID = 'player:demo';

function rowCounts(city: CitySnapshot): string {
  return [
    `job=${city.jobs.length}`,
    `ledger=${city.ledger.length}`,
    `effect=${city.completionEffectCount}`,
    `receipt=${city.receipts.length}`,
  ].join(', ');
}

async function assertTooEarly(operation: () => unknown): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ServerError && error.code === 'TOO_EARLY') return;
    throw error;
  }
  throw new Error('완료 경계 직전 명령이 TOO_EARLY로 거부되지 않았다.');
}

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

async function runDemo(): Promise<void> {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'victory1944-server-demo-'));
  const databasePath = join(directory, 'construction.sqlite');
  let server: ConstructionServer | undefined;

  try {
    server = await ConstructionServer.open(databasePath);
    const initial = await server.seedCity({ cityId: CITY_ID, ownerId: OWNER_ID });

    console.log('=== Victory 1944 서버 권위 건설 PoC ===');
    console.log(`런타임: Node ${process.versions.node}`);
    console.log(`저장소: SQLite ${await server.sqliteVersion()} / schema v${server.schemaVersion}`);
    console.log('단위: 자원 비용·잔액·원장은 정수 micro (1 자원 = 1,000 micro)');
    console.log(`도시 생성: ${initial.id}, version=${initial.version}, ${rowCounts(initial)}`);

    const startContext = { actorId: OWNER_ID, nowHour: 10 } as const;
    const startCommand = {
      commandId: 'cmd:start:hq:2',
      cityId: CITY_ID,
      expectedVersion: initial.version,
      buildingId: 'hq',
    } as const;
    const firstStart = await server.startConstruction(startContext, startCommand);
    strictEqual(firstStart.replayed, false, '최초 건설 명령은 신규 적용이어야 한다.');
    const afterFirstStart = await server.getCity(CITY_ID);

    const costMicro: Record<string, number> = {};
    for (const [resourceId, amount] of Object.entries(firstStart.response.cost)) {
      if (amount === undefined) continue;
      const micro = Math.round(amount * MICRO_SCALE);
      strictEqual(Number.isSafeInteger(micro), true, `${resourceId} 비용은 안전한 micro 정수여야 한다.`);
      if (micro > 0) costMicro[resourceId] = micro;
    }
    strictEqual(
      afterFirstStart.ledger.length,
      Object.keys(costMicro).length,
      '비용이 있는 자원마다 원장 행이 정확히 하나여야 한다.',
    );
    for (const row of afterFirstStart.ledger) {
      const expectedCost = costMicro[row.resourceId];
      if (expectedCost === undefined) {
        throw new Error(`원장에 예상하지 않은 자원이 기록됐다: ${row.resourceId}`);
      }
      strictEqual(row.deltaMicro, -expectedCost, `${row.resourceId} 원장 차감액이 비용과 달라서는 안 된다.`);
      strictEqual(
        row.balanceAfterMicro,
        row.balanceBeforeMicro + row.deltaMicro,
        `${row.resourceId} 원장 전후 잔액이 보존되어야 한다.`,
      );
    }
    console.log(
      `HQ 건설 시작: costMicro=${JSON.stringify(costMicro)}, `
      + `version=${afterFirstStart.version}, completesAtHour=${firstStart.response.completesAtHour}`,
    );
    console.log(
      `원장(micro): ${afterFirstStart.ledger.map((row) => (
        `${row.resourceId}:${row.balanceBeforeMicro}${row.deltaMicro}->${row.balanceAfterMicro}`
      )).join(', ')}`,
    );

    const replayedStart = await server.startConstruction(startContext, startCommand);
    strictEqual(replayedStart.replayed, true, '동일 건설 명령 재시도는 receipt 재생이어야 한다.');
    deepStrictEqual(replayedStart.response, firstStart.response, '재시도 응답은 저장 응답과 같아야 한다.');
    const afterStartReplay = await server.getCity(CITY_ID);
    deepStrictEqual(
      afterStartReplay,
      afterFirstStart,
      '동일 건설 명령 재시도는 행·잔액·version을 바꾸면 안 된다.',
    );
    console.log(
      `동일 시작 command 재시도: replayed=${replayedStart.replayed}, `
      + `행·잔액 불변, version=${afterStartReplay.version}, ${rowCounts(afterStartReplay)}`,
    );

    await server.close();
    server = undefined;
    server = await ConstructionServer.open(databasePath);
    const afterReopen = await server.getCity(CITY_ID);
    deepStrictEqual(afterReopen, afterFirstStart, 'DB 재개방 뒤 상태가 보존되어야 한다.');
    console.log(`DB close/reopen: pending job과 micro 잔액 보존, ${rowCounts(afterReopen)}`);

    const completesAtHour = firstStart.response.completesAtHour;
    const completeCommand = {
      commandId: 'cmd:complete:hq:2',
      jobId: firstStart.response.jobId,
    } as const;
    await assertTooEarly(async () => await server!.completeConstruction(
      { actorId: CONSTRUCTION_WORKER_ID, nowHour: completesAtHour - 1 },
      completeCommand,
    ));
    deepStrictEqual(
      await server.getCity(CITY_ID),
      afterReopen,
      '완료 경계 직전 거부는 상태를 바꾸면 안 된다.',
    );

    // claim/lease 디스패치: 경계 전 0건 → attempt 1 → lease 중 차단 → 실패 백오프 → 재claim
    const workerA = 'worker:demo-a';
    const workerB = 'worker:demo-b';
    const earlyClaim = await server.claimDueConstructionJobs(
      { actorId: workerA, nowHour: completesAtHour - 1 },
      { limit: 10 },
    );
    strictEqual(earlyClaim.claimed.length, 0, '완료 경계 전에는 claim 대상이 없어야 한다.');
    const firstClaim = await server.claimDueConstructionJobs(
      { actorId: workerA, nowHour: completesAtHour },
      { limit: 10 },
    );
    strictEqual(firstClaim.claimed.length, 1, '완료 경계에서 due job이 claim되어야 한다.');
    strictEqual(firstClaim.claimed[0]?.attempt, 1);
    const blockedClaim = await server.claimDueConstructionJobs(
      { actorId: workerB, nowHour: completesAtHour },
      { limit: 10 },
    );
    strictEqual(blockedClaim.claimed.length, 0, 'lease 보유 중에는 다른 워커가 가져갈 수 없다.');
    const failReport = await server.failClaimedConstructionJob(
      { actorId: workerA, nowHour: completesAtHour },
      { jobId: firstStart.response.jobId, error: '데모: 일시 처리 실패' },
    );
    strictEqual(failReport.state, 'retry_scheduled', '남은 시도가 있으면 백오프 재시도여야 한다.');
    const reclaimHour = failReport.nextEligibleHour;
    if (reclaimHour === null) throw new Error('retry_scheduled에는 다음 재시도 시각이 있어야 한다.');
    const reclaim = await server.claimDueConstructionJobs(
      { actorId: workerB, nowHour: reclaimHour },
      { limit: 10 },
    );
    strictEqual(reclaim.claimed[0]?.attempt, 2, '백오프 이후 재claim은 시도 2여야 한다.');
    console.log(
      `claim/lease: 경계 전 0건, hour=${completesAtHour} attempt=1(${workerA}), lease 중 차단, `
      + `실패 백오프 → hour=${reclaimHour} attempt=2(${workerB})`,
    );

    const completed = await server.completeConstruction(
      { actorId: CONSTRUCTION_WORKER_ID, nowHour: reclaimHour },
      completeCommand,
    );
    strictEqual(completed.replayed, false, '완료 경계의 최초 처리는 신규 효과여야 한다.');
    strictEqual(completed.response.effectiveAtHour, completesAtHour);
    const afterCompletion = await server.getCity(CITY_ID);
    strictEqual(afterCompletion.buildings.hq, 2, '완료 경계에서 HQ 레벨이 2가 되어야 한다.');
    strictEqual(afterCompletion.jobs[0]?.status, 'completed');
    strictEqual(afterCompletion.completionEffectCount, 1, '완료 효과는 정확히 하나여야 한다.');
    deepStrictEqual(await server.listJobClaims(), [], '완료가 같은 트랜잭션에서 claim을 제거해야 한다.');
    console.log(
      `완료 경계: hour=${completesAtHour - 1} TOO_EARLY, `
      + `hour=${reclaimHour} 처리(effective=${completesAtHour}), HQ=2, claim 제거, `
      + `version=${afterCompletion.version}, ${rowCounts(afterCompletion)}`,
    );

    const effectReplay = await server.completeConstruction(
      { actorId: CONSTRUCTION_WORKER_ID, nowHour: reclaimHour },
      { commandId: 'cmd:complete:hq:2:retry', jobId: firstStart.response.jobId },
    );
    strictEqual(effectReplay.replayed, true, '다른 완료 command는 저장된 job effect를 재생해야 한다.');
    deepStrictEqual(effectReplay.response, completed.response, 'effect 재생 응답은 최초 완료 응답과 같아야 한다.');
    const afterEffectReplay = await server.getCity(CITY_ID);
    strictEqual(afterEffectReplay.version, afterCompletion.version, 'effect 재생은 도시 version을 올리면 안 된다.');
    deepStrictEqual(afterEffectReplay.resourcesMicro, afterCompletion.resourcesMicro);
    deepStrictEqual(afterEffectReplay.buildings, afterCompletion.buildings);
    deepStrictEqual(afterEffectReplay.jobs, afterCompletion.jobs);
    deepStrictEqual(afterEffectReplay.ledger, afterCompletion.ledger);
    strictEqual(afterEffectReplay.completionEffectCount, 1, 'effect 재생은 완료 효과를 중복 생성하면 안 된다.');
    strictEqual(
      afterEffectReplay.receipts.length,
      afterCompletion.receipts.length + 1,
      '다른 완료 command의 receipt만 하나 추가되어야 한다.',
    );
    console.log(
      `다른 완료 command 재실행: replayed=${effectReplay.replayed}, `
      + `version=${afterEffectReplay.version}, 효과 중복 없음, ${rowCounts(afterEffectReplay)}`,
    );
    console.log('검증 결과: 도시 생성→시작 멱등성→재개방→claim/lease·백오프 재시도→완료 경계→effect 재생 통과');
    console.log(
      '범위 제한: node:sqlite는 Node.js의 실험적 API다. '
      + '경쟁은 자동 테스트의 별도 Worker Thread·DB 연결까지만 검증했다. '
      + 'lease·백오프는 PoC 시간 모델(정수 hour) 단위다. '
      + 'HTTP API, OS 프로세스·다중 호스트, PostgreSQL 동작 또는 부하 검증의 증거가 아니다.',
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
  console.error(`서버 건설 PoC 검증 실패: ${message}`);
  process.exitCode = 1;
});

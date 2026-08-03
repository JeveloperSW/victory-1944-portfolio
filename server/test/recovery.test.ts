import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CURRENT_ECONOMY_RULE_VERSION,
  CURRENT_CAMPAIGN_RULE_VERSION,
  CAMPAIGN_RULESETS,
  RULESETS,
} from '../../engine/src/index.js';
import { ConstructionServer, ServerError } from '../src/index.js';

/**
 * 부상병 회복(D-045).
 * 패배가 영구 손실이 되지 않는지, 그리고 회복이 멱등·권위 규칙을 지키는지 본다.
 */

const CITY = 'city:rec';
const OWNER = 'user:rec';
const WORKER = 'worker:test';

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-rec-'));
  const server = await ConstructionServer.open(join(directory, 'rec.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

/** 부상병이 생길 때까지 실제로 싸운다 — 부상 수치를 손으로 넣지 않는다. */
async function cityWithWounded(server: ConstructionServer): Promise<{ wounded: number }> {
  await server.seedCity({
    cityId: CITY,
    ownerId: OWNER,
    ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
    campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
    // 자원은 창고·주거지 상한 안에 둔다. 상한을 넘겨 두면 승리 보상 정산이 음수가 된다.
    buildings: { hq: 6, barracks: 3, arsenal: 4, airfield: 3, warehouse: 4, housing: 4 },
    resources: { food: 1500, steel: 1500, oil: 800, supplies: 800, manpower: 300, scrip: 200 },
  });
  const context = { actorId: OWNER, nowHour: 0 };
  let ops = await server.getOperations(CITY);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:mob',
    cityId: CITY,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: 12 }, { unitId: 'scout', count: 1 }],
  });
  ops = await server.getOperations(CITY);
  await server.reconNpc(context, {
    commandId: 'cmd:recon',
    cityId: CITY,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations(CITY);
  await server.attackNpc(context, {
    commandId: 'cmd:attack',
    cityId: CITY,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
    doctrine: 'none',
    deployment: [
      { unitId: 'rifle', count: 12, row: 'front' },
      { unitId: 'scout', count: 1, row: 'mid' },
    ],
  });
  ops = await server.getOperations(CITY);
  const wounded = ops.army.wounded.rifle;
  assert.ok(wounded > 0, '전투가 부상병을 만들어야 이 테스트가 의미를 가진다.');
  return { wounded };
}

test('회복은 보급품을 예약 시 받고 시간이 지나면 부상병을 복귀시킨다', async (t) => {
  const server = await open(t);
  const { wounded } = await cityWithWounded(server);
  const campaign = CAMPAIGN_RULESETS[CURRENT_CAMPAIGN_RULE_VERSION as keyof typeof CAMPAIGN_RULESETS];
  const combat = RULESETS[campaign.combatRuleVersion as keyof typeof RULESETS]!;
  const context = { actorId: OWNER, nowHour: 0 };

  let ops = await server.getOperations(CITY);
  assert.deepEqual(ops.recoveries, [], '아직 예약이 없다.');
  assert.equal(ops.recoveryInfo.hours, campaign.recoveryHours);
  assert.equal(ops.recoveryInfo.suppliesRate, campaign.recoverySupplyCostRatio);
  assert.equal(ops.recoveryInfo.unitValues.rifle, combat.units.rifle!.cost);

  const suppliesBefore = ops.resourcesMicro.supplies;
  const readyBefore = ops.army.ready.rifle;
  // 사양: 선택 병력 전투가치 합의 10%를 올림한 보급품.
  const expected = Math.ceil(wounded * combat.units.rifle!.cost * campaign.recoverySupplyCostRatio);

  const reserved = await server.recoverUnits(context, {
    commandId: 'cmd:rec-1',
    cityId: CITY,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: wounded }],
  });
  assert.equal(reserved.replayed, false);
  assert.deepEqual(reserved.response.cost, { supplies: expected });
  assert.equal(reserved.response.completesAtHour, campaign.recoveryHours);

  ops = await server.getOperations(CITY);
  assert.equal(ops.resourcesMicro.supplies, suppliesBefore - expected * 1000, '보급품이 예약 시 빠진다.');
  assert.equal(ops.army.wounded.rifle, 0, '부상병이 즉시 회복 대기로 빠진다.');
  assert.equal(ops.army.ready.rifle, readyBefore, '복귀는 아직이다.');
  assert.equal(ops.recoveries.length, 1);
  assert.equal(ops.recoveries[0]!.count, wounded);
  assert.equal(ops.recoveries[0]!.completesAtHour, campaign.recoveryHours);

  // 완료 시각 전에는 거부한다.
  const jobId = ops.recoveries[0]!.id;
  await assert.rejects(
    server.completeRecovery({ actorId: WORKER, nowHour: campaign.recoveryHours - 1 }, { jobId }),
    (error: unknown) => (error as ServerError).code === 'TOO_EARLY',
  );

  const completed = await server.completeRecovery(
    { actorId: WORKER, nowHour: campaign.recoveryHours },
    { jobId },
  );
  assert.equal(completed.replayed, false);
  assert.equal(completed.response.count, wounded);

  ops = await server.getOperations(CITY);
  assert.equal(ops.army.ready.rifle, readyBefore + wounded, '부상병이 가용 병력으로 돌아온다.');
  assert.equal(ops.army.wounded.rifle, 0);
  assert.deepEqual(ops.recoveries, [], '완료된 예약은 목록에서 빠진다.');

  // 완료 재실행은 상태를 바꾸지 않는다(조건부 UPDATE 멱등).
  const again = await server.completeRecovery(
    { actorId: WORKER, nowHour: campaign.recoveryHours + 5 },
    { jobId },
  );
  assert.equal(again.replayed, true);
  const afterReplay = await server.getOperations(CITY);
  assert.equal(afterReplay.army.ready.rifle, readyBefore + wounded, '두 번째 완료는 병력을 늘리지 않는다.');
  assert.equal(afterReplay.version, ops.version, '재생은 도시 version도 올리지 않는다.');
});

test('회복 예약은 멱등하고 부상병을 초과하면 거부한다', async (t) => {
  const server = await open(t);
  const { wounded } = await cityWithWounded(server);
  const context = { actorId: OWNER, nowHour: 0 };
  let ops = await server.getOperations(CITY);
  const suppliesBefore = ops.resourcesMicro.supplies;

  const first = await server.recoverUnits(context, {
    commandId: 'cmd:rec-idem',
    cityId: CITY,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: 1 }],
  });
  ops = await server.getOperations(CITY);
  const afterFirst = ops.resourcesMicro.supplies;

  const replay = await server.recoverUnits(context, {
    commandId: 'cmd:rec-idem',
    cityId: CITY,
    expectedVersion: ops.version - 1,
    units: [{ unitId: 'rifle', count: 1 }],
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response.cost, first.response.cost);
  ops = await server.getOperations(CITY);
  assert.equal(ops.resourcesMicro.supplies, afterFirst, '재전송은 보급품을 다시 받지 않는다.');
  assert.ok(afterFirst < suppliesBefore);
  assert.equal(ops.recoveries.length, 1, '예약도 하나만 남는다.');

  // 남은 부상병보다 많이 요청하면 거부한다.
  await assert.rejects(
    server.recoverUnits(context, {
      commandId: 'cmd:rec-too-many',
      cityId: CITY,
      expectedVersion: ops.version,
      units: [{ unitId: 'rifle', count: wounded }],
    }),
    (error: unknown) => (error as ServerError).code === 'INSUFFICIENT_UNITS',
  );
  const after = await server.getOperations(CITY);
  assert.equal(after.version, ops.version, '거부된 명령은 도시 상태를 바꾸지 않는다.');
  assert.deepEqual(after.resourcesMicro, ops.resourcesMicro);

  // 전사자는 회복 대상이 아니다 — 부상병이 없는 병종은 거부된다.
  await assert.rejects(
    server.recoverUnits(context, {
      commandId: 'cmd:rec-dead',
      cityId: CITY,
      expectedVersion: after.version,
      units: [{ unitId: 'heavy_tank', count: 1 }],
    }),
    (error: unknown) => (error as ServerError).code === 'INSUFFICIENT_UNITS',
  );
});

test('회복 뒤에도 전투 이력 재검증이 통과한다', async (t) => {
  const server = await open(t);
  const { wounded } = await cityWithWounded(server);
  const campaign = CAMPAIGN_RULESETS[CURRENT_CAMPAIGN_RULE_VERSION as keyof typeof CAMPAIGN_RULESETS];
  const context = { actorId: OWNER, nowHour: 0 };

  let ops = await server.getOperations(CITY);
  await server.recoverUnits(context, {
    commandId: 'cmd:rec-hist',
    cityId: CITY,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: wounded }],
  });
  ops = await server.getOperations(CITY);
  await server.completeRecovery(
    { actorId: WORKER, nowHour: campaign.recoveryHours },
    { jobId: ops.recoveries[0]!.id },
  );

  // 복귀한 병력으로 다시 싸운다. 회복 완료가 이력 순서에 들어가야 이 전투가 통과한다.
  const later = { actorId: OWNER, nowHour: campaign.recoveryHours };
  ops = await server.getOperations(CITY);
  await server.reconNpc(later, {
    commandId: 'cmd:recon-2',
    cityId: CITY,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations(CITY);
  const deployment = Object.entries(ops.army.ready)
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({
      unitId,
      count,
      row: unitId === 'scout' ? 'mid' as const : 'front' as const,
    }));
  await server.attackNpc(later, {
    commandId: 'cmd:attack-2',
    cityId: CITY,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
    doctrine: 'none',
    deployment,
  });

  // 다시 읽는 것 자체가 병력·자원 이력 재검증이다.
  const reread = await server.getOperations(CITY);
  assert.equal(reread.battleReports.length, 2);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CURRENT_ECONOMY_RULE_VERSION,
  CURRENT_CAMPAIGN_RULE_VERSION,
} from '../../engine/src/index.js';
import { ConstructionServer, ServerError } from '../src/index.js';

/** 사양의 핵심 건물 14종이 새 도시에 실제로 존재하는지(D-043). */

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-b14-'));
  const server = await ConstructionServer.open(join(directory, 'b14.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

test('새 도시는 사양의 건물 14종을 갖고 규칙 버전이 서로 맞는다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const ops = await server.getOperations(session.cityId);
  assert.equal(ops.ruleVersion, CURRENT_ECONOMY_RULE_VERSION);
  assert.equal(ops.campaignRuleVersion, CURRENT_CAMPAIGN_RULE_VERSION);
  assert.deepEqual(Object.keys(ops.buildings).sort(), [
    'airfield', 'alliance_comms', 'arsenal', 'barracks', 'defense_hq', 'farm', 'housing',
    'hq', 'radar', 'refinery', 'research_lab', 'steel_mill', 'supply_depot', 'warehouse',
  ]);
  // 사령부는 첫 목표가 게이트에 막히지 않게 2로 시작한다.
  // D-046에서 시작 사령부를 3, 농장·제철소를 2로 올렸다(초반 생산과 증설 여지).
  assert.equal(ops.buildings.hq, 3);
  assert.equal(ops.buildings.farm, 2);
  assert.equal(ops.buildings.steel_mill, 2);
  for (const [buildingId, level] of Object.entries(ops.buildings)) {
    assert.ok(level >= 1, `${buildingId} 시작 레벨`);
  }
});

test('병종 해금은 건물 레벨에 결속되고 잠긴 병종의 동원은 거부된다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  const ops = await server.getOperations(session.cityId);

  const byId = new Map(ops.units.map((unit) => [unit.unitId, unit]));
  assert.equal(ops.units.length, 12, '병종 12종이 모두 내려온다.');

  // 시작 도시(병영 1·군수공장 1·비행장 1)에서 열린 것과 잠긴 것.
  assert.equal(byId.get('rifle')!.unlocked, true);
  assert.equal(byId.get('scout')!.unlocked, true);
  assert.equal(byId.get('howitzer')!.unlocked, true);
  assert.equal(byId.get('fighter')!.unlocked, true);
  assert.equal(byId.get('medium_tank')!.unlocked, false);
  assert.equal(byId.get('at_gun')!.unlocked, false);
  assert.equal(byId.get('at_infantry')!.unlocked, false);

  // 잠긴 병종은 조건을 이름까지 알려준다.
  const tank = byId.get('medium_tank')!;
  assert.equal(tank.requiresBuildingId, 'arsenal');
  assert.equal(tank.requiresBuildingNameKo, '군수공장');
  assert.equal(tank.requiresLevel, 4);
  assert.ok(Object.keys(tank.trainCost).length > 0, '훈련 비용을 함께 준다.');

  // 열린 병종은 조건이 없다고 표시한다.
  assert.equal(byId.get('rifle')!.requiresLevel, 1);

  // 잠긴 병종을 동원하면 거부된다.
  let caught: unknown;
  try {
    await server.mobilizeUnits(context, {
      commandId: 'cmd:locked-unit',
      cityId: session.cityId,
      expectedVersion: ops.version,
      units: [{ unitId: 'medium_tank', count: 1 }],
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServerError);
  assert.equal(caught.code, 'UNIT_LOCKED');

  // 거부는 자원을 빼기 전에 일어난다.
  const after = await server.getOperations(session.cityId);
  assert.deepEqual(after.resourcesMicro, ops.resourcesMicro);
  assert.equal(after.version, ops.version, '거부된 명령은 도시 version을 올리지 않는다.');
});

test('경제 0.1.0 도시는 해금 제약이 없다', async (t) => {
  // 해금은 0.2.0에서 도입했다. 옛 규칙 도시는 지금까지처럼 아무 병종이나 동원할 수 있어야 한다.
  const server = await open(t);
  await server.seedCity({
    cityId: 'city:legacy',
    ownerId: 'user:legacy',
    ruleVersion: '0.1.0',
    campaignRuleVersion: '0.2.0',
    buildings: { hq: 5 },
  });
  const ops = await server.getOperations('city:legacy');
  assert.equal(Object.keys(ops.buildings).length, 7, '옛 도시는 7종 도시다.');
  for (const unit of ops.units) {
    assert.equal(unit.unlocked, true, `${unit.unitId}는 제약이 없어야 한다.`);
    assert.equal(unit.requiresBuildingId, null);
  }
  await server.mobilizeUnits(
    { actorId: 'user:legacy', nowHour: 0 },
    {
      commandId: 'cmd:legacy-tank',
      cityId: 'city:legacy',
      expectedVersion: ops.version,
      units: [{ unitId: 'medium_tank', count: 1 }],
    },
  );
  const after = await server.getOperations('city:legacy');
  assert.equal(after.army.ready.medium_tank, 1);
});

test('레이더 레벨이 정찰 정확도를 올리고 옛 보고서 검증을 깨지 않는다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  let ops = await server.getOperations(session.cityId);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:radar-mob',
    cityId: session.cityId,
    expectedVersion: ops.version,
    units: [{ unitId: 'scout', count: 1 }],
  });

  // 레이더 1레벨에서의 정확도
  ops = await server.getOperations(session.cityId);
  await server.reconNpc(context, {
    commandId: 'cmd:radar-r1',
    cityId: session.cityId,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations(session.cityId);
  const first = ops.latestRecon!;
  // 정찰차량 1기 + 레이더 1레벨 = 550 + 50 + 30 = 630
  assert.equal(Math.round(first.accuracy * 1000), 630);
  assert.equal(first.radarLevel, 1);

  // 레이더를 3레벨로 올린다(사령부 게이트를 피해 직접 시드 갱신 대신 명령 두 번).
  await server.seedCity({
    cityId: 'city:radar3',
    ownerId: 'user:radar3',
    ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
    campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
    buildings: { hq: 5, radar: 4 },
  });
  const other = { actorId: 'user:radar3', nowHour: 0 };
  let ops3 = await server.getOperations('city:radar3');
  await server.mobilizeUnits(other, {
    commandId: 'cmd:radar3-mob',
    cityId: 'city:radar3',
    expectedVersion: ops3.version,
    units: [{ unitId: 'scout', count: 1 }],
  });
  ops3 = await server.getOperations('city:radar3');
  await server.reconNpc(other, {
    commandId: 'cmd:radar3-r',
    cityId: 'city:radar3',
    expectedVersion: ops3.version,
    scenarioId: 'training_outpost',
  });
  ops3 = await server.getOperations('city:radar3');
  // 정찰차량 1기 + 레이더 4레벨 = 550 + 50 + 120 = 720
  assert.equal(Math.round(ops3.latestRecon!.accuracy * 1000), 720);
  assert.ok(
    ops3.latestRecon!.accuracy > first.accuracy,
    '레이더가 높으면 정확도가 더 높아야 한다.',
  );

  // 첫 도시의 보고서를 다시 읽어도 여전히 통과한다(재계산이 저장된 레벨을 쓴다).
  const reread = await server.getOperations(session.cityId);
  assert.equal(Math.round(reread.latestRecon!.accuracy * 1000), 630);
});

test('레이더 계수가 없는 규칙에서는 기존 정확도 식이 그대로다', async (t) => {
  const server = await open(t);
  await server.seedCity({
    cityId: 'city:old',
    ownerId: 'user:old',
    ruleVersion: '0.1.0',
    campaignRuleVersion: '0.2.0',
    buildings: { hq: 5 },
  });
  const context = { actorId: 'user:old', nowHour: 0 };
  let ops = await server.getOperations('city:old');
  await server.mobilizeUnits(context, {
    commandId: 'cmd:old-mob',
    cityId: 'city:old',
    expectedVersion: ops.version,
    units: [{ unitId: 'scout', count: 2 }],
  });
  ops = await server.getOperations('city:old');
  await server.reconNpc(context, {
    commandId: 'cmd:old-recon',
    cityId: 'city:old',
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations('city:old');
  // 550 + 2*50 = 650. 레이더 항이 0이므로 도입 전과 완전히 같다.
  assert.equal(Math.round(ops.latestRecon!.accuracy * 1000), 650);
  assert.equal(ops.latestRecon!.radarLevel, 0);
});

test('건물 정보는 다음 레벨 비용·시간과 불가 사유를 함께 준다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const ops = await server.getOperations(session.cityId);
  const byId = new Map(ops.buildingInfo.map((info) => [info.buildingId, info]));
  assert.equal(ops.buildingInfo.length, 14);

  // 시작 레벨은 경제 규칙의 startingBuildings가 정한다(D-046에서 농장·제철소 2, 사령부 3).
  const farm = byId.get('farm')!;
  assert.equal(farm.level, 2);
  assert.equal(farm.nextLevel, 3);
  assert.ok(Object.keys(farm.nextCost).length > 0, '다음 레벨 비용을 준다.');
  assert.ok(farm.nextHours >= 1, '건설 시간을 준다.');
  assert.equal(farm.blockedReason, null, '사령부 3레벨이므로 농장 3레벨은 가능하다.');

  // 사령부 게이트에 막힌 건물은 사유를 미리 알려준다(눌러 보지 않아도).
  const arsenal = byId.get('arsenal')!;
  assert.equal(arsenal.level, 1);
  assert.equal(arsenal.blockedReason, null, '군수공장 2레벨은 사령부 3이면 가능하다.');

  // 연구 시스템이 생겼으므로 연구소는 건설할 수 있다(D-044).
  assert.equal(byId.get('research_lab')!.inertReasonKo, null);
  assert.equal(byId.get('research_lab')!.blockedReason, null);
  // PvP·연맹은 만들 수 없으므로 건설을 막는다 — 효과 없는 건물에 자원을 쓰게 두지 않는다.
  assert.equal(byId.get('defense_hq')!.inertReasonKo, '플레이어 간 전투가 아직 없어 효과가 없습니다.');
  assert.equal(byId.get('defense_hq')!.blockedReason, 'SYSTEM_NOT_IMPLEMENTED');
  assert.equal(byId.get('alliance_comms')!.blockedReason, 'SYSTEM_NOT_IMPLEMENTED');
  assert.equal(byId.get('barracks')!.inertReasonKo, null, '병영은 효과가 있다.');
});

test('새 건물도 증설 명령이 통과한다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  const ops = await server.getOperations(session.cityId);
  // 병영은 v8에서 넓힌 building_id CHECK를 통과해야 한다.
  const result = await server.startConstruction(context, {
    commandId: 'cmd:barracks',
    cityId: session.cityId,
    expectedVersion: ops.version,
    buildingId: 'barracks',
  });
  assert.equal(result.response.buildingId, 'barracks');
  assert.equal(result.response.targetLevel, 2);
});

test('효과 없는 건물은 서버가 건설을 거부한다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, 'c'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  const before = await server.getOperations(session.cityId);
  // 화면이 버튼을 막는 것과 별개로 서버가 막아야 한다(D-044).
  for (const buildingId of ['defense_hq', 'alliance_comms'] as const) {
    await assert.rejects(
      server.startConstruction(context, {
        commandId: `cmd:${buildingId}`,
        cityId: session.cityId,
        expectedVersion: before.version,
        buildingId,
      }),
      (error: unknown) => (error as ServerError).code === 'SYSTEM_NOT_IMPLEMENTED',
    );
  }
  const after = await server.getOperations(session.cityId);
  assert.equal(after.version, before.version, '거부된 명령은 도시 상태를 바꾸지 않는다.');
  assert.deepEqual(after.resourcesMicro, before.resourcesMicro, '자원이 나가지 않는다.');
});

test('연구는 군표를 쓰고 실제로 전투·정찰 결과를 바꾼다', async (t) => {
  const server = await open(t);
  // 연구소 3레벨·군표 넉넉한 도시를 만든다.
  await server.seedCity({
    cityId: 'city:lab',
    ownerId: 'user:lab',
    ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
    campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
    buildings: { hq: 6, research_lab: 3, barracks: 3, arsenal: 4 },
    resources: { scrip: 500, food: 2000, steel: 2000, oil: 1000, supplies: 500, manpower: 300 },
  });
  const context = { actorId: 'user:lab', nowHour: 0 };

  let ops = await server.getOperations('city:lab');
  const byId = new Map(ops.research.map((entry) => [entry.researchId, entry]));
  assert.equal(ops.research.length, 5, '효과가 동작하는 연구만 내려온다.');
  assert.equal(byId.get('infantry_doctrine')!.level, 0);
  assert.equal(byId.get('infantry_doctrine')!.nextScripCost, 40);
  assert.equal(byId.get('infantry_doctrine')!.effectKo, '단계당 보병 공격 +4%');
  assert.equal(byId.get('infantry_doctrine')!.currentEffectKo, '');
  // 선행 연구가 없으면 막힌다.
  assert.equal(byId.get('at_doctrine')!.blockedReason, 'RESEARCH_PREREQUISITE');

  // 보병 전술 1단계
  const scripBefore = ops.resourcesMicro.scrip;
  const first = await server.advanceResearch(context, {
    commandId: 'cmd:res-1',
    cityId: 'city:lab',
    expectedVersion: ops.version,
    researchId: 'infantry_doctrine',
    targetLevel: 1,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.response.level, 1);
  assert.deepEqual(first.response.cost, { scrip: 40 });

  ops = await server.getOperations('city:lab');
  assert.equal(ops.resourcesMicro.scrip, scripBefore - 40_000, '군표가 정확히 빠진다.');
  const after = new Map(ops.research.map((entry) => [entry.researchId, entry]));
  assert.equal(after.get('infantry_doctrine')!.level, 1);
  assert.equal(after.get('infantry_doctrine')!.currentEffectKo, '보병 공격 +4%');
  assert.equal(after.get('at_doctrine')!.blockedReason, null, '선행 연구가 끝나 열린다.');

  // 같은 명령 재전송은 영수증으로 재생되고 다시 과금하지 않는다.
  const replay = await server.advanceResearch(context, {
    commandId: 'cmd:res-1',
    cityId: 'city:lab',
    expectedVersion: ops.version - 1,
    researchId: 'infantry_doctrine',
    targetLevel: 1,
  });
  assert.equal(replay.replayed, true);
  assert.equal((await server.getOperations('city:lab')).resourcesMicro.scrip, scripBefore - 40_000);

  // 단계 건너뛰기는 거부한다.
  let caught: unknown;
  try {
    await server.advanceResearch(context, {
      commandId: 'cmd:res-skip',
      cityId: 'city:lab',
      expectedVersion: ops.version,
      researchId: 'infantry_doctrine',
      targetLevel: 3,
    });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof ServerError);
  assert.equal(caught.code, 'INVALID_INPUT');

  // 연구소 레벨이 부족한 연구는 거부한다(기갑 운용은 연구소 3 필요 → 충족, 4레벨 것은 없음).
  // 정찰 기법을 올려 정찰 정확도가 실제로 오르는지 본다.
  ops = await server.getOperations('city:lab');
  await server.advanceResearch(context, {
    commandId: 'cmd:res-recon',
    cityId: 'city:lab',
    expectedVersion: ops.version,
    researchId: 'recon_doctrine',
    targetLevel: 1,
  });
  ops = await server.getOperations('city:lab');
  await server.mobilizeUnits(context, {
    commandId: 'cmd:res-mob',
    cityId: 'city:lab',
    expectedVersion: ops.version,
    units: [{ unitId: 'scout', count: 1 }, { unitId: 'rifle', count: 8 }],
  });
  ops = await server.getOperations('city:lab');
  await server.reconNpc(context, {
    commandId: 'cmd:res-recon-cmd',
    cityId: 'city:lab',
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations('city:lab');
  // 정찰차량 1 + 레이더 1 + 연구 1단계(20‰) = 550 + 50 + 30 + 20 = 650
  assert.equal(Math.round(ops.latestRecon!.accuracy * 1000), 650);
  assert.equal(ops.latestRecon!.researchReconPermille, 20);

  // 전투 입력에 연구 공격 보정이 실려 재현이 정확하다.
  const deployment = Object.entries(ops.army.ready)
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({ unitId, count, row: unitId === 'scout' ? 'mid' as const : 'front' as const }));
  await server.attackNpc(context, {
    commandId: 'cmd:res-attack',
    cityId: 'city:lab',
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
    doctrine: 'none',
    deployment,
  });
  // 다시 읽으면 저장 입력을 재현해 대조한다 — 통과하면 보정이 입력에 남았다는 뜻이다.
  const reread = await server.getOperations('city:lab');
  assert.equal(reread.battleReports.length, 1);
});

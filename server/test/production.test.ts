import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CURRENT_ECONOMY_RULE_VERSION,
  CURRENT_CAMPAIGN_RULE_VERSION,
  ECONOMY_RULESETS,
  hourlyProduction,
} from '../../engine/src/index.js';
import { ConstructionServer } from '../src/index.js';

/**
 * 시간당 생산(D-045).
 * 서버에 생산이 없어서 자원이 줄기만 하던 상태를 닫는다.
 */

const CITY = 'city:prod';
const OWNER = 'user:prod';
const WORKER = 'worker:prod';

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-prod-'));
  const server = await ConstructionServer.open(join(directory, 'prod.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

async function seed(server: ConstructionServer): Promise<void> {
  await server.seedCity({
    cityId: CITY,
    ownerId: OWNER,
    ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
    campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
    buildings: { hq: 3, farm: 2, steel_mill: 2, refinery: 1, supply_depot: 1, housing: 2, warehouse: 3 },
    resources: { food: 100, steel: 100, oil: 50, supplies: 50, manpower: 50, scrip: 10 },
  });
}

test('첫 정산은 소급하지 않고 이후 시간만큼 자원이 늘어난다', async (t) => {
  const server = await open(t);
  await seed(server);
  const before = await server.getOperations(CITY);

  // 처음 보는 도시는 시작점만 잡는다 — 옛 도시가 수천 시간을 한 번에 받지 않게.
  const first = await server.creditProduction({ actorId: WORKER, nowHour: 100 }, { cityId: CITY, toHour: 100 });
  assert.equal(first, null, '첫 호출은 정산하지 않는다.');
  let ops = await server.getOperations(CITY);
  assert.deepEqual(ops.resourcesMicro, before.resourcesMicro, '소급 지급이 없다.');
  assert.equal(ops.version, before.version, '도시 version도 그대로다.');

  // 같은 시각에 또 불러도 아무 일이 없다.
  assert.equal(
    await server.creditProduction({ actorId: WORKER, nowHour: 100 }, { cityId: CITY, toHour: 100 }),
    null,
  );

  const credited = await server.creditProduction(
    { actorId: WORKER, nowHour: 103 },
    { cityId: CITY, toHour: 103 },
  );
  assert.ok(credited !== null);
  assert.equal(credited.response.fromHour, 100);
  assert.equal(credited.response.toHour, 103);

  ops = await server.getOperations(CITY);
  // 3시간치가 실제로 들어왔는지 규칙에서 직접 계산해 대조한다(화면 값이 아니라 규칙이 기준이다).
  const rules = ECONOMY_RULESETS[CURRENT_ECONOMY_RULE_VERSION]!;
  const perHour = hourlyProduction(rules, before.buildings, 50);
  assert.equal(
    ops.resourcesMicro.food,
    before.resourcesMicro.food + Math.round(perHour.food! * 3 * 1000),
    '식량이 3시간치 늘어난다.',
  );
  assert.ok(ops.resourcesMicro.manpower > before.resourcesMicro.manpower, '인력도 회복된다.');
  assert.deepEqual(ops.productionPerHour.food, perHour.food, '스냅샷의 시간당 생산량이 규칙과 같다.');
});

test('소수 자릿수가 붙는 정산도 저장·재검증을 통과한다', async (t) => {
  const server = await open(t);
  await server.seedCity({
    cityId: CITY,
    ownerId: OWNER,
    ruleVersion: CURRENT_ECONOMY_RULE_VERSION,
    campaignRuleVersion: CURRENT_CAMPAIGN_RULE_VERSION,
    buildings: { hq: 3, farm: 2, steel_mill: 2, housing: 3, warehouse: 3 },
    // 인력을 딱 떨어지지 않는 값으로 둔다. 군표 = 인력 × 비율이라 소수가 이어진다.
    resources: { food: 100, steel: 100, oil: 50, supplies: 50, manpower: 137, scrip: 10 },
  });
  await server.creditProduction({ actorId: WORKER, nowHour: 0 }, { cityId: CITY, toHour: 0 });
  const credited = await server.creditProduction({ actorId: WORKER, nowHour: 37 }, { cityId: CITY, toHour: 37 });
  assert.ok(credited !== null);

  // micro 정수를 1000으로 나눈 값은 이진수로 정확하지 않다(예: 26.859 × 1000 = 26858.999…).
  // 저장 검증이 이 값을 등식으로 비교하면 정상 정산이 DATA_INTEGRITY로 튕긴다(D-047).
  const scrip = credited.response.credited.scrip ?? 0;
  assert.ok(scrip > 0, '군표가 소수 단위로 정산된다.');
  assert.notEqual(Math.round(scrip), scrip, '이 테스트는 소수 금액일 때만 의미가 있다.');

  // 다시 읽는 것 자체가 저장 응답·원장 재검증이다.
  const ops = await server.getOperations(CITY);
  assert.ok(ops.resourcesMicro.scrip > 10_000);
});

test('같은 구간을 다시 정산해도 자원이 두 번 들어오지 않는다', async (t) => {
  const server = await open(t);
  await seed(server);
  await server.creditProduction({ actorId: WORKER, nowHour: 10 }, { cityId: CITY, toHour: 10 });
  const credited = await server.creditProduction({ actorId: WORKER, nowHour: 20 }, { cityId: CITY, toHour: 20 });
  assert.ok(credited !== null);
  const after = await server.getOperations(CITY);

  // 시각을 되돌려 같은 구간을 다시 정산하려 해도 더 주지 않는다.
  assert.equal(
    await server.creditProduction({ actorId: WORKER, nowHour: 20 }, { cityId: CITY, toHour: 20 }),
    null,
  );
  assert.equal(
    await server.creditProduction({ actorId: WORKER, nowHour: 15 }, { cityId: CITY, toHour: 15 }),
    null,
  );
  const again = await server.getOperations(CITY);
  assert.deepEqual(again.resourcesMicro, after.resourcesMicro, '자원이 두 번 들어오지 않는다.');
  assert.equal(again.version, after.version);
});

test('상한을 넘겨 쌓이지 않고, 정산 뒤에도 명령과 이력 검증이 통과한다', async (t) => {
  const server = await open(t);
  await seed(server);
  await server.creditProduction({ actorId: WORKER, nowHour: 0 }, { cityId: CITY, toHour: 0 });
  // 아주 긴 시간을 정산하면 창고·주거지 상한에서 멈춘다.
  await server.creditProduction({ actorId: WORKER, nowHour: 5000 }, { cityId: CITY, toHour: 5000 });
  const ops = await server.getOperations(CITY);
  const rules = ECONOMY_RULESETS[CURRENT_ECONOMY_RULE_VERSION]!;
  const warehouseCap = (rules.balance.warehouseCapBase
    + rules.balance.warehouseCapPerLevel * ops.buildings.warehouse!) * 1000;
  const housingCap = (rules.balance.housingCapBase
    + rules.balance.housingCapPerLevel * ops.buildings.housing!) * 1000;
  assert.equal(ops.resourcesMicro.food, warehouseCap, '식량이 창고 상한에서 멈춘다.');
  assert.equal(ops.resourcesMicro.manpower, housingCap, '인력이 주거지 상한에서 멈춘다.');

  // 정산으로 늘어난 자원으로 실제 명령을 낸다 — 자원 이력 검증이 여기서 함께 돈다.
  const context = { actorId: OWNER, nowHour: 5000 };
  await server.mobilizeUnits(context, {
    commandId: 'cmd:prod-mob',
    cityId: CITY,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: 5 }],
  });
  const after = await server.getOperations(CITY);
  assert.equal(after.army.ready.rifle, 5);
  assert.ok(after.resourcesMicro.food < ops.resourcesMicro.food, '동원 비용이 나갔다.');
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CURRENT_CAMPAIGN_RULE_VERSION } from '../../engine/src/index.js';
import { ConstructionServer, ServerError } from '../src/index.js';

/** 기기 계정(D-039)과 시나리오 사다리(D-040). */

const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);
const FIRST_SCENARIO = 'training_outpost';

/** 병종별 기본 배치 열. 클라이언트 계약과 같은 값이다. */
const ROW_BY_UNIT: Readonly<Record<string, 'front' | 'mid' | 'back'>> = {
  rifle: 'front',
  medium_tank: 'front',
  scout: 'mid',
  howitzer: 'back',
};

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-accounts-'));
  const server = await ConstructionServer.open(join(directory, 'accounts.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

async function expectCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServerError, `expected ServerError ${code}`);
  assert.equal(caught.code, code);
}

test('처음 보는 기기는 계정과 도시를 새로 만든다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 5 }, DEVICE_A);
  assert.equal(session.created, true);
  assert.match(session.actorId, /^user:[0-9a-f]{24}$/);
  assert.match(session.cityId, /^city:[0-9a-f]{24}$/);
  assert.equal(session.token.length, 64);

  const city = await server.getCity(session.cityId);
  assert.equal(city.ownerId, session.actorId);
  assert.equal(city.lastServerHour, 5);

  const actor = await server.authenticateToken(session.token);
  assert.equal(actor.actorId, session.actorId);
  assert.equal(actor.role, 'player');
});

test('같은 기기는 계정을 다시 만들지 않고 새 세션만 받는다', async (t) => {
  const server = await open(t);
  const first = await server.registerDevice({ nowHour: 1 }, DEVICE_A);
  const second = await server.registerDevice({ nowHour: 9 }, DEVICE_A);
  assert.equal(second.created, false);
  assert.equal(second.actorId, first.actorId);
  assert.equal(second.cityId, first.cityId);
  assert.notEqual(second.token, first.token, '세션 토큰은 매번 새로 발급한다.');
  // 이전 토큰도 유효하다(기기 여러 세션 허용). 폐기는 계정 삭제에서만 한다.
  assert.equal((await server.authenticateToken(first.token)).actorId, first.actorId);
});

test('다른 기기는 서로 다른 계정과 도시를 받는다', async (t) => {
  const server = await open(t);
  const a = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const b = await server.registerDevice({ nowHour: 0 }, DEVICE_B);
  assert.notEqual(a.actorId, b.actorId);
  assert.notEqual(a.cityId, b.cityId);
  const cityB = await server.getCity(b.cityId);
  assert.equal(cityB.ownerId, b.actorId);
});

test('기기 비밀값 형식을 검증한다', async (t) => {
  const server = await open(t);
  for (const value of ['', 'short', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(129), 42, null, {}]) {
    await expectCode(() => server.registerDevice({ nowHour: 0 }, value), 'INVALID_INPUT');
  }
  await expectCode(
    () => server.registerDevice({ nowHour: -1 } as never, DEVICE_A),
    'INVALID_INPUT',
  );
});

test('계정 조회는 자기 도시 ID를 돌려준다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 7 }, DEVICE_A);
  const account = await server.getAccount(session.actorId);
  assert.deepEqual(account, {
    actorId: session.actorId,
    cityId: session.cityId,
    createdAtHour: 7,
  });
  await expectCode(() => server.getAccount('user:missing'), 'NOT_FOUND');
});

test('새 계정의 도시는 첫 루프를 끝까지 돌 수 있다', async (t) => {
  // D-039에서 규칙 버전과 시작 사령부 레벨을 지정하지 않아, 계정은 만들어지지만
  // 클라이언트가 쓰는 시나리오도 첫 목표도 실패하는 도시가 나왔다. 그 회귀를 막는다.
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const context = { actorId: session.actorId, nowHour: 0 };
  const city = await server.getCity(session.cityId);
  assert.equal(city.campaignRuleVersion, CURRENT_CAMPAIGN_RULE_VERSION);

  // 1) 첫 목표: 농장 증설이 사령부 게이트에 막히지 않는다.
  await server.startConstruction(context, {
    commandId: 'cmd:loop-build',
    cityId: session.cityId,
    expectedVersion: city.version,
    buildingId: 'farm',
  });

  // 2) 동원 → 3) 정찰 → 4) 공격이 모두 통과한다.
  let snapshot = await server.getOperations(session.cityId);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:loop-mobilize',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    // 시작 도시에서 해금된 병종만 쓴다(중형전차는 군수공장 4가 필요하다, D-043).
    units: [
      { unitId: 'rifle', count: 10 },
      { unitId: 'scout', count: 1 },
      { unitId: 'howitzer', count: 1 },
    ],
  });
  snapshot = await server.getOperations(session.cityId);
  await server.reconNpc(context, {
    commandId: 'cmd:loop-recon',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
  });
  snapshot = await server.getOperations(session.cityId);
  const deployment = Object.entries(snapshot.army.ready)
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({ unitId, count, row: ROW_BY_UNIT[unitId]! }));
  await server.attackNpc(context, {
    commandId: 'cmd:loop-attack',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
    doctrine: 'artillery_support',
    deployment,
  });
  snapshot = await server.getOperations(session.cityId);
  assert.equal(snapshot.battleReports.length, 1);
});

test('시나리오 목록은 첫 단계만 열려 있고 잠긴 시나리오는 거부된다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const context = { actorId: session.actorId, nowHour: 0 };
  const snapshot = await server.getOperations(session.cityId);

  assert.ok(snapshot.scenarios.length >= 6, '시나리오가 여러 개 내려온다.');
  assert.equal(snapshot.scenarios[0]!.id, FIRST_SCENARIO);
  assert.equal(snapshot.scenarios[0]!.unlocked, true);
  assert.equal(snapshot.scenarios[0]!.cleared, false);
  assert.ok(snapshot.scenarios[0]!.briefKo.length > 0, '설명이 있다.');
  for (const scenario of snapshot.scenarios.slice(1)) {
    assert.equal(scenario.unlocked, false, `${scenario.id}는 처음엔 잠겨 있어야 한다.`);
    assert.ok(scenario.requiresNameKo, '해금 조건 이름을 알려준다.');
  }
  // 방어 편성을 노출하지 않는다 — 적 규모는 정찰로만 안다.
  assert.equal('defenderStacks' in snapshot.scenarios[0]!, false);

  const locked = snapshot.scenarios[1]!.id;
  await expectCode(() => server.reconNpc(context, {
    commandId: 'cmd:locked-recon',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: locked,
  }), 'SCENARIO_LOCKED');
});

test('교리 목록은 규칙 수치에서 만든 설명과 함께 내려온다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const snapshot = await server.getOperations(session.cityId);
  const doctrines = snapshot.doctrines;
  assert.ok(doctrines.length >= 7, '교리가 여러 개 내려온다.');

  const byId = new Map(doctrines.map((entry) => [entry.id, entry]));
  // 설명은 손으로 적은 문구가 아니라 규칙의 배수에서 나온다.
  assert.deepEqual(byId.get('artillery_support')?.effectsKo, ['포병 공격 +20%']);
  assert.deepEqual(byId.get('armor_breakthrough')?.effectsKo, [
    '중형전차 공격 +15%',
    '중전차 공격 +15%',
    '대전차에게 받는 피해 +10%',
  ]);
  assert.deepEqual(byId.get('defense')?.effectsKo, ['모든 공격 -5%', '받는 피해 -10%']);
  assert.deepEqual(byId.get('recon_mobility')?.effectsKo, ['정찰 공격 +50%', '정찰 점수 +20']);
  assert.deepEqual(byId.get('none')?.effectsKo, ['보정 없음']);
  for (const doctrine of doctrines) {
    assert.ok(doctrine.nameKo.length > 0, `${doctrine.id} 이름 없음`);
    assert.ok(doctrine.effectsKo.length > 0, `${doctrine.id} 설명 없음`);
  }
});

test('교리를 바꿔 공격할 수 있고 알 수 없는 교리는 거부된다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const context = { actorId: session.actorId, nowHour: 0 };
  let snapshot = await server.getOperations(session.cityId);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:doc-mob',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    units: [{ unitId: 'rifle', count: 10 }, { unitId: 'scout', count: 1 }],
  });
  snapshot = await server.getOperations(session.cityId);
  await server.reconNpc(context, {
    commandId: 'cmd:doc-recon',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
  });
  snapshot = await server.getOperations(session.cityId);
  const deployment = Object.entries(snapshot.army.ready)
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({ unitId, count, row: ROW_BY_UNIT[unitId]! }));

  await expectCode(() => server.attackNpc(context, {
    commandId: 'cmd:doc-bad',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
    // 규칙에 없는 값을 일부러 보낸다. 서버가 거부하는지가 이 검사의 목적이다.
    doctrine: 'not_a_doctrine' as never,
    deployment,
  }), 'UNKNOWN_DOCTRINE');

  // 기본 교리가 아닌 값으로도 공격이 통과하고 보고서에 그대로 남는다.
  const result = await server.attackNpc(context, {
    commandId: 'cmd:doc-ok',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
    doctrine: 'recon_mobility',
    deployment,
  });
  assert.equal(result.response.report.result.attacker.stacks.length, deployment.length);
  // 응답과 조회 모두 어떤 교리로 싸웠는지 알려준다(D-042).
  assert.equal(result.response.report.doctrine, 'recon_mobility');
  assert.equal(result.response.report.doctrineNameKo, '정찰·기동 교리');
  const stored = (await server.getOperations(session.cityId)).battleReports.at(-1)!;
  assert.equal(stored.result.attacker.stacks.length, deployment.length);
  assert.equal(stored.doctrine, 'recon_mobility');
  assert.equal(stored.doctrineNameKo, '정찰·기동 교리');

  // 같은 명령을 다시 보내면 영수증이 재생된다. 재생 경로도 교리를 잃지 않아야 한다.
  const replay = await server.attackNpc(context, {
    commandId: 'cmd:doc-ok',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
    doctrine: 'recon_mobility',
    deployment,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.response.report.doctrine, 'recon_mobility');
});

test('교리는 파생 항목이며 저장되는 보고서 JSON은 그대로다', async (t) => {
  // D-042의 핵심 제약: 교리를 report_json에 넣으면 기존 기록의 canonical 검증이 깨진다.
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-report-'));
  const databasePath = join(directory, 'report.sqlite');
  const server = await ConstructionServer.open(databasePath);
  const session = await server.registerDevice({ nowHour: 0 }, DEVICE_A);
  const context = { actorId: session.actorId, nowHour: 0 };
  let snapshot = await server.getOperations(session.cityId);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:store-mob',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    units: [{ unitId: 'rifle', count: 10 }, { unitId: 'scout', count: 1 }],
  });
  snapshot = await server.getOperations(session.cityId);
  await server.reconNpc(context, {
    commandId: 'cmd:store-recon',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
  });
  snapshot = await server.getOperations(session.cityId);
  await server.attackNpc(context, {
    commandId: 'cmd:store-attack',
    cityId: session.cityId,
    expectedVersion: snapshot.version,
    scenarioId: FIRST_SCENARIO,
    doctrine: 'armor_breakthrough',
    deployment: Object.entries(snapshot.army.ready)
      .filter(([, count]) => count > 0)
      .map(([unitId, count]) => ({ unitId, count, row: ROW_BY_UNIT[unitId]! })),
  });
  await server.close();

  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = raw.prepare('SELECT report_json, response_json FROM npc_battle_reports '
      + 'JOIN operation_receipts USING (city_id, command_id)').get() as {
        report_json: string;
        response_json: string;
      };
    const report = JSON.parse(row.report_json) as Record<string, unknown>;
    assert.equal('doctrine' in report, false, 'report_json에 교리가 들어가면 안 된다.');
    assert.equal('doctrineNameKo' in report, false);
    assert.deepEqual(Object.keys(report).sort(), [
      'analysis', 'campaignRuleVersion', 'casualties', 'cityId', 'commandId', 'createdAtHour',
      'id', 'reconReportId', 'result', 'reward', 'scenarioId', 'scenarioNameKo', 'seed',
      'sortieCost',
    ]);
    const response = JSON.parse(row.response_json) as { report: Record<string, unknown> };
    assert.equal('doctrine' in response.report, false, '영수증 응답도 저장 형태를 지킨다.');
  } finally {
    raw.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test('계정 삭제는 도시·토큰·계정을 모두 지우고 같은 기기는 새 계정을 받는다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 2 }, DEVICE_A);
  // 진행 기록을 만들어 둔 상태에서 삭제해도 참조 제약에 걸리지 않아야 한다.
  await server.startConstruction(
    { actorId: session.actorId, nowHour: 2 },
    {
      commandId: 'cmd:delete-check',
      cityId: session.cityId,
      expectedVersion: 0,
      buildingId: 'hq',
    },
  );

  const result = await server.deleteAccount(session.actorId);
  assert.deepEqual(result, {
    actorId: session.actorId,
    cityId: session.cityId,
    deleted: true,
  });

  await expectCode(() => server.getCity(session.cityId), 'NOT_FOUND');
  await expectCode(() => server.getAccount(session.actorId), 'NOT_FOUND');
  await expectCode(() => server.authenticateToken(session.token), 'UNAUTHORIZED');
  await expectCode(() => server.deleteAccount(session.actorId), 'NOT_FOUND');

  const reborn = await server.registerDevice({ nowHour: 3 }, DEVICE_A);
  assert.equal(reborn.created, true, '삭제 뒤 같은 기기는 새 계정을 만든다.');
  assert.equal(reborn.actorId, session.actorId, '주체 ID는 기기 해시에서 유도되므로 같다.');
  assert.equal((await server.getCity(reborn.cityId)).lastServerHour, 3);
});

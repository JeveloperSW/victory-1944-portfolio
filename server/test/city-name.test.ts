import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConstructionServer, ServerError } from '../src/index.js';

/**
 * 도시 이름(D-054).
 * 이름은 서버가 보관·정규화·판정하는 권위 상태다. 화면이 다듬어 보내는 것을 믿지 않는다.
 */

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-name-'));
  const server = await ConstructionServer.open(join(directory, 'name.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

test('새 도시는 기본 이름을 갖고 소유자가 바꿀 수 있다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, '1'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };

  let ops = await server.getOperations(session.cityId);
  assert.equal(ops.name, '새 도시', '이름을 정하기 전에는 기본값이 보인다.');

  const renamed = await server.renameCity(context, {
    commandId: 'cmd:name-1',
    cityId: session.cityId,
    expectedVersion: ops.version,
    name: '청운',
  });
  assert.equal(renamed.replayed, false);
  assert.equal(renamed.response.name, '청운');

  ops = await server.getOperations(session.cityId);
  assert.equal(ops.name, '청운');

  // 같은 명령 재전송은 영수증으로 재생되고 version을 또 올리지 않는다.
  const replay = await server.renameCity(context, {
    commandId: 'cmd:name-1',
    cityId: session.cityId,
    expectedVersion: ops.version - 1,
    name: '청운',
  });
  assert.equal(replay.replayed, true);
  assert.equal((await server.getOperations(session.cityId)).version, ops.version);
});

test('이름을 서버가 정규화한다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, '1'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  const ops = await server.getOperations(session.cityId);

  // 양끝 공백과 연속 공백은 정리한다. 두 이름이 같아 보이면 사칭에 쓰인다.
  const result = await server.renameCity(context, {
    commandId: 'cmd:trim',
    cityId: session.cityId,
    expectedVersion: ops.version,
    name: '  제1  기갑  사령부  ',
  });
  assert.equal(result.response.name, '제1 기갑 사령부');
  assert.equal((await server.getOperations(session.cityId)).name, '제1 기갑 사령부');
});

test('규칙에 어긋난 이름은 거부하고 도시를 바꾸지 않는다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, '1'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  const before = await server.getOperations(session.cityId);

  const rejected: readonly [string, string][] = [
    ['빈 이름', '   '],
    ['제어문자', '청운'],
    ['보이지 않는 문자', '청​운'],
    ['방향 제어 문자', '청‮운'],
    ['줄바꿈', '청운\n2단'],
    ['24자 초과', '가'.repeat(25)],
    ['시스템 사칭', '[시스템] 공지'],
    ['문자열이 아님', 42 as unknown as string],
  ];
  for (const [index, [label, name]] of rejected.entries()) {
    await assert.rejects(
      server.renameCity(context, {
        // commandId는 영문·숫자만 쓴다. 한글 라벨을 넣으면 이름이 아니라 id 검증에서 걸린다.
        commandId: `cmd:bad-${index}`,
        cityId: session.cityId,
        expectedVersion: before.version,
        name,
      }),
      (error: unknown) => (error as ServerError).code === 'INVALID_CITY_NAME'
        || (error as ServerError).code === 'INVALID_INPUT',
      `${label}는 거부되어야 한다`,
    );
  }
  const after = await server.getOperations(session.cityId);
  assert.equal(after.name, before.name, '거부된 명령은 이름을 바꾸지 않는다.');
  assert.equal(after.version, before.version, '도시 version도 그대로다.');

  // 24자는 통과한다(경계).
  const edge = await server.renameCity(context, {
    commandId: 'cmd:edge',
    cityId: session.cityId,
    expectedVersion: after.version,
    name: '가'.repeat(24),
  });
  assert.equal(edge.response.name, '가'.repeat(24));
});

test('남의 도시 이름은 바꿀 수 없다', async (t) => {
  const server = await open(t);
  const mine = await server.registerDevice({ nowHour: 0 }, 'a'.repeat(64));
  const theirs = await server.registerDevice({ nowHour: 0 }, 'b'.repeat(64));
  const ops = await server.getOperations(theirs.cityId);
  await assert.rejects(
    server.renameCity({ actorId: mine.actorId, nowHour: 0 }, {
      commandId: 'cmd:steal',
      cityId: theirs.cityId,
      expectedVersion: ops.version,
      name: '점령됨',
    }),
    (error: unknown) => (error as ServerError).code === 'FORBIDDEN',
  );
  assert.equal((await server.getOperations(theirs.cityId)).name, '새 도시');
});

test('이름을 바꾼 뒤에도 첫 루프가 그대로 돈다', async (t) => {
  const server = await open(t);
  const session = await server.registerDevice({ nowHour: 0 }, '3'.repeat(64));
  const context = { actorId: session.actorId, nowHour: 0 };
  let ops = await server.getOperations(session.cityId);
  await server.renameCity(context, {
    commandId: 'cmd:rename',
    cityId: session.cityId,
    expectedVersion: ops.version,
    name: '전선 사령부',
  });
  ops = await server.getOperations(session.cityId);
  await server.mobilizeUnits(context, {
    commandId: 'cmd:mob',
    cityId: session.cityId,
    expectedVersion: ops.version,
    units: [{ unitId: 'rifle', count: 6 }, { unitId: 'scout', count: 1 }],
  });
  ops = await server.getOperations(session.cityId);
  await server.reconNpc(context, {
    commandId: 'cmd:recon',
    cityId: session.cityId,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
  });
  ops = await server.getOperations(session.cityId);
  await server.attackNpc(context, {
    commandId: 'cmd:attack',
    cityId: session.cityId,
    expectedVersion: ops.version,
    scenarioId: 'training_outpost',
    doctrine: 'none',
    deployment: [
      { unitId: 'rifle', count: 6, row: 'front' },
      { unitId: 'scout', count: 1, row: 'mid' },
    ],
  });
  // 다시 읽는 것 자체가 이력 재검증이다. 이름 변경 영수증이 섞여도 통과해야 한다.
  const reread = await server.getOperations(session.cityId);
  assert.equal(reread.battleReports.length, 1);
  assert.equal(reread.name, '전선 사령부');
});

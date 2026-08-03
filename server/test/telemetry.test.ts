import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConstructionServer, ServerError } from '../src/index.js';
import type { ClientEventInput, CommandContext } from '../src/index.js';

const PLAYER = 'user:tester';
const ADMIN = 'admin:ops';
const SESSION = 'session:aaaaaaaa';

async function open(t: TestContext): Promise<ConstructionServer> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-telemetry-'));
  const server = await ConstructionServer.open(join(directory, 'telemetry.sqlite'));
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return server;
}

function context(actorId = PLAYER, nowHour = 10): CommandContext {
  return { actorId, nowHour };
}

function event(overrides: Partial<ClientEventInput> = {}): ClientEventInput {
  return {
    id: `e:${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
    sessionId: SESSION,
    name: 'command_attempt',
    subject: 'build',
    clientSeq: 0,
    ...overrides,
  };
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

test('계측 이벤트를 배치로 저장하고 깔때기로 집계한다', async (t) => {
  const server = await open(t);
  const result = await server.recordClientEvents(context(), [
    event({ name: 'session_start', subject: undefined, clientSeq: 0 }),
    event({ name: 'screen_view', subject: 'city', clientSeq: 1 }),
    event({ name: 'command_attempt', subject: 'build', clientSeq: 2 }),
    event({ name: 'command_success', subject: 'build', clientSeq: 3 }),
    event({ name: 'command_rejected', subject: 'attack', outcome: 'RECON_EXPIRED', clientSeq: 4 }),
  ]);
  assert.deepEqual(result, { received: 5, stored: 5 });

  const funnel = await server.listFunnel();
  const rejected = funnel.find((row) => row.name === 'command_rejected');
  assert.equal(rejected?.subject, 'attack');
  assert.equal(rejected?.outcome, 'RECON_EXPIRED');
  assert.equal(rejected?.events, 1);
  assert.equal(rejected?.sessions, 1);
  const total = funnel.reduce((sum, row) => sum + row.events, 0);
  assert.equal(total, 5);
});

test('같은 이벤트 ID 재전송은 한 번만 저장된다 (멱등)', async (t) => {
  const server = await open(t);
  const batch = [event({ id: 'e:duplicate-check-01', clientSeq: 0 })];
  assert.deepEqual(await server.recordClientEvents(context(), batch), { received: 1, stored: 1 });
  assert.deepEqual(await server.recordClientEvents(context(), batch), { received: 1, stored: 0 });
  const funnel = await server.listFunnel();
  assert.equal(funnel.reduce((sum, row) => sum + row.events, 0), 1);
});

test('허용 목록 밖 값과 형식 오류를 거부한다', async (t) => {
  const server = await open(t);
  const bad: unknown[] = [
    event({ name: 'hacked' as never }),
    event({ subject: 'secret' as never }),
    event({ outcome: '사용자 입력 텍스트' }),
    event({ outcome: 'lowercase' }),
    event({ id: 'short' }),
    event({ sessionId: 'tiny' }),
    event({ clientSeq: -1 }),
    event({ clientSeq: 1.5 }),
    { ...event(), extra: 1 },
    [],
    null,
  ];
  for (const value of bad) {
    await expectCode(
      () => server.recordClientEvents(context(), [value as ClientEventInput]),
      'INVALID_EVENT',
    );
  }
  // 배치 크기 제한
  await expectCode(() => server.recordClientEvents(context(), []), 'INVALID_EVENT');
  const oversized = Array.from({ length: 51 }, (_, index) => event({ clientSeq: index }));
  await expectCode(() => server.recordClientEvents(context(), oversized), 'INVALID_EVENT');
  assert.deepEqual(await server.listFunnel(), [], '거부된 배치는 아무것도 저장하지 않는다.');
});

test('주체는 context에서만 오고 payload로 위조할 수 없다', async (t) => {
  const server = await open(t);
  // actorId 필드는 허용 목록에 없으므로 거부된다.
  await expectCode(
    () => server.recordClientEvents(
      context(),
      [{ ...event(), actorId: ADMIN } as unknown as ClientEventInput],
    ),
    'INVALID_EVENT',
  );
});

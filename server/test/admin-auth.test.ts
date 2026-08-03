import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  CONSTRUCTION_WORKER_ID,
  ConstructionServer,
  ServerError,
} from '../src/index.js';
import type {
  CommandContext,
  ConstructionServerOptions,
} from '../src/index.js';

const OWNER = 'user:alpha';
const CITY = 'city:alpha';
const WORKER = 'worker:alpha';
const ADMIN = 'admin:ops';

interface Fixture {
  readonly databasePath: string;
  open(options?: ConstructionServerOptions): Promise<ConstructionServer>;
  close(server: ConstructionServer): Promise<void>;
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-admin-auth-'));
  const databasePath = join(directory, 'admin.sqlite');
  const openServers = new Set<ConstructionServer>();

  t.after(async () => {
    for (const server of openServers) await server.close();
    openServers.clear();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  });

  return {
    databasePath,
    async open(options = {}) {
      const server = await ConstructionServer.open(databasePath, options);
      openServers.add(server);
      return server;
    },
    async close(server) {
      if (!openServers.delete(server)) return;
      await server.close();
    },
  };
}

function context(actorId: string, nowHour: number): CommandContext {
  return { actorId, nowHour };
}

async function expectCode(operation: () => unknown, code: ServerError['code']): Promise<ServerError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ServerError, `expected ServerError ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

/** maxAttempts 1 정책에서 claim 후 무보고 crash → 스캔 dead letter 전환으로 dead job을 만든다. */
async function makeDeadJob(server: ConstructionServer): Promise<{ jobId: string; dueHour: number }> {
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: { hq: 2 } });
  const started = await server.startConstruction(
    context(OWNER, 10),
    { commandId: 'start:farm:1', cityId: CITY, expectedVersion: 0, buildingId: 'farm' },
  );
  const dueHour = started.response.completesAtHour;
  await server.claimDueConstructionJobs(context(WORKER, dueHour), { limit: 10 });
  const scan = await server.claimDueConstructionJobs(context('worker:beta', dueHour + 1), { limit: 10 });
  assert.deepEqual(scan.deadLettered, [started.response.jobId]);
  return { jobId: started.response.jobId, dueHour };
}

test('requeueDeadJob은 감사 기록과 함께 재가동하고 다음 스캔이 attempt 1부터 완료한다', async (t) => {
  const db = fixture(t);
  const server = await db.open({ jobPolicy: { maxAttempts: 1 } });
  const { jobId, dueHour } = await makeDeadJob(server);

  const dead = await server.listDeadJobs();
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.jobId, jobId);
  assert.equal(dead[0]?.cityId, CITY);
  assert.equal(dead[0]?.buildingId, 'farm');
  assert.equal(dead[0]?.targetLevel, 2);

  const result = await server.requeueDeadJob(
    context(ADMIN, dueHour + 2),
    { jobId, reason: '근본 원인 수정 후 재가동' },
  );
  assert.deepEqual(result, { jobId, priorAttempts: 1, requeued: true });
  assert.deepEqual(await server.listJobClaims(), [], '재가동은 claim을 제거해야 한다.');
  assert.deepEqual(await server.listDeadJobs(), []);

  const actions = await server.listAdminActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.actorId, ADMIN);
  assert.equal(actions[0]?.action, 'requeue_dead_job');
  assert.equal(actions[0]?.target, jobId);
  assert.equal(actions[0]?.reason, '근본 원인 수정 후 재가동');
  assert.equal(actions[0]?.atHour, dueHour + 2);
  assert.match(actions[0]?.priorState ?? '', /"state":"dead"/);
  assert.match(actions[0]?.priorState ?? '', /"attemptCount":1/);

  // 재가동 후 스캔은 attempt 1부터 다시 시작하고 완료는 한 번만 적용된다.
  const reclaimed = await server.claimDueConstructionJobs(context(WORKER, dueHour + 2), { limit: 10 });
  assert.equal(reclaimed.claimed[0]?.attempt, 1);
  await server.completeConstruction(
    context(CONSTRUCTION_WORKER_ID, dueHour + 2),
    { commandId: 'complete:requeued', jobId },
  );
  const city = await server.getCity(CITY);
  assert.equal(city.buildings.farm, 2);
  assert.equal(city.completionEffectCount, 1);
});

test('requeue는 admin 전용이고 dead가 아닌 claim·형식 오류를 거부하며 상태를 바꾸지 않는다', async (t) => {
  const db = fixture(t);
  const server = await db.open();
  await server.seedCity({ cityId: CITY, ownerId: OWNER, buildings: { hq: 2 } });
  const started = await server.startConstruction(
    context(OWNER, 10),
    { commandId: 'start:farm:1', cityId: CITY, expectedVersion: 0, buildingId: 'farm' },
  );
  const jobId = started.response.jobId;
  const dueHour = started.response.completesAtHour;
  await server.claimDueConstructionJobs(context(WORKER, dueHour), { limit: 10 });

  await expectCode(
    async () => await server.requeueDeadJob(context(OWNER, dueHour), { jobId, reason: 'x' }),
    'FORBIDDEN',
  );
  await expectCode(
    async () => await server.requeueDeadJob(context(WORKER, dueHour), { jobId, reason: 'x' }),
    'FORBIDDEN',
  );
  await expectCode(
    async () => await server.requeueDeadJob(context(ADMIN, dueHour), { jobId, reason: 'x' }),
    'NOT_DEAD_LETTER',
  );
  await expectCode(
    async () => await server.requeueDeadJob(context(ADMIN, dueHour), { jobId: 'job:missing', reason: 'x' }),
    'NOT_FOUND',
  );
  await expectCode(
    async () => await server.requeueDeadJob(context(ADMIN, dueHour), { jobId, reason: '' }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await server.requeueDeadJob(
      context(ADMIN, dueHour),
      { jobId, reason: 'x', extra: 1 } as never,
    ),
    'INVALID_INPUT',
  );
  assert.equal((await server.listJobClaims()).length, 1, '거부는 claim을 바꾸지 않아야 한다.');
  assert.deepEqual(await server.listAdminActions(), [], '거부는 감사 행을 남기지 않아야 한다.');
});

test('토큰 발급·인증·폐기: 원문 미저장, 미지·폐기 토큰 동일 메시지 401, 감사 기록', async (t) => {
  const db = fixture(t);
  const server = await db.open();

  const issued = await server.issueToken(
    context(ADMIN, 10),
    { actorId: OWNER, role: 'player', reason: '초기 발급' },
  );
  assert.equal(issued.actorId, OWNER);
  assert.equal(issued.role, 'player');
  assert.match(issued.token, /^[0-9a-f]{64}$/);
  assert.match(issued.tokenSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.token, issued.tokenSha256);

  // DB에는 해시만 저장된다 — 원문 토큰이 어디에도 없어야 한다.
  await db.close(server);
  const raw = new DatabaseSync(db.databasePath, { enableForeignKeyConstraints: true });
  try {
    const rows = raw.prepare('SELECT token_sha256 FROM auth_tokens').all() as { token_sha256: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.token_sha256, issued.tokenSha256);
    assert.notEqual(rows[0]?.token_sha256, issued.token);
  } finally {
    raw.close();
  }
  const reopened = await db.open();

  const actor = await reopened.authenticateToken(issued.token);
  assert.deepEqual(actor, { actorId: OWNER, role: 'player', tokenSha256: issued.tokenSha256 });

  const unknownError = await expectCode(async () => await reopened.authenticateToken('f'.repeat(64)), 'UNAUTHORIZED');
  await expectCode(async () => await reopened.authenticateToken(''), 'UNAUTHORIZED');
  await expectCode(async () => await reopened.authenticateToken(null), 'UNAUTHORIZED');

  const revoked = await reopened.revokeToken(
    context(ADMIN, 11),
    { tokenSha256: issued.tokenSha256, reason: '유출 의심' },
  );
  assert.deepEqual(revoked, { tokenSha256: issued.tokenSha256, revoked: true });
  const revokedError = await expectCode(async () => await reopened.authenticateToken(issued.token), 'UNAUTHORIZED');
  assert.equal(
    revokedError.message,
    unknownError.message,
    '미지·폐기 토큰은 같은 메시지로 거부해 존재를 노출하지 않는다.',
  );

  // 폐기는 멱등이고, 발급·폐기가 감사에 남는다.
  assert.deepEqual(
    await reopened.revokeToken(context(ADMIN, 12), { tokenSha256: issued.tokenSha256, reason: '중복 폐기' }),
    { tokenSha256: issued.tokenSha256, revoked: true },
  );
  const actions = await reopened.listAdminActions();
  assert.deepEqual(actions.map((action) => action.action), ['issue_token', 'revoke_token']);
  assert.equal(actions[0]?.target, `player:${OWNER}`);
  assert.equal(actions[1]?.target, `player:${OWNER}`);

  await expectCode(
    async () => await reopened.issueToken(context(OWNER, 10), { actorId: OWNER, role: 'player', reason: 'x' }),
    'FORBIDDEN',
  );
  await expectCode(
    async () => await reopened.issueToken(context(ADMIN, 10), { actorId: OWNER, role: 'root' as never, reason: 'x' }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await reopened.revokeToken(context(ADMIN, 10), { tokenSha256: 'short', reason: 'x' }),
    'INVALID_INPUT',
  );
  await expectCode(
    async () => await reopened.revokeToken(context(ADMIN, 10), { tokenSha256: 'a'.repeat(64), reason: 'x' }),
    'NOT_FOUND',
  );
});

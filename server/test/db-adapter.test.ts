import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { ServerError } from '../src/errors.js';

async function openWithProbeTable(t: TestContext): Promise<SqliteAdapter> {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-adapter-'));
  const adapter = await SqliteAdapter.open(join(directory, 'adapter.sqlite'));
  // 삭제 전에 반드시 close되도록 정리를 한 훅으로 묶는다(Windows EPERM 방지).
  t.after(async () => {
    await adapter.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  await adapter.run('CREATE TABLE adapter_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  return adapter;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('어댑터 계약: 위치 파라미터·changes·get/all 반환', async (t) => {
  const adapter = await openWithProbeTable(t);
  assert.equal(adapter.kind, 'sqlite');
  assert.match(await adapter.backendVersion(), /^\d+\.\d+/);

  const insert = await adapter.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 1, 'one');
  assert.equal(insert.changes, 1);
  await adapter.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 2, 'two');

  const row = await adapter.get<{ value: string }>('SELECT value FROM adapter_probe WHERE id = ?', 1);
  assert.equal(row?.value, 'one');
  assert.equal(await adapter.get('SELECT value FROM adapter_probe WHERE id = ?', 99), undefined);

  const rows = await adapter.all<{ id: number }>('SELECT id FROM adapter_probe ORDER BY id');
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);

  const update = await adapter.run('UPDATE adapter_probe SET value = ? WHERE id = ?', 'ONE', 1);
  assert.equal(update.changes, 1);
  const noop = await adapter.run('UPDATE adapter_probe SET value = ? WHERE id = ?', 'x', 99);
  assert.equal(noop.changes, 0);
});

test('어댑터 계약: 트랜잭션 콜백 예외는 전체 rollback하고 원래 예외를 던진다', async (t) => {
  const adapter = await openWithProbeTable(t);

  await assert.rejects(
    adapter.transaction(async (tx) => {
      await tx.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 1, 'will-rollback');
      const mid = await tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM adapter_probe');
      assert.equal(mid?.count, 1, '트랜잭션 안에서는 자신의 쓰기가 보여야 한다.');
      throw new Error('강제 실패');
    }),
    /강제 실패/,
  );

  assert.equal(adapter.isTransaction, false, 'rollback 후 트랜잭션이 남으면 안 된다.');
  const after = await adapter.get<{ count: number }>('SELECT COUNT(*) AS count FROM adapter_probe');
  assert.equal(after?.count, 0, 'rollback으로 쓰기가 사라져야 한다.');

  // 실패 후 어댑터는 계속 사용 가능하다.
  await adapter.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 2, 'after-rollback');
  assert.equal((await adapter.all('SELECT id FROM adapter_probe')).length, 1);
});

test('어댑터 계약: 동시 트랜잭션·단문은 인터리브되지 않고 순서대로 직렬화된다', async (t) => {
  const adapter = await openWithProbeTable(t);
  const events: string[] = [];

  // 트랜잭션 A는 콜백 중간에 이벤트 루프를 양보한다(비동기 인터리브 유도).
  const a = adapter.transaction(async (tx) => {
    events.push('a:start');
    await tx.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 1, 'a1');
    await sleep(30);
    await tx.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 2, 'a2');
    events.push('a:end');
  });
  // A가 진행 중일 때 단문과 트랜잭션 B를 쏜다 — 모두 A 완료 후에 실행되어야 한다.
  const single = adapter.get<{ count: number }>('SELECT COUNT(*) AS count FROM adapter_probe')
    .then((row) => {
      events.push(`single:sees=${row?.count}`);
      return row?.count;
    });
  const b = adapter.transaction(async (tx) => {
    events.push('b:start');
    const row = await tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM adapter_probe');
    events.push(`b:sees=${row?.count}`);
  });

  await Promise.all([a, single, b]);
  assert.deepEqual(
    events,
    ['a:start', 'a:end', 'single:sees=2', 'b:start', 'b:sees=2'],
    'A의 부분 상태(1행)를 관찰하는 실행이 있어서는 안 된다.',
  );
});

test('어댑터 계약: close 이후 접근은 거부되고 재호출은 안전하다', async (t) => {
  const adapter = await openWithProbeTable(t);
  await adapter.close();
  await adapter.close();
  await assert.rejects(
    adapter.run('INSERT INTO adapter_probe(id, value) VALUES (?, ?)', 1, 'x'),
    (error: unknown) => error instanceof ServerError && error.code === 'DATABASE_FAILURE',
  );
  await assert.rejects(adapter.get('SELECT 1'), (error: unknown) => error instanceof ServerError);
  await assert.rejects(
    adapter.transaction(async () => undefined),
    (error: unknown) => error instanceof ServerError && error.code === 'DATABASE_FAILURE',
  );
});

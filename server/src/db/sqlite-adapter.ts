import { DatabaseSync } from 'node:sqlite';
import { ServerError } from '../errors.js';
import { MIGRATIONS, SERVER_SCHEMA_VERSION } from '../database.js';
import type { SqlAdapter, SqlExecutor, SqlRunResult, SqlValue } from './adapter.js';

/**
 * node:sqlite 어댑터 — SqlAdapter 계약의 유일한 검증 구현(D-022).
 * 커넥션은 프로세스당 하나이며, 비동기 락으로 모든 문장·트랜잭션을 직렬화한다.
 * 동기 시절에는 불가능했던 "HTTP 핸들러와 데몬 tick이 한 커넥션에 문장을 끼워 넣는"
 * 인터리브를 이 락이 막는다.
 */

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database(?: schema)? is locked|SQLITE_BUSY/i.test(message);
}

function waitForRetry(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(gate, 0, 0, milliseconds);
}

function rollbackQuietly(database: DatabaseSync): void {
  if (!database.isTransaction) return;
  try {
    database.exec('ROLLBACK');
  } catch {
    // 원래 예외를 보존한다. 닫힌/손상 연결은 호출자가 폐기한다.
  }
}

function enableWal(database: DatabaseSync, busyTimeoutMs: number): void {
  const deadline = Date.now() + busyTimeoutMs;
  let lastError: unknown;
  do {
    try {
      const row = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (row.journal_mode.toLowerCase() === 'wal') return;
      lastError = new Error(`journal_mode=${row.journal_mode}`);
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    waitForRetry(Math.min(25, remaining));
  } while (true);
  if (isSqliteBusy(lastError)) {
    throw new ServerError('DB_BUSY_RETRYABLE', 'SQLite WAL 초기화 잠금 시간 초과', {
      cause: lastError,
      retryable: true,
    });
  }
  throw new ServerError('DATABASE_FAILURE', 'SQLite WAL 모드를 활성화하지 못했다.', {
    cause: lastError,
  });
}

function assertSupportedSchemaBeforeMutation(database: DatabaseSync): void {
  const userVersionRow = database.prepare('PRAGMA user_version').get() as { user_version: number };
  const migrationTable = database.prepare(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() as { present: number } | undefined;
  let recordedVersion = 0;
  if (migrationTable) {
    const recordedRow = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    recordedVersion = recordedRow.version ?? 0;
  }
  const userVersion = userVersionRow.user_version;
  if (userVersion > SERVER_SCHEMA_VERSION || recordedVersion > SERVER_SCHEMA_VERSION) {
    throw new ServerError(
      'UNSUPPORTED_SCHEMA',
      `지원하지 않는 스키마 버전: user=${userVersion}, recorded=${recordedVersion}`,
    );
  }
  if (userVersion !== recordedVersion) {
    throw new ServerError('DATA_INTEGRITY', 'PRAGMA user_version과 migration 기록이 일치하지 않는다.');
  }
}

function migrate(database: DatabaseSync): void {
  /**
   * 테이블 재구축 마이그레이션(예: CHECK 제약 확대)은 부모 테이블을 DROP해야 하고,
   * 외래키가 켜져 있으면 자식 참조 때문에 실패한다. `PRAGMA foreign_keys`는
   * **트랜잭션 안에서 무효**이므로 여기서, 즉 BEGIN 앞에서 끈다(SQLite 권장 절차).
   * 커밋 뒤 다시 켜고 `foreign_key_check`로 참조 무결성을 반드시 확인한다 —
   * 검사를 건너뛰면 끊어진 참조가 조용히 남는다.
   */
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK(version >= 1),
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const userVersionRow = database.prepare('PRAGMA user_version').get() as { user_version: number };
    const recordedRow = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    const userVersion = userVersionRow.user_version;
    const recordedVersion = recordedRow.version ?? 0;
    if (userVersion > SERVER_SCHEMA_VERSION || recordedVersion > SERVER_SCHEMA_VERSION) {
      throw new ServerError(
        'UNSUPPORTED_SCHEMA',
        `지원하지 않는 스키마 버전: user=${userVersion}, recorded=${recordedVersion}`,
      );
    }
    if (userVersion !== recordedVersion) {
      throw new ServerError('DATA_INTEGRITY', 'PRAGMA user_version과 migration 기록이 일치하지 않는다.');
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= recordedVersion) continue;
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, '2026-07-19');
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(database);
    database.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
  database.exec('PRAGMA foreign_keys = ON');
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new ServerError(
      'DATA_INTEGRITY',
      `마이그레이션 후 외래키 위반이 ${violations.length}건 남았다.`,
    );
  }
}

function openRawDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: busyTimeoutMs,
    defensive: true,
  });
  try {
    assertSupportedSchemaBeforeMutation(database);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA synchronous = FULL');
    if (path !== ':memory:') {
      enableWal(database, busyTimeoutMs);
    }
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof ServerError) throw error;
    if (isSqliteBusy(error)) {
      throw new ServerError('DB_BUSY_RETRYABLE', 'SQLite 초기화 또는 마이그레이션 잠금 시간 초과', {
        cause: error,
        retryable: true,
      });
    }
    throw new ServerError('DATABASE_FAILURE', 'SQLite 초기화 또는 마이그레이션에 실패했다.', {
      cause: error,
    });
  }
}

export class SqliteAdapter implements SqlAdapter {
  readonly kind = 'sqlite' as const;
  private readonly database: DatabaseSync;
  /** 문장·트랜잭션 직렬화용 비동기 락(체인) */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async open(path: string, busyTimeoutMs = 2_000): Promise<SqliteAdapter> {
    if (typeof path !== 'string' || path.length === 0) {
      throw new ServerError('INVALID_INPUT', 'databasePath가 필요하다.');
    }
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000) {
      throw new ServerError('INVALID_INPUT', 'busyTimeoutMs는 0..30000 정수여야 한다.');
    }
    return new SqliteAdapter(openRawDatabase(path, busyTimeoutMs));
  }

  get isTransaction(): boolean {
    return this.database.isTransaction;
  }

  private withLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(() => {
      if (this.closed) {
        throw new ServerError('DATABASE_FAILURE', '닫힌 어댑터에 접근했다.');
      }
      return operation();
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 락을 이미 보유한 문맥(트랜잭션 콜백)용 실행기 — 재획득하지 않는다. */
  private unlockedExecutor(): SqlExecutor {
    return {
      run: (sql: string, ...params: SqlValue[]): Promise<SqlRunResult> => {
        const result = this.database.prepare(sql).run(...params);
        return Promise.resolve({ changes: Number(result.changes) });
      },
      get: <T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> =>
        Promise.resolve(this.database.prepare(sql).get(...params) as T | undefined),
      all: <T>(sql: string, ...params: SqlValue[]): Promise<T[]> =>
        Promise.resolve(this.database.prepare(sql).all(...params) as unknown as T[]),
    };
  }

  run(sql: string, ...params: SqlValue[]): Promise<SqlRunResult> {
    return this.withLock(() => {
      const result = this.database.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    });
  }

  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.withLock(() => this.database.prepare(sql).get(...params) as T | undefined);
  }

  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.withLock(() => this.database.prepare(sql).all(...params) as unknown as T[]);
  }

  transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      try {
        this.database.exec('BEGIN IMMEDIATE');
        const value = await operation(this.unlockedExecutor());
        this.database.exec('COMMIT');
        return value;
      } catch (error) {
        rollbackQuietly(this.database);
        if (isSqliteBusy(error)) {
          throw new ServerError('DB_BUSY_RETRYABLE', 'SQLite 쓰기 잠금 시간 초과', {
            cause: error,
            retryable: true,
          });
        }
        throw error;
      }
    });
  }

  backendVersion(): Promise<string> {
    return this.withLock(() => {
      const row = this.database.prepare('SELECT sqlite_version() AS version').get() as { version: string };
      return row.version;
    });
  }

  close(): Promise<void> {
    const result = this.chain.then(() => {
      if (this.closed) return;
      this.closed = true;
      this.database.close();
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * DB 어댑터 경계 — 도메인 로직은 이 인터페이스만 사용한다(D-022).
 *
 * PostgreSQL 이식 계약(어댑터 구현이 지켜야 하는 것):
 * - 플레이스홀더는 `?` 위치 기반이다. PG 어댑터는 내부에서 `$1..$n`으로 번역한다.
 * - 파라미터·결과 값은 null | number(안전 정수·유한 실수) | string 만 쓴다.
 *   boolean은 0/1 정수, 시각은 정수 hour, 금액은 정수 micro다. bigint·Buffer·Date 금지.
 * - `transaction`은 쓰기 직렬화 트랜잭션이다(SQLite BEGIN IMMEDIATE, PG는 커넥션 전용
 *   BEGIN + 필요한 잠금 수준). 콜백 예외 시 전체 rollback 후 원래 예외를 던진다.
 * - 한 어댑터 인스턴스의 문장과 트랜잭션은 어떤 경우에도 인터리브되지 않는다
 *   (비동기 호출자 다수가 한 인스턴스를 공유해도 안전해야 한다).
 * - 잠금·경합 오류는 ServerError('DB_BUSY_RETRYABLE', retryable: true)로 매핑한다.
 * - DDL·마이그레이션 SQL은 방언별로 어댑터 구현이 소유한다(공유하지 않는다).
 */

export type SqlValue = null | number | string;

export interface SqlRunResult {
  readonly changes: number;
}

export interface SqlExecutor {
  run(sql: string, ...params: SqlValue[]): Promise<SqlRunResult>;
  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}

export interface SqlAdapter extends SqlExecutor {
  readonly kind: 'sqlite' | 'postgres';
  /** 현재 이 어댑터가 트랜잭션 안에 있는지(테스트·불변식 확인용) */
  readonly isTransaction: boolean;
  /**
   * 쓰기 직렬화 트랜잭션. 콜백에는 잠금을 재획득하지 않는 실행기가 전달된다.
   * 콜백 안에서 어댑터 자신을 다시 호출하면 교착이므로 반드시 tx 인자만 사용한다.
   */
  transaction<T>(operation: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** 저장 엔진 버전 문자열(관측용) */
  backendVersion(): Promise<string>;
  close(): Promise<void>;
}

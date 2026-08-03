/**
 * SQLite 방언 마이그레이션 모듈. 접속·트랜잭션은 `db/sqlite-adapter.ts`가 소유한다(D-022).
 * DDL은 방언별 소유 원칙에 따라 PostgreSQL 어댑터가 생기면 그쪽이 자체 DDL을 갖는다.
 * 배포된 버전의 SQL은 변경하지 않고 새 버전을 추가한다(QUALITY_GATES).
 */

export const SERVER_SCHEMA_VERSION = 12;

const MIGRATION_V1 = `
  CREATE TABLE cities (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
    owner_id TEXT NOT NULL UNIQUE CHECK(length(owner_id) BETWEEN 1 AND 64),
    rule_version TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 2147483647),
    last_server_hour INTEGER NOT NULL CHECK(last_server_hour BETWEEN 0 AND 10000000)
  ) STRICT;

  CREATE TABLE city_resources (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    balance_micro INTEGER NOT NULL CHECK(balance_micro BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(city_id, resource_id)
  ) STRICT;

  CREATE TABLE city_buildings (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    building_id TEXT NOT NULL CHECK(building_id IN ('hq','farm','steel_mill','refinery','supply_depot','housing','warehouse')),
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 100),
    PRIMARY KEY(city_id, building_id)
  ) STRICT;

  CREATE TABLE construction_jobs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    building_id TEXT NOT NULL CHECK(building_id IN ('hq','farm','steel_mill','refinery','supply_depot','housing','warehouse')),
    target_level INTEGER NOT NULL CHECK(target_level BETWEEN 2 AND 100),
    rule_version TEXT NOT NULL,
    started_at_hour INTEGER NOT NULL CHECK(started_at_hour BETWEEN 0 AND 10000000),
    completes_at_hour INTEGER NOT NULL CHECK(completes_at_hour BETWEEN started_at_hour AND 20000000),
    effective_at_hour INTEGER,
    processed_at_hour INTEGER,
    status TEXT NOT NULL CHECK(status IN ('pending','completed')),
    CHECK(
      (status = 'pending' AND effective_at_hour IS NULL AND processed_at_hour IS NULL)
      OR (
        status = 'completed'
        AND effective_at_hour IS NOT NULL
        AND processed_at_hour IS NOT NULL
        AND effective_at_hour = completes_at_hour
        AND processed_at_hour >= effective_at_hour
        AND processed_at_hour <= 20000000
      )
    )
  ) STRICT;

  CREATE UNIQUE INDEX one_pending_construction_per_building
    ON construction_jobs(city_id, building_id) WHERE status = 'pending';

  CREATE TABLE economy_ledger (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES construction_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    reason TEXT NOT NULL CHECK(reason = 'construction_start'),
    delta_micro INTEGER NOT NULL CHECK(delta_micro BETWEEN -9007199254740991 AND -1),
    balance_before_micro INTEGER NOT NULL CHECK(balance_before_micro BETWEEN 0 AND 9007199254740991),
    balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro BETWEEN 0 AND 9007199254740991),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 10000000),
    CHECK(balance_after_micro = balance_before_micro + delta_micro),
    UNIQUE(city_id, command_id, resource_id)
  ) STRICT;

  CREATE TABLE command_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(command_kind IN ('start_construction','complete_construction')),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 10000000),
    PRIMARY KEY(actor_id, command_id)
  ) STRICT;

  CREATE TABLE completion_effects (
    job_id TEXT PRIMARY KEY REFERENCES construction_jobs(id) ON DELETE RESTRICT,
    effect_key TEXT NOT NULL UNIQUE,
    command_id TEXT NOT NULL,
    city_version INTEGER NOT NULL CHECK(city_version BETWEEN 1 AND 2147483647),
    response_json TEXT NOT NULL,
    effective_at_hour INTEGER NOT NULL CHECK(effective_at_hour BETWEEN 0 AND 20000000),
    processed_at_hour INTEGER NOT NULL CHECK(processed_at_hour BETWEEN effective_at_hour AND 20000000)
  ) STRICT;
`;

/**
 * v2: due-job claim/lease·재시도·dead letter.
 * construction_jobs.status CHECK를 재구축하지 않기 위해 claim 상태는 별도 테이블로 표현한다(expand only).
 * claim은 중복 작업 방지 장치이며 완료 멱등성 권위는 여전히 receipt·completion effect다.
 */
const MIGRATION_V2 = `
  CREATE TABLE job_claims (
    job_id TEXT PRIMARY KEY REFERENCES construction_jobs(id) ON DELETE RESTRICT,
    worker_id TEXT NOT NULL CHECK(worker_id LIKE 'worker:%' AND length(worker_id) BETWEEN 8 AND 64),
    state TEXT NOT NULL CHECK(state IN ('leased','dead')),
    attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 1000),
    claimed_at_hour INTEGER NOT NULL CHECK(claimed_at_hour BETWEEN 0 AND 20000000),
    lease_until_hour INTEGER NOT NULL CHECK(lease_until_hour BETWEEN claimed_at_hour AND 20000000),
    last_error TEXT CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 200)
  ) STRICT;

  CREATE INDEX job_claims_reclaim_scan ON job_claims(state, lease_until_hour);
`;

/**
 * v3: 운영 감사(admin_actions)와 토큰 인증(auth_tokens). additive only.
 * 토큰 원문은 저장하지 않는다 — sha256 해시만 저장한다(ENGINEERING_RULES 보안).
 */
const MIGRATION_V3 = `
  CREATE TABLE admin_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL CHECK(actor_id LIKE 'admin:%' AND length(actor_id) BETWEEN 7 AND 64),
    action TEXT NOT NULL CHECK(action IN ('requeue_dead_job','issue_token','revoke_token')),
    target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 96),
    reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
    at_hour INTEGER NOT NULL CHECK(at_hour BETWEEN 0 AND 20000000),
    prior_state TEXT
  ) STRICT;

  CREATE TABLE auth_tokens (
    token_sha256 TEXT PRIMARY KEY CHECK(length(token_sha256) = 64),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    role TEXT NOT NULL CHECK(role IN ('player','admin','worker')),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
  ) STRICT;

  CREATE INDEX auth_tokens_actor ON auth_tokens(actor_id);
`;

/**
 * v4: 플레이어블 첫 루프(D-023)의 병력·정찰·전투 영속 상태.
 * 기존 건설 receipt/ledger의 CHECK를 넓히기 위해 테이블을 재구축하지 않고,
 * 작전 명령용 영수증·원장을 별도 additive table로 둔다.
 */
const MIGRATION_V4 = `
  CREATE TABLE city_armies (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL CHECK(unit_id IN (
      'rifle','at_infantry','scout','medium_tank','heavy_tank','howitzer',
      'at_gun','aa_gun','fighter','bomber','engineer','supply_truck'
    )),
    ready INTEGER NOT NULL DEFAULT 0 CHECK(ready BETWEEN 0 AND 2147483647),
    wounded INTEGER NOT NULL DEFAULT 0 CHECK(wounded BETWEEN 0 AND 2147483647),
    dead INTEGER NOT NULL DEFAULT 0 CHECK(dead BETWEEN 0 AND 2147483647),
    PRIMARY KEY(city_id, unit_id)
  ) STRICT;

  INSERT INTO city_armies(city_id, unit_id)
  SELECT cities.id, units.unit_id
  FROM cities
  CROSS JOIN (
    SELECT 'rifle' AS unit_id UNION ALL
    SELECT 'at_infantry' UNION ALL
    SELECT 'scout' UNION ALL
    SELECT 'medium_tank' UNION ALL
    SELECT 'heavy_tank' UNION ALL
    SELECT 'howitzer' UNION ALL
    SELECT 'at_gun' UNION ALL
    SELECT 'aa_gun' UNION ALL
    SELECT 'fighter' UNION ALL
    SELECT 'bomber' UNION ALL
    SELECT 'engineer' UNION ALL
    SELECT 'supply_truck'
  ) AS units;

  CREATE TABLE operation_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(command_kind IN ('mobilize_units','recon_npc','attack_npc')),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(actor_id, command_id),
    UNIQUE(city_id, command_id)
  ) STRICT;

  CREATE INDEX operation_receipts_city
    ON operation_receipts(city_id, created_at_hour, command_id);

  CREATE TABLE operation_ledger (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    reason TEXT NOT NULL CHECK(reason IN ('mobilization','recon','sortie','victory_reward')),
    delta_micro INTEGER NOT NULL CHECK(
      delta_micro BETWEEN -9007199254740991 AND 9007199254740991
      AND delta_micro <> 0
    ),
    balance_before_micro INTEGER NOT NULL CHECK(balance_before_micro BETWEEN 0 AND 9007199254740991),
    balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro BETWEEN 0 AND 9007199254740991),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    CHECK(balance_after_micro = balance_before_micro + delta_micro),
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id, reason, resource_id)
  ) STRICT;

  CREATE INDEX operation_ledger_city
    ON operation_ledger(city_id, created_at_hour, id);

  CREATE TABLE recon_reports (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    scenario_id TEXT NOT NULL CHECK(length(scenario_id) BETWEEN 1 AND 64),
    accuracy_permille INTEGER NOT NULL CHECK(accuracy_permille BETWEEN 0 AND 1000),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    expires_at_hour INTEGER NOT NULL CHECK(
      expires_at_hour BETWEEN created_at_hour AND 20000000
    ),
    report_json TEXT NOT NULL,
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id)
  ) STRICT;

  CREATE INDEX recon_reports_active
    ON recon_reports(city_id, scenario_id, expires_at_hour, created_at_hour);

  CREATE TABLE npc_battle_reports (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    scenario_id TEXT NOT NULL CHECK(length(scenario_id) BETWEEN 1 AND 64),
    recon_report_id TEXT NOT NULL REFERENCES recon_reports(id) ON DELETE RESTRICT,
    seed INTEGER NOT NULL CHECK(seed BETWEEN 0 AND 4294967295),
    result_hash TEXT NOT NULL CHECK(length(result_hash) = 16),
    input_json TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id)
  ) STRICT;

  CREATE INDEX npc_battle_reports_city
    ON npc_battle_reports(city_id, created_at_hour, id);

  CREATE TRIGGER operation_receipt_global_key_guard
  BEFORE INSERT ON operation_receipts
  WHEN EXISTS (
    SELECT 1 FROM command_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;

  CREATE TRIGGER construction_receipt_global_key_guard
  BEFORE INSERT ON command_receipts
  WHEN EXISTS (
    SELECT 1 FROM operation_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;
`;

/**
 * v5: 경제 규칙과 캠페인 규칙 버전을 도시 수준에서 분리한다.
 * 기존 v1~v4 도시는 당시 유일했던 캠페인 0.1.0에 결속하고, 이후 도시는 명시적으로 선택한다.
 */
const MIGRATION_V5 = `
  ALTER TABLE cities
    ADD COLUMN campaign_rule_version TEXT NOT NULL DEFAULT '0.1.0';
`;


/**
 * v6: 첫 루프 외부 테스트 계측(client_events).
 * 열거값만 저장한다 — 자유 텍스트·이용자 입력·기기 정보를 받지 않는다.
 * 시각은 서버 권위 시간이며 클라이언트 시각은 저장하지 않는다.
 */
const MIGRATION_V6 = `
  CREATE TABLE client_events (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 96),
    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 8 AND 64),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK(name IN (
      'session_start','screen_view','command_attempt','command_success','command_rejected','report_view'
    )),
    subject TEXT CHECK(subject IS NULL OR subject IN (
      'city','operations','reports','connect','build','mobilize','recon','attack'
    )),
    outcome TEXT CHECK(outcome IS NULL OR (length(outcome) BETWEEN 1 AND 40 AND outcome GLOB '[A-Z_]*')),
    client_seq INTEGER NOT NULL CHECK(client_seq BETWEEN 0 AND 1000000),
    server_hour INTEGER NOT NULL CHECK(server_hour BETWEEN 0 AND 20000000)
  ) STRICT;

  CREATE INDEX client_events_session ON client_events(session_id, client_seq);
  CREATE INDEX client_events_funnel ON client_events(name, subject);
`;

/**
 * v7: 기기 계정(accounts). 스토어 배포에는 토큰 붙여넣기 대신 계정이 필요하다(D-039).
 *
 * 이메일·비밀번호·전화번호를 받지 않는다. 기기가 만든 무작위 비밀값의 sha256만 저장하며
 * 원문은 저장하지 않는다(auth_tokens와 같은 규칙). 따라서 개인식별정보를 수집하지 않는다.
 * 대가로 기기를 잃으면 계정도 잃는다 — 계정 이전은 별도 결정이 필요하다.
 */
const MIGRATION_V7 = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY CHECK(id LIKE 'user:%' AND length(id) BETWEEN 6 AND 64),
    device_sha256 TEXT NOT NULL UNIQUE CHECK(length(device_sha256) = 64),
    city_id TEXT NOT NULL UNIQUE REFERENCES cities(id) ON DELETE RESTRICT,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000)
  ) STRICT;
`;

/**
 * v8: 건물 id 허용 목록을 사양의 14종으로 넓힌다(D-043).
 *
 * SQLite는 CHECK 제약을 ALTER로 바꿀 수 없어 테이블을 재구축한다.
 * 데이터는 그대로 옮기고 제약만 넓히므로 기존 행은 모두 살아남는다 —
 * 어떤 도시가 실제로 갖는 건물 집합은 그 도시의 경제 규칙이 정하고, 이 목록은 형식 검증일 뿐이다.
 *
 * SQLite 권장 절차를 그대로 쓴다: 새 이름으로 만들고 → 복사 → 옛 테이블 DROP →
 * 새 테이블을 옛 이름으로 RENAME. 부모 테이블을 DROP하려면 외래키가 꺼져 있어야 하므로
 * 어댑터가 마이그레이션 동안만 끄고, 끝난 뒤 `foreign_key_check`로 무결성을 확인한다.
 *
 * 주의: 옛 테이블을 먼저 RENAME하면 안 된다 — 기본 모드의 RENAME은 다른 테이블의
 * 외래키 참조 문구까지 새 이름으로 바꾸므로 economy_ledger·completion_effects·job_claims의
 * 참조가 옮겨진 이름을 가리키게 되고, 그것을 지우면 참조가 끊긴다.
 */
const BUILDING_ID_CHECK = "building_id IN ("
  + "'hq','farm','steel_mill','refinery','supply_depot','housing','warehouse',"
  + "'barracks','arsenal','airfield','research_lab','radar','defense_hq','alliance_comms')";

const MIGRATION_V8 = `
  CREATE TABLE rebuilt_city_buildings (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    building_id TEXT NOT NULL CHECK(${BUILDING_ID_CHECK}),
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 100),
    PRIMARY KEY(city_id, building_id)
  ) STRICT;

  INSERT INTO rebuilt_city_buildings(city_id, building_id, level)
    SELECT city_id, building_id, level FROM city_buildings;

  DROP TABLE city_buildings;
  ALTER TABLE rebuilt_city_buildings RENAME TO city_buildings;

  CREATE TABLE rebuilt_construction_jobs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    building_id TEXT NOT NULL CHECK(${BUILDING_ID_CHECK}),
    target_level INTEGER NOT NULL CHECK(target_level BETWEEN 2 AND 100),
    rule_version TEXT NOT NULL,
    started_at_hour INTEGER NOT NULL CHECK(started_at_hour BETWEEN 0 AND 10000000),
    completes_at_hour INTEGER NOT NULL CHECK(completes_at_hour BETWEEN started_at_hour AND 20000000),
    effective_at_hour INTEGER,
    processed_at_hour INTEGER,
    status TEXT NOT NULL CHECK(status IN ('pending','completed')),
    CHECK(
      (status = 'pending' AND effective_at_hour IS NULL AND processed_at_hour IS NULL)
      OR (
        status = 'completed'
        AND effective_at_hour IS NOT NULL
        AND processed_at_hour IS NOT NULL
        AND effective_at_hour = completes_at_hour
        AND processed_at_hour >= effective_at_hour
        AND processed_at_hour <= 20000000
      )
    )
  ) STRICT;

  INSERT INTO rebuilt_construction_jobs(
    id, city_id, building_id, target_level, rule_version,
    started_at_hour, completes_at_hour, effective_at_hour, processed_at_hour, status
  )
    SELECT id, city_id, building_id, target_level, rule_version,
           started_at_hour, completes_at_hour, effective_at_hour, processed_at_hour, status
    FROM construction_jobs;

  DROP TABLE construction_jobs;
  ALTER TABLE rebuilt_construction_jobs RENAME TO construction_jobs;

  CREATE UNIQUE INDEX one_pending_construction_per_building
    ON construction_jobs(city_id, building_id) WHERE status = 'pending';
`;

/**
 * v9: 연구 상태(D-044). additive only — 기존 테이블을 건드리지 않는다.
 *
 * 한 도시가 연구 항목마다 도달한 단계를 기록한다. 단계는 1부터이며 행이 없으면 0단계다.
 * 연구 id는 경제 규칙이 정하므로 CHECK로 열거하지 않고 길이만 제한한다 —
 * 규칙 버전마다 항목이 달라지므로 스키마에 박으면 규칙을 늘릴 때마다 테이블을 재구축해야 한다.
 */
const MIGRATION_V9 = `
  CREATE TABLE city_research (
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    research_id TEXT NOT NULL CHECK(length(research_id) BETWEEN 1 AND 64),
    level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 100),
    completed_at_hour INTEGER NOT NULL CHECK(completed_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(city_id, research_id)
  ) STRICT;

  CREATE TABLE rebuilt_operation_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(
      command_kind IN ('mobilize_units','recon_npc','attack_npc','advance_research')
    ),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(actor_id, command_id),
    UNIQUE(city_id, command_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_receipts(
    actor_id, command_id, city_id, command_kind,
    payload_sha256, payload_json, response_json, created_at_hour
  )
    SELECT actor_id, command_id, city_id, command_kind,
           payload_sha256, payload_json, response_json, created_at_hour
    FROM operation_receipts;

  CREATE TABLE rebuilt_operation_ledger (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    reason TEXT NOT NULL CHECK(
      reason IN ('mobilization','recon','sortie','victory_reward','research')
    ),
    delta_micro INTEGER NOT NULL CHECK(
      delta_micro BETWEEN -9007199254740991 AND 9007199254740991
      AND delta_micro <> 0
    ),
    balance_before_micro INTEGER NOT NULL CHECK(balance_before_micro BETWEEN 0 AND 9007199254740991),
    balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro BETWEEN 0 AND 9007199254740991),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    CHECK(balance_after_micro = balance_before_micro + delta_micro),
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id, reason, resource_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_ledger(
    id, city_id, command_id, resource_id, reason, delta_micro,
    balance_before_micro, balance_after_micro, created_at_hour
  )
    SELECT id, city_id, command_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM operation_ledger;

  -- command_receipts에 걸린 트리거가 operation_receipts를 참조한다.
  -- 떼지 않으면 테이블을 지운 뒤 RENAME에서 트리거 검증이 실패한다.
  DROP TRIGGER construction_receipt_global_key_guard;

  DROP TABLE operation_ledger;
  DROP TABLE operation_receipts;
  ALTER TABLE rebuilt_operation_receipts RENAME TO operation_receipts;
  ALTER TABLE rebuilt_operation_ledger RENAME TO operation_ledger;

  CREATE INDEX operation_receipts_city
    ON operation_receipts(city_id, created_at_hour, command_id);
  CREATE INDEX operation_ledger_city
    ON operation_ledger(city_id, created_at_hour, id);

  CREATE TRIGGER operation_receipt_global_key_guard
  BEFORE INSERT ON operation_receipts
  WHEN EXISTS (
    SELECT 1 FROM command_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;

  CREATE TRIGGER construction_receipt_global_key_guard
  BEFORE INSERT ON command_receipts
  WHEN EXISTS (
    SELECT 1 FROM operation_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;
`;

/**
 * v10: 부상병 회복(D-045).
 *
 * `recovery_jobs`는 예약된 회복 1건이다. 예약 시 보급품을 이미 냈으므로 완료는 자원을 옮기지 않고
 * 부상 → 가용으로만 이동시킨다. 완료의 멱등성은 `status = 'pending'` 조건부 UPDATE가 보장한다 —
 * 같은 job을 두 번 완료해도 두 번째는 0행을 바꾼다.
 *
 * `operation_receipts.kind`와 `operation_ledger.reason`은 CHECK 재구축이 필요하며 v9와 같은 절차를 쓴다.
 */
const MIGRATION_V10 = `
  CREATE TABLE recovery_jobs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    unit_id TEXT NOT NULL CHECK(length(unit_id) BETWEEN 1 AND 64),
    count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 2147483647),
    started_at_hour INTEGER NOT NULL CHECK(started_at_hour BETWEEN 0 AND 20000000),
    completes_at_hour INTEGER NOT NULL CHECK(completes_at_hour BETWEEN 0 AND 20000000),
    status TEXT NOT NULL CHECK(status IN ('pending','completed')),
    completed_at_hour INTEGER CHECK(completed_at_hour BETWEEN 0 AND 20000000),
    -- 완료가 만든 도시 version. 스냅샷을 읽을 때 병력 이력을 시간순으로 재생하려면
    -- 완료도 영수증처럼 순서를 가져야 한다. 완료 전에는 NULL이다.
    completed_city_version INTEGER CHECK(completed_city_version BETWEEN 1 AND 2147483647),
    CHECK(completes_at_hour > started_at_hour),
    CHECK((status = 'pending') = (completed_at_hour IS NULL)),
    CHECK((status = 'pending') = (completed_city_version IS NULL)),
    UNIQUE(city_id, command_id, unit_id)
  ) STRICT;

  CREATE INDEX recovery_jobs_due ON recovery_jobs(completes_at_hour) WHERE status = 'pending';
  CREATE INDEX recovery_jobs_city ON recovery_jobs(city_id, status);

  CREATE TABLE rebuilt_operation_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(
      command_kind IN ('mobilize_units','recon_npc','attack_npc','advance_research','recover_units')
    ),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(actor_id, command_id),
    UNIQUE(city_id, command_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_receipts(
    actor_id, command_id, city_id, command_kind,
    payload_sha256, payload_json, response_json, created_at_hour
  )
    SELECT actor_id, command_id, city_id, command_kind,
           payload_sha256, payload_json, response_json, created_at_hour
    FROM operation_receipts;

  CREATE TABLE rebuilt_operation_ledger (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    reason TEXT NOT NULL CHECK(
      reason IN ('mobilization','recon','sortie','victory_reward','research','recovery')
    ),
    delta_micro INTEGER NOT NULL CHECK(
      delta_micro BETWEEN -9007199254740991 AND 9007199254740991
      AND delta_micro <> 0
    ),
    balance_before_micro INTEGER NOT NULL CHECK(balance_before_micro BETWEEN 0 AND 9007199254740991),
    balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro BETWEEN 0 AND 9007199254740991),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    CHECK(balance_after_micro = balance_before_micro + delta_micro),
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id, reason, resource_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_ledger(
    id, city_id, command_id, resource_id, reason, delta_micro,
    balance_before_micro, balance_after_micro, created_at_hour
  )
    SELECT id, city_id, command_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM operation_ledger;

  -- v9와 같은 이유로 트리거를 먼저 뗀다(command_receipts 트리거가 operation_receipts를 참조).
  DROP TRIGGER construction_receipt_global_key_guard;

  DROP TABLE operation_ledger;
  DROP TABLE operation_receipts;
  ALTER TABLE rebuilt_operation_receipts RENAME TO operation_receipts;
  ALTER TABLE rebuilt_operation_ledger RENAME TO operation_ledger;

  CREATE INDEX operation_receipts_city
    ON operation_receipts(city_id, created_at_hour, command_id);
  CREATE INDEX operation_ledger_city
    ON operation_ledger(city_id, created_at_hour, id);

  CREATE TRIGGER operation_receipt_global_key_guard
  BEFORE INSERT ON operation_receipts
  WHEN EXISTS (
    SELECT 1 FROM command_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;

  CREATE TRIGGER construction_receipt_global_key_guard
  BEFORE INSERT ON command_receipts
  WHEN EXISTS (
    SELECT 1 FROM operation_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;
`;

/**
 * v11: 시간당 생산(D-045).
 *
 * 지금까지 서버에는 생산이 없었다. 자원은 줄기만 하고 늘어나는 길은 승리 보상뿐이라,
 * 자원을 다 쓴 도시는 되돌아올 방법이 없었다 — 경제 루프 자체가 없는 상태였다.
 *
 * `cities.last_production_hour`는 마지막으로 정산한 시각이다. NULL이면 아직 정산한 적이 없다는 뜻이고,
 * 첫 정산은 소급하지 않고 그 시점부터 시작한다(옛 도시가 수천 시간을 한꺼번에 받지 않게).
 */
const MIGRATION_V11 = `
  ALTER TABLE cities ADD COLUMN last_production_hour INTEGER
    CHECK(last_production_hour IS NULL OR last_production_hour BETWEEN 0 AND 20000000);

  CREATE TABLE rebuilt_operation_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(
      command_kind IN (
        'mobilize_units','recon_npc','attack_npc','advance_research','recover_units','credit_production'
      )
    ),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(actor_id, command_id),
    UNIQUE(city_id, command_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_receipts(
    actor_id, command_id, city_id, command_kind,
    payload_sha256, payload_json, response_json, created_at_hour
  )
    SELECT actor_id, command_id, city_id, command_kind,
           payload_sha256, payload_json, response_json, created_at_hour
    FROM operation_receipts;

  CREATE TABLE rebuilt_operation_ledger (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK(resource_id IN ('food','steel','oil','supplies','manpower','scrip')),
    reason TEXT NOT NULL CHECK(
      reason IN ('mobilization','recon','sortie','victory_reward','research','recovery','production')
    ),
    delta_micro INTEGER NOT NULL CHECK(
      delta_micro BETWEEN -9007199254740991 AND 9007199254740991
      AND delta_micro <> 0
    ),
    balance_before_micro INTEGER NOT NULL CHECK(balance_before_micro BETWEEN 0 AND 9007199254740991),
    balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro BETWEEN 0 AND 9007199254740991),
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    CHECK(balance_after_micro = balance_before_micro + delta_micro),
    FOREIGN KEY(city_id, command_id)
      REFERENCES operation_receipts(city_id, command_id)
      DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(city_id, command_id, reason, resource_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_ledger(
    id, city_id, command_id, resource_id, reason, delta_micro,
    balance_before_micro, balance_after_micro, created_at_hour
  )
    SELECT id, city_id, command_id, resource_id, reason, delta_micro,
           balance_before_micro, balance_after_micro, created_at_hour
    FROM operation_ledger;

  DROP TRIGGER construction_receipt_global_key_guard;

  DROP TABLE operation_ledger;
  DROP TABLE operation_receipts;
  ALTER TABLE rebuilt_operation_receipts RENAME TO operation_receipts;
  ALTER TABLE rebuilt_operation_ledger RENAME TO operation_ledger;

  CREATE INDEX operation_receipts_city
    ON operation_receipts(city_id, created_at_hour, command_id);
  CREATE INDEX operation_ledger_city
    ON operation_ledger(city_id, created_at_hour, id);

  CREATE TRIGGER operation_receipt_global_key_guard
  BEFORE INSERT ON operation_receipts
  WHEN EXISTS (
    SELECT 1 FROM command_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;

  CREATE TRIGGER construction_receipt_global_key_guard
  BEFORE INSERT ON command_receipts
  WHEN EXISTS (
    SELECT 1 FROM operation_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;
`;

/**
 * v12: 도시 이름(D-054).
 *
 * 이름은 플레이어가 정하고 서버가 보관하는 **권위 상태**다. 화면이 지어내면 안 된다.
 * 기존 도시에는 상수 기본값이 들어간다 — `ALTER TABLE ADD COLUMN`은 상수 기본값만 허용한다.
 *
 * `operation_receipts.command_kind`에 `rename_city`를 더하려면 CHECK 재구축이 필요하고,
 * v9~v11에서 쓴 트리거 선삭제 절차를 그대로 따른다.
 */
const MIGRATION_V12 = `
  ALTER TABLE cities ADD COLUMN name TEXT NOT NULL DEFAULT '새 도시'
    CHECK(length(name) BETWEEN 1 AND 24);

  CREATE TABLE rebuilt_operation_receipts (
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 64),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 64),
    city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    command_kind TEXT NOT NULL CHECK(
      command_kind IN (
        'mobilize_units','recon_npc','attack_npc','advance_research','recover_units',
        'credit_production','rename_city'
      )
    ),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_hour INTEGER NOT NULL CHECK(created_at_hour BETWEEN 0 AND 20000000),
    PRIMARY KEY(actor_id, command_id),
    UNIQUE(city_id, command_id)
  ) STRICT;

  INSERT INTO rebuilt_operation_receipts(
    actor_id, command_id, city_id, command_kind,
    payload_sha256, payload_json, response_json, created_at_hour
  )
    SELECT actor_id, command_id, city_id, command_kind,
           payload_sha256, payload_json, response_json, created_at_hour
    FROM operation_receipts;

  DROP TRIGGER construction_receipt_global_key_guard;
  DROP TABLE operation_receipts;
  ALTER TABLE rebuilt_operation_receipts RENAME TO operation_receipts;

  CREATE INDEX operation_receipts_city
    ON operation_receipts(city_id, created_at_hour, command_id);

  CREATE TRIGGER operation_receipt_global_key_guard
  BEFORE INSERT ON operation_receipts
  WHEN EXISTS (
    SELECT 1 FROM command_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;

  CREATE TRIGGER construction_receipt_global_key_guard
  BEFORE INSERT ON command_receipts
  WHEN EXISTS (
    SELECT 1 FROM operation_receipts
    WHERE actor_id = NEW.actor_id AND command_id = NEW.command_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'GLOBAL_IDEMPOTENCY_CONFLICT');
  END;
`;

export const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = [
  { version: 1, sql: MIGRATION_V1 },
  { version: 2, sql: MIGRATION_V2 },
  { version: 3, sql: MIGRATION_V3 },
  { version: 4, sql: MIGRATION_V4 },
  { version: 5, sql: MIGRATION_V5 },
  { version: 6, sql: MIGRATION_V6 },
  { version: 7, sql: MIGRATION_V7 },
  { version: 8, sql: MIGRATION_V8 },
  { version: 9, sql: MIGRATION_V9 },
  { version: 10, sql: MIGRATION_V10 },
  { version: 11, sql: MIGRATION_V11 },
  { version: 12, sql: MIGRATION_V12 },
];

if (MIGRATIONS[MIGRATIONS.length - 1]?.version !== SERVER_SCHEMA_VERSION) {
  throw new Error('SERVER_SCHEMA_VERSION이 MIGRATIONS 마지막 버전과 일치해야 한다.');
}

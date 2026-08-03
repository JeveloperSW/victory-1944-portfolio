# Technical Architecture

[한국어](ARCHITECTURE.md) | English

## Core assessment

The hardest problems are not the rendering engine. They are authoritative state, time-based commands, the economic ledger, reproducible combat, and seasonal operations. Existing VictoryWars web and Electron assets can serve as prototype references, but `localStorage` and a client-side game loop must not be reused as authoritative online state.

## Logical structure

1. Mobile client: rendering, input, local cache, accessibility, and replay presentation
2. API and authentication: accounts, sessions, versions, request validation, and rate limiting
3. Game application: cities, production, research, armies, worlds, alliances, and seasons
4. Combat simulator: a pure deterministic calculation module
5. Job workers: scheduled completion, movement arrival, notifications, and season transitions
6. Relational database: accounts, ownership, economic ledger, commands, and combat metadata
7. Redis-class services: cache, distributed locks, rankings, and short-lived queue assistance
8. Object storage and analytics: detailed logs, replays, operational events, and product events
9. Administrative tools: inspection, sanctions, compensation, configuration, and audit

The initial backend should be a modular monolith. It should not be split into microservices before service boundaries and operational bottlenecks have been measured.

## Authority boundary

The client sends intent only. The server determines resource balances, production eligibility, completion times, travel distance, damage, rewards, inventory, territory, season scores, and payment grants. Client clocks, random values, and saved data are not authoritative evidence.

## Command processing

Every state-changing command validates authentication, authorization, current version, prerequisites, cost, and duplicate keys. Economic debit and command creation occur in one transaction. Retryable requests require an idempotency key, and reuse of the same key with a different payload is rejected.

## Combat reproduction

Combat inputs include snapshots of both forces, officers and doctrines, terrain and supply, the rules version, and a random seed. The simulator must remain a pure module with no dependency on external time, databases, or networks. The result hash and major events are stored so the battle can be replayed with its historical rules version.

## Time and jobs

Construction, research, and movement are represented by start and completion times rather than by updating every object each second. State is finalized using server time during reads or scheduled-job execution. Jobs are assumed to run at least once and therefore must be idempotent.

## Data and economy

- Store the cause, before and after values, request identifier, and operator identifier in a ledger rather than storing balances alone.
- Resources must never become negative, and grants must not be duplicated.
- Rankings and caches must be rebuildable and must not replace authoritative database state.
- Schema changes include a compatible deployment order and a recovery plan.
- Seasonal reset prefers a new `season_id` and archival policy over destructive deletion.

## Current proof-of-concept boundary

- `engine/` is a pure rules module with no dependency on time, databases, or networks. It reproduces combat results and structured analysis from the same input, rules version, and seed.
- `server/` schema v4 connects construction state to troop inventory, operation receipts and ledgers, reconnaissance reports, and NPC combat inputs and reports through additive tables in one SQLite file. Schema v5 binds separate economy-rules and campaign-rules versions to each city. Cost, troops, city version, reports, and receipts are committed in one transaction.
- Construction and operations share actor and `commandId` as a global idempotency key, and reuse across command types is rejected. Stored combat reports are cross-checked against campaign and combat rules versions, reconnaissance foreign keys, canonical inputs, recomputed result hashes, casualties, and ledger entries. Operation reads and idempotent replay compare the current state with the complete troop history and the resource-balance chain spanning construction and operations. For resources without an initial-allocation ledger entry, that chain cannot prove the origin before the first mutation.
- The local prototype screen is an internal loopback harness that drives a Bearer-token HTTP path and a compressed-clock construction worker. It fixes the epoch and hour duration in a file beside the database, accepts only the exact loopback Host and same Origin, and revokes the session token on a clean shutdown. It is not evidence for crash-time token recovery, token expiry, HTTPS, public deployment security, multiple hosts, or real-user validation.
- Only the SQLite adapter has been verified. PostgreSQL is not considered complete until dialect-specific migrations, BIGINT normalization, snapshot isolation, and command-level locking and contention semantics have been tested against a real instance.

## Client technology choices

Two paths are evaluated technically:

- Reuse web assets: TypeScript, a 2D renderer in the PixiJS family, and Capacitor
- Dedicated engine: a mobile game engine such as Unity

Selection criteria include reuse of existing assets, 2D world and replay performance, payment, push, and store SDKs, team capability, build stability, and long-term maintenance cost. The server API and combat-rules authority boundary remains the same for either path.

## Observability

Structured logs connect request ID, account ID, world and season, command ID, combat ID, and rules version. Metrics include error rate, latency, job backlog, economic creation and consumption, duplicate rejection, combat failure, payment verification, and report-handling time. Personal data and secrets are never written to logs.

# Quality Gates

[한국어](QUALITY_GATES.md) | English

## Merge gate

- Requirements and completion criteria are explicit.
- The change does not conflict with the product charter or decision log.
- Formatting, static analysis, unit tests, and integration tests pass.
- Success, rejection, duplicate, and concurrency paths are verified for changed rules.
- Data migrations and rollback or forward-recovery procedures are reviewed.
- Logs, metrics, and alerts do not expose personal data.
- Related documentation and configuration schemas are current.

## Combat gate

- The same input, rules version, and seed produce the same result hash.
- Replays remain available for historical rules versions.
- The server rejects unauthorized units, officers, formations, distances, and protected targets.
- Power-difference and repeated-attack limits work at their boundary values.
- Reported result figures match the sum of actual events.

## Economy and payment gate

- Resource balances never become negative.
- Concurrent purchases, claims, and retries grant value only once.
- Every change is traceable through a ledger and a cause identifier.
- Prices and rewards are validated against server configuration.
- Apple and Google receipts are verified on the server, including refunds and cancellations.
- Paid-currency and seasonal-expiration policies match their store disclosures.

## Season and world gate

- Season phase transitions and closure are reproduced in a staging world.
- Preserved and reset state matches `PROJECT_CHARTER.md`.
- Restarting after interruption does not duplicate rewards or reset state twice.
- Ranking settlement and rewards use the same snapshot.
- Backup, restore, retention, and personal-data deletion policies do not conflict.

## Performance and resilience gate

- API latency, job backlog, and database locks remain within acceptable limits at the target world load.
- Failures in external payment, push, or chat services do not damage authoritative game state.
- Scheduled commands and jobs are not lost after restart.
- Cache failure either recovers safely to the database or fails explicitly.
- An observability dashboard and callable response procedure exist.

## Store-release gate

- Account deletion, privacy policy, terms of service, and customer support are ready.
- Purchase restoration, refunds, and data-collection disclosures are verified.
- Chat filtering, reporting, blocking, and moderator sanctions work in practice.
- Historical symbols, violence, and age ratings are reviewed for each target country.
- Review accounts and reviewer instructions are available, and the server remains operational during review.

## Stop criteria

Security defects, duplicate payments, ledger inconsistencies, non-reproducible combat, season-data damage, and non-functional reporting or blocking are release blockers. Schedule pressure does not justify an exception.

# Victory 1944

Victory 1944 is a portfolio snapshot of a mobile-first strategy game prototype. It separates a deterministic simulation engine, a server-authoritative application layer, and a PixiJS client so that game rules can be tested independently from presentation and persistence.

## What is included

- `engine/`: deterministic combat, economy, campaign, and progression simulations
- `server/`: SQLite-backed construction and operation workflows, HTTP APIs, recovery, and telemetry tests
- `client/`: TypeScript, PixiJS, Vite, and Capacitor mobile client
- `victory_1944_docs/docs/engineering/`: selected architecture and quality-gate documentation

Internal decision logs, active plans, release operations, local agent instructions, and unpublished product strategy are intentionally excluded from this public snapshot.

## Architecture

```text
PixiJS client
     |
     v
HTTP application server
     |
     +--> authoritative construction and operation rules
     +--> SQLite persistence and recovery
     +--> telemetry and administrative boundaries
     |
     v
Deterministic simulation engine
```

The simulation engine owns deterministic domain rules. The server owns persistence, concurrency, recovery, and authority. The client renders server state and sends commands without becoming a second source of truth.

## Run the checks

Node.js 24 is recommended.

```powershell
cd engine
npm install
npm run typecheck
npm test

cd ..\server
npm run typecheck
npm test

cd ..\client
npm install
npm run typecheck
npm run build
```

To run the client locally, copy `client/.env.example` to `client/.env.local` and use a local API endpoint.

## Portfolio scope

This repository demonstrates system decomposition, deterministic testing, server authority, recovery paths, and mobile client integration. It is a curated snapshot rather than the full private development repository.

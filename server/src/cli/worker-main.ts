/**
 * 건설 워커 OS 프로세스 진입점.
 * 실행 예:
 *   tsx src/cli/worker-main.ts --db ./world.sqlite --worker worker:host1-1 \
 *     --epoch-ms 1786900000000 [--hour-ms 3600000] [--poll-ms 1000] [--batch 10] [--ticks N]
 * --ticks를 주면 해당 tick 수만 돌고 종료한다(스모크·검증용). 없으면 SIGINT/SIGTERM까지 돈다.
 * epoch·hour-ms는 월드 상수이므로 모든 프로세스가 같은 값을 받아야 한다.
 */
import { parseArgs } from 'node:util';
import { ConstructionServer } from '../construction-server.js';
import { createEpochHourClock, REAL_HOUR_MS } from '../clock.js';
import { ServerError } from '../errors.js';
import { ConstructionWorkerDaemon } from '../worker-daemon.js';
import type { WorkerTickReport } from '../worker-daemon.js';

function requiredInt(value: string | undefined, label: string, minimum: number, maximum: number): number {
  if (value === undefined) throw new ServerError('INVALID_INPUT', `--${label} 인자가 필요하다.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ServerError('INVALID_INPUT', `--${label}는 ${minimum}..${maximum} 정수여야 한다.`);
  }
  return parsed;
}

function logLine(kind: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...payload }));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      worker: { type: 'string' },
      'epoch-ms': { type: 'string' },
      'hour-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      batch: { type: 'string' },
      'lease-hours': { type: 'string' },
      ticks: { type: 'string' },
    },
    strict: true,
  });

  if (typeof values.db !== 'string' || values.db.length === 0) {
    throw new ServerError('INVALID_INPUT', '--db 인자가 필요하다.');
  }
  if (typeof values.worker !== 'string') {
    throw new ServerError('INVALID_INPUT', '--worker 인자가 필요하다.');
  }
  const epochMs = requiredInt(values['epoch-ms'], 'epoch-ms', 0, Number.MAX_SAFE_INTEGER);
  const hourMs = values['hour-ms'] === undefined
    ? REAL_HOUR_MS
    : requiredInt(values['hour-ms'], 'hour-ms', 10, REAL_HOUR_MS);
  const pollMs = values['poll-ms'] === undefined
    ? 1_000
    : requiredInt(values['poll-ms'], 'poll-ms', 1, 3_600_000);
  const maxTicks = values.ticks === undefined
    ? undefined
    : requiredInt(values.ticks, 'ticks', 1, 1_000_000);

  const server = await ConstructionServer.open(values.db);
  let ticks = 0;
  const daemon = new ConstructionWorkerDaemon({
    server,
    workerId: values.worker,
    clock: createEpochHourClock({ epochMs, hourDurationMs: hourMs }),
    pollIntervalMs: pollMs,
    ...(values.batch === undefined ? {} : { batchSize: requiredInt(values.batch, 'batch', 1, 100) }),
    ...(values['lease-hours'] === undefined
      ? {}
      : { leaseHours: requiredInt(values['lease-hours'], 'lease-hours', 1, 168) }),
    onTick: (report: WorkerTickReport) => {
      ticks += 1;
      logLine('tick', {
        workerId: report.workerId,
        nowHour: report.nowHour,
        claimed: report.claimed,
        deadLetteredOnScan: report.deadLetteredOnScan,
        jobs: report.jobs,
      });
      if (maxTicks !== undefined && ticks >= maxTicks) daemon.stop();
    },
  });

  const requestStop = (signal: string): void => {
    logLine('stopping', { signal });
    daemon.stop();
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  logLine('start', {
    db: values.db,
    workerId: values.worker,
    epochMs,
    hourMs,
    pollMs,
    schemaVersion: server.schemaVersion,
    ...(maxTicks === undefined ? {} : { maxTicks }),
  });
  try {
    await daemon.run();
  } finally {
    await server.close();
  }
  logLine('stopped', { ticks });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logLine('fatal', { message });
    process.exitCode = 1;
  },
);

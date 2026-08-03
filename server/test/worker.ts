import { parentPort, workerData } from 'node:worker_threads';
import {
  ConstructionServer,
  ServerError,
} from '../src/index.js';
import type {
  ClaimDueJobsCommand,
  CommandContext,
  CompleteConstructionCommand,
  StartConstructionCommand,
} from '../src/index.js';

interface WorkerInput {
  readonly databasePath: string;
  readonly gate: SharedArrayBuffer;
  readonly busyTimeoutMs: number;
  readonly operation: 'open' | 'start' | 'complete' | 'claim';
  readonly context?: CommandContext;
  readonly command?: StartConstructionCommand | CompleteConstructionCommand | ClaimDueJobsCommand;
}

const input = workerData as WorkerInput;

if (parentPort === null) {
  throw new Error('construction test worker requires a parent port');
}

const gate = new Int32Array(input.gate);
let server: ConstructionServer | undefined;

try {
  if (input.operation === 'open') {
    parentPort.postMessage({ type: 'ready' });
    Atomics.wait(gate, 0, 0);
  }
  server = await ConstructionServer.open(input.databasePath, {
    busyTimeoutMs: input.busyTimeoutMs,
  });
  if (input.operation !== 'open') {
    parentPort.postMessage({ type: 'ready' });
    Atomics.wait(gate, 0, 0);
  }

  const execution = input.operation === 'open'
    ? {
      replayed: false,
      response: {
        schemaVersion: server.schemaVersion,
        sqliteVersion: await server.sqliteVersion(),
      },
    }
    : input.operation === 'start'
      ? await server.startConstruction(
        input.context as CommandContext,
        input.command as StartConstructionCommand,
      )
      : input.operation === 'complete'
        ? await server.completeConstruction(
          input.context as CommandContext,
          input.command as CompleteConstructionCommand,
        )
        : {
          replayed: false,
          response: await server.claimDueConstructionJobs(
            input.context as CommandContext,
            input.command as ClaimDueJobsCommand,
          ),
        };

  parentPort.postMessage({
    type: 'result',
    result: {
      ok: true,
      execution,
    },
  });
} catch (error) {
  parentPort.postMessage({
    type: 'result',
    result: error instanceof ServerError
      ? {
        ok: false,
        code: error.code,
        retryable: error.retryable,
        message: error.message,
        causeMessage: error.cause instanceof Error
          ? error.cause.message
          : error.cause === undefined
            ? undefined
            : String(error.cause),
      }
      : {
        ok: false,
        code: 'UNEXPECTED',
        retryable: false,
        message: error instanceof Error ? error.message : String(error),
      },
  });
} finally {
  await server?.close();
}

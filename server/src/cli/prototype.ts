import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { devClockFilePath, loadOrCreateDevClockConfig } from '../dev-clock-file.js';
import { createEpochHourClock } from '../clock.js';
import { ConstructionServer } from '../construction-server.js';
import { ServerError } from '../errors.js';
import { startHttpApi } from '../http-api.js';
import { ConstructionWorkerDaemon } from '../worker-daemon.js';

const CITY_ID = 'city:prototype';
const OWNER_ID = 'player:prototype';
const ADMIN_ID = 'admin:prototype-bootstrap';

interface Options {
  readonly databasePath: string;
  readonly port: number;
  readonly hourDurationMs: number;
  readonly runDurationMs: number;
}

function integerArgument(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}은 ${minimum}..${maximum} 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptions(argv: readonly string[]): Options {
  let databasePath = resolve('.local', 'prototype.sqlite');
  let port = 0;
  let hourDurationMs = 2_000;
  let runDurationMs = 0;
  for (const argument of argv) {
    if (argument.startsWith('--db=')) {
      const value = argument.slice('--db='.length);
      if (value.length === 0) throw new Error('--db 경로가 비어 있습니다.');
      databasePath = resolve(value);
    } else if (argument.startsWith('--port=')) {
      port = integerArgument(argument.slice('--port='.length), '--port', 0, 65_535);
    } else if (argument.startsWith('--hour-ms=')) {
      hourDurationMs = integerArgument(
        argument.slice('--hour-ms='.length),
        '--hour-ms',
        100,
        60_000,
      );
    } else if (argument.startsWith('--run-ms=')) {
      runDurationMs = integerArgument(
        argument.slice('--run-ms='.length),
        '--run-ms',
        100,
        60_000,
      );
    } else {
      throw new Error(`알 수 없는 인자: ${argument}`);
    }
  }
  return { databasePath, port, hourDurationMs, runDurationMs };
}

async function cityOrSeed(server: ConstructionServer) {
  try {
    return await server.getCity(CITY_ID);
  } catch (error) {
    if (!(error instanceof ServerError) || error.code !== 'NOT_FOUND') throw error;
    return await server.seedCity({
      cityId: CITY_ID,
      ownerId: OWNER_ID,
      campaignRuleVersion: '0.2.0',
      buildings: { hq: 2 },
    });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const server = await ConstructionServer.open(options.databasePath);
  let api: Awaited<ReturnType<typeof startHttpApi>> | undefined;
  let daemon: ConstructionWorkerDaemon | undefined;
  let daemonRun: Promise<void> | undefined;
  let clock: (() => number) | undefined;
  let sessionTokenSha256: string | undefined;

  try {
    const city = await cityOrSeed(server);
    if (city.ownerId !== OWNER_ID) {
      throw new Error(`프로토타입 도시 소유자가 다릅니다: ${city.ownerId}`);
    }
    const clockConfig = loadOrCreateDevClockConfig(
      options.databasePath,
      city.lastServerHour,
      options.hourDurationMs,
    );
    clock = createEpochHourClock({
      epochMs: clockConfig.epochMs,
      hourDurationMs: clockConfig.hourDurationMs,
    });
    if (clock() < city.lastServerHour) {
      throw new Error('고정 프로토타입 시계가 저장된 도시 시간보다 뒤에 있습니다.');
    }
    const token = await server.issueToken(
      { actorId: ADMIN_ID, nowHour: clock() },
      {
        actorId: OWNER_ID,
        role: 'player',
        reason: '로컬 플레이어블 첫 루프 세션',
      },
    );
    sessionTokenSha256 = token.tokenSha256;
    daemon = new ConstructionWorkerDaemon({
      server,
      workerId: 'worker:prototype',
      clock,
      batchSize: 10,
      pollIntervalMs: 250,
    });
    daemonRun = daemon.run();
    api = await startHttpApi({
      server,
      clock,
      port: options.port,
      prototypeSession: { token: token.token, cityId: CITY_ID },
    });

    console.log(`Victory 1944 로컬 프로토타입: http://127.0.0.1:${api.port}/prototype`);
    console.log(`DB: ${options.databasePath}`);
    console.log(`고정 시계: ${devClockFilePath(options.databasePath)}`);
    console.log(`압축 시간: 게임 1시간 = ${options.hourDurationMs}ms`);
    console.log(`현재 권위 시각: h${clock()}`);
    console.log('종료: Ctrl+C (공개 배포·외부 접속용 서버가 아닙니다)');

    const stopWait = options.runDurationMs > 0
      ? new Promise<void>((resolveStop) => {
        setTimeout(resolveStop, options.runDurationMs);
      })
      : new Promise<void>((resolveStop) => {
        const stop = (): void => resolveStop();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    await Promise.race([
      stopWait,
      daemonRun.then(() => {
        throw new Error('건설 워커가 중지 요청 전에 종료됐습니다.');
      }),
    ]);
  } finally {
    const cleanupErrors: unknown[] = [];
    daemon?.stop();
    try {
      await daemonRun;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await api?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (clock && sessionTokenSha256) {
      try {
        await server.revokeToken(
          { actorId: ADMIN_ID, nowHour: clock() },
          {
            tokenSha256: sessionTokenSha256,
            reason: '로컬 프로토타입 세션 종료',
          },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await server.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, '프로토타입 종료 정리 중 오류가 발생했습니다.');
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`프로토타입 시작 실패: ${message}`);
  process.exitCode = 1;
});

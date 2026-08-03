/**
 * 모바일 클라이언트 개발용 서버 진입점(D-025·D-026).
 *
 * 프로토타입 HTML 하네스와 달리 화면을 제공하지 않고 HTTP API만 연다.
 * 앱은 교차 출처이므로 명시적 Origin 허용목록을 켜고, 페어링용 플레이어 토큰을 출력한다.
 *
 * 실행:
 *   npm run app:server -- [--port=8150] [--hour-ms=2000] [--db=경로] [--origin=http://...]
 *
 * 공개 배포용이 아니다. 루프백에 바인딩하며 토큰은 이 출력에서만 확인할 수 있다.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createEpochHourClock } from '../clock.js';
import { ConstructionServer } from '../construction-server.js';
import { devClockFilePath, loadOrCreateDevClockConfig } from '../dev-clock-file.js';
import { ServerError } from '../errors.js';
import { startHttpApi } from '../http-api.js';
import { ConstructionWorkerDaemon } from '../worker-daemon.js';

const CITY_ID = 'city:app';
const OWNER_ID = 'player:app';
const ADMIN_ID = 'admin:app-bootstrap';

/** Vite dev 서버와 Capacitor 앱 문서 Origin(Android 기본 스킴 포함). */
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost',
  'https://localhost',
] as const;

interface Options {
  readonly databasePath: string;
  readonly port: number;
  readonly hourDurationMs: number;
  readonly origins: readonly string[];
}

function integerArgument(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}은 ${minimum}..${maximum} 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptions(argv: readonly string[]): Options {
  let databasePath = resolve('.local', 'app.sqlite');
  let port = 8_150;
  let hourDurationMs = 2_000;
  const extraOrigins: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith('--db=')) {
      const value = argument.slice('--db='.length);
      if (value.length === 0) throw new Error('--db 경로가 비어 있습니다.');
      databasePath = resolve(value);
    } else if (argument.startsWith('--port=')) {
      port = integerArgument(argument.slice('--port='.length), '--port', 0, 65_535);
    } else if (argument.startsWith('--hour-ms=')) {
      hourDurationMs = integerArgument(argument.slice('--hour-ms='.length), '--hour-ms', 100, 60_000);
    } else if (argument.startsWith('--origin=')) {
      const value = argument.slice('--origin='.length);
      if (value.length === 0) throw new Error('--origin 값이 비어 있습니다.');
      extraOrigins.push(value);
    } else {
      throw new Error(`알 수 없는 인자: ${argument}`);
    }
  }
  return {
    databasePath,
    port,
    hourDurationMs,
    origins: [...new Set([...DEFAULT_ORIGINS, ...extraOrigins])],
  };
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
      throw new Error(`앱 개발 도시 소유자가 다릅니다: ${city.ownerId}`);
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
      throw new Error('고정 시계가 저장된 도시 시간보다 뒤에 있습니다.');
    }
    const token = await server.issueToken(
      { actorId: ADMIN_ID, nowHour: clock() },
      { actorId: OWNER_ID, role: 'player', reason: '모바일 클라이언트 개발 세션' },
    );
    sessionTokenSha256 = token.tokenSha256;

    daemon = new ConstructionWorkerDaemon({
      server,
      workerId: 'worker:app-dev',
      clock,
      batchSize: 10,
      pollIntervalMs: 250,
    });
    daemonRun = daemon.run();

    api = await startHttpApi({
      server,
      clock,
      port: options.port,
      allowedOrigins: options.origins,
    });

    console.log('=== Victory 1944 앱 개발 서버 ===');
    console.log(`API: http://127.0.0.1:${api.port}`);
    console.log(`도시: ${CITY_ID} (소유자 ${OWNER_ID})`);
    console.log(`DB: ${options.databasePath}`);
    console.log(`고정 시계: ${devClockFilePath(options.databasePath)}`);
    console.log(`압축 시간: 게임 1시간 = ${options.hourDurationMs}ms, 현재 h${clock()}`);
    console.log(`허용 Origin: ${options.origins.join(', ')}`);
    console.log('');
    console.log('앱은 첫 실행에 스스로 계정을 만듭니다 (D-039). 입력할 것이 없습니다.');
    console.log(`  클라이언트 빌드 설정: VITE_API_BASE_URL=http://127.0.0.1:${api.port}`);
    console.log(`  관리자 토큰(운영 CLI 전용): ${token.token}`);
    console.log('');
    console.log('종료: Ctrl+C (공개 배포·외부 접속용 서버가 아닙니다)');

    await Promise.race([
      new Promise<void>((resolveStop) => {
        const stop = (): void => resolveStop();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      }),
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
          { tokenSha256: sessionTokenSha256, reason: '앱 개발 세션 종료' },
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
      throw new AggregateError(cleanupErrors, '앱 개발 서버 종료 정리 중 오류가 발생했습니다.');
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`앱 개발 서버 시작 실패: ${message}`);
  process.exitCode = 1;
});

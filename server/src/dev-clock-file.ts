import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 로컬 개발 진입점이 공유하는 고정 시계 파일 규약.
 * 시즌 기점(epoch)은 DB 옆 파일에 최초 한 번만 고정하고, 이후 실행에서 재앵커링하지 않는다.
 * 진행된 DB에서 파일이 없거나 설정이 다르면 시간을 되돌리지 않고 중단한다(fail closed).
 */

export interface DevClockConfig {
  readonly version: 1;
  readonly epochMs: number;
  readonly hourDurationMs: number;
}

export function devClockFilePath(databasePath: string): string {
  return `${databasePath}.clock.json`;
}

export function readDevClockConfig(path: string, requestedHourDurationMs: number): DevClockConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`프로토타입 시계 파일을 읽을 수 없습니다: ${path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`프로토타입 시계 파일 형식이 잘못됐습니다: ${path}`);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'epochMs,hourDurationMs,version'
    || record.version !== 1
    || !Number.isSafeInteger(record.epochMs)
    || (record.epochMs as number) < 0
    || !Number.isSafeInteger(record.hourDurationMs)
    || record.hourDurationMs !== requestedHourDurationMs) {
    throw new Error(
      `프로토타입 시계 파일이 현재 --hour-ms=${requestedHourDurationMs} 설정과 맞지 않습니다: ${path}`,
    );
  }
  return {
    version: 1,
    epochMs: record.epochMs as number,
    hourDurationMs: record.hourDurationMs as number,
  };
}

export function loadOrCreateDevClockConfig(
  databasePath: string,
  lastServerHour: number,
  hourDurationMs: number,
): DevClockConfig {
  const path = devClockFilePath(databasePath);
  if (existsSync(path)) return readDevClockConfig(path, hourDurationMs);
  if (lastServerHour !== 0) {
    throw new Error(
      `진행된 DB에 고정 시계 파일이 없습니다. 재앵커링하지 않고 중단합니다: ${path}`,
    );
  }
  const epochMs = Date.now();
  const config: DevClockConfig = { version: 1, epochMs, hourDurationMs };
  try {
    writeFileSync(path, `${JSON.stringify(config)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return config;
  } catch (error) {
    // 동시 실행이 먼저 만들었으면 그 파일을 따른다.
    if (existsSync(path)) return readDevClockConfig(path, hourDurationMs);
    throw error;
  }
}

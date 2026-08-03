import { ServerError } from './errors.js';

/**
 * 실시간 벽시계 → 권위 hour 어댑터.
 * 권위 hour = floor((now - epochMs) / hourDurationMs). 시즌 기점(epoch)은 월드 상수다.
 * 벽시계가 뒤로 가도(NTP 보정 등) 반환값은 단조를 유지한다 — 권위 시간은 역행하지 않는다.
 */

export interface EpochHourClockOptions {
  /** 시즌 기점(Unix epoch ms). 모든 프로세스가 같은 값을 써야 한다. */
  readonly epochMs: number;
  /** 권위 1시간의 실제 길이(ms). 기본 3,600,000. 개발·데모용 압축 시계 허용(최소 10ms) */
  readonly hourDurationMs?: number;
  /** 테스트 주입용 현재 시각(ms). 기본 Date.now */
  readonly now?: () => number;
}

export const REAL_HOUR_MS = 3_600_000;
const MAX_AUTHORITATIVE_HOUR = 20_000_000;

export function createEpochHourClock(options: EpochHourClockOptions): () => number {
  if (typeof options !== 'object' || options === null) {
    throw new ServerError('INVALID_INPUT', '시계 옵션은 객체여야 한다.');
  }
  const { epochMs } = options;
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new ServerError('INVALID_INPUT', 'epochMs는 0 이상의 안전한 정수여야 한다.');
  }
  const hourDurationMs = options.hourDurationMs ?? REAL_HOUR_MS;
  if (!Number.isSafeInteger(hourDurationMs) || hourDurationMs < 10 || hourDurationMs > REAL_HOUR_MS) {
    throw new ServerError('INVALID_INPUT', `hourDurationMs는 10..${REAL_HOUR_MS} 정수여야 한다.`);
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new ServerError('INVALID_INPUT', 'now는 함수여야 한다.');
  }

  let lastHour = -1;
  return function authoritativeHour(): number {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) {
      throw new ServerError('INVALID_INPUT', '주입 시계가 유효한 시각을 돌려주지 않았다.');
    }
    const raw = Math.floor((nowMs - epochMs) / hourDurationMs);
    if (raw < 0 && lastHour < 0) {
      throw new ServerError('TIME_REVERSED', '시즌 기점(epoch) 이전에는 권위 시간이 없다.');
    }
    if (raw > MAX_AUTHORITATIVE_HOUR) {
      throw new ServerError('INVALID_INPUT', '권위 시간이 서버 시간 상한을 넘었다.');
    }
    // 벽시계 역행 시 마지막 권위 시간을 유지한다(단조 보장).
    lastHour = Math.max(lastHour, raw);
    return lastHour;
  };
}

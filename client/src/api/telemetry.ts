import type { GameApi } from './client.js';

/**
 * 첫 루프 계측(D-035).
 *
 * - 열거값과 오류 코드만 보낸다. 자유 텍스트·이용자 입력·기기 정보를 수집하지 않는다.
 * - 계측 실패는 무시한다 — 기록이 안 되더라도 게임 진행을 막지 않는다.
 * - 배치로 모아 보내 요청 수를 줄인다.
 */

export type EventName =
  | 'session_start'
  | 'screen_view'
  | 'command_attempt'
  | 'command_success'
  | 'command_rejected'
  | 'report_view';

export type EventSubject =
  | 'city' | 'operations' | 'reports' | 'connect'
  | 'build' | 'mobilize' | 'recon' | 'attack';

interface QueuedEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly name: EventName;
  readonly subject?: EventSubject;
  readonly outcome?: string;
  readonly clientSeq: number;
}

const BATCH_LIMIT = 20;
const FLUSH_DELAY_MS = 1_500;

function randomId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(3));
  return `${prefix}:${[...random].map((value) => value.toString(16)).join('')}`.slice(0, 64);
}

export class Telemetry {
  private readonly api: GameApi;
  private readonly sessionId = randomId('s');
  private queue: QueuedEvent[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(api: GameApi) {
    this.api = api;
  }

  record(name: EventName, subject?: EventSubject, outcome?: string): void {
    this.queue.push({
      id: randomId('e'),
      sessionId: this.sessionId,
      name,
      ...(subject === undefined ? {} : { subject }),
      // 서버는 대문자·밑줄만 받는다. 그 밖의 값은 보내지 않는다.
      ...(outcome !== undefined && /^[A-Z_]{1,40}$/.test(outcome) ? { outcome } : {}),
      clientSeq: this.seq,
    });
    this.seq += 1;
    if (this.queue.length >= BATCH_LIMIT) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.slice(0, BATCH_LIMIT);
    this.queue = this.queue.slice(BATCH_LIMIT);
    try {
      await this.api.recordEvents(batch);
    } catch {
      // 계측 실패는 무시한다. 재시도하지 않으며 게임 진행에 영향을 주지 않는다.
    }
  }
}

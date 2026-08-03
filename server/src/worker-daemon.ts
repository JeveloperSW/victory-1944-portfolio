import { createHash } from 'node:crypto';
import type { ConstructionServer } from './construction-server.js';
import { ServerError } from './errors.js';
import { CONSTRUCTION_WORKER_ID, WORKER_ID_PREFIX } from './types.js';
import type { ClaimedJob } from './types.js';

/**
 * 건설 워커 데몬 — D-020 디스패치 API의 소비자.
 * 데몬은 권위가 아니다: 모든 상태 변경은 멱등 서버 명령(claim/complete/fail)을 통해서만 일어나고,
 * 데몬 crash는 새 상태를 만들지 않으며 lease 만료로 복구된다.
 * 시계는 호출자가 주입한다(ARCHITECTURE: 서버 시간 기준, 벽시계 암묵 사용 금지).
 */

export interface WorkerDaemonOptions {
  readonly server: ConstructionServer;
  /** `worker:` 접두 워커 인스턴스 ID */
  readonly workerId: string;
  /** 권위 서버 시각(정수 hour)을 돌려주는 주입 시계 */
  readonly clock: () => number;
  /** tick당 claim 상한. 1..100, 기본 10 */
  readonly batchSize?: number;
  /** claim lease 길이(시간). 생략 시 서버 정책 기본값 */
  readonly leaseHours?: number;
  /** run() 루프의 tick 간격(ms). 1..3600000, 기본 1000 */
  readonly pollIntervalMs?: number;
  /** retryable 오류의 tick 내 재시도 횟수. 0..10, 기본 2 */
  readonly busyRetries?: number;
  /** 테스트 주입용 sleep. 기본 setTimeout */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** tick 종료마다 호출되는 관측 콜백 */
  readonly onTick?: (report: WorkerTickReport) => void;
}

export type JobOutcomeKind =
  | 'completed'
  | 'retry_scheduled'
  | 'dead'
  /** 실패 보고 자체가 실패(소유권 경쟁 등) — lease 만료 복구에 맡긴다 */
  | 'fail_report_lost';

export interface JobProcessOutcome {
  readonly jobId: string;
  readonly attempt: number;
  readonly outcome: JobOutcomeKind;
  /** completed일 때 receipt/effect 재생 여부 */
  readonly replayed?: boolean;
  /** 실패 계열일 때 보고한 오류 */
  readonly error?: string;
  /** retry_scheduled일 때 재claim 가능 시각 */
  readonly nextEligibleHour?: number | null;
}

export interface WorkerTickReport {
  readonly workerId: string;
  readonly nowHour: number;
  readonly claimed: number;
  /** claim 스캔이 dead letter로 전환한 job */
  readonly deadLetteredOnScan: readonly string[];
  readonly jobs: readonly JobProcessOutcome[];
  /** 이 tick에 복귀시킨 회복 job(D-045) */
  readonly recoveriesCompleted: readonly string[];
  /** 이 tick에 생산을 정산한 도시(D-045) */
  readonly citiesProduced: readonly string[];
}

function validateIntegerOption(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ServerError('INVALID_INPUT', `${label}는 ${minimum}..${maximum} 정수여야 한다.`);
  }
  return value as number;
}

function formatError(error: unknown): string {
  let text: string;
  if (error instanceof ServerError) {
    // 래핑된 DATABASE_FAILURE 등에서 근본 원인을 last_error로 보존한다(운영 진단).
    const cause = error.cause instanceof Error ? ` | cause: ${error.cause.message}` : '';
    text = `${error.message}${cause}`;
  } else if (error instanceof Error) {
    text = `[UNEXPECTED] ${error.message}`;
  } else {
    text = `[UNEXPECTED] ${String(error)}`;
  }
  return text.length <= 200 ? text : text.slice(0, 200);
}

/** job+시도별 결정론적 완료 commandId. 같은 시도 재시도는 receipt 재생, 다른 시도는 effect 재생이 된다. */
function completionCommandId(jobId: string, attempt: number): string {
  const digest = createHash('sha256').update(jobId, 'utf8').digest('hex').slice(0, 48);
  return `c:${digest}:a${attempt}`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class ConstructionWorkerDaemon {
  readonly workerId: string;
  private readonly server: ConstructionServer;
  private readonly clock: () => number;
  private readonly batchSize: number;
  private readonly leaseHours: number | undefined;
  private readonly pollIntervalMs: number;
  private readonly busyRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onTick: ((report: WorkerTickReport) => void) | undefined;
  private running = false;
  private stopRequested = false;
  private wake: (() => void) | undefined;

  constructor(options: WorkerDaemonOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new ServerError('INVALID_INPUT', '워커 데몬 옵션은 객체여야 한다.');
    }
    if (typeof options.workerId !== 'string'
      || !options.workerId.startsWith(WORKER_ID_PREFIX)
      || options.workerId.length <= WORKER_ID_PREFIX.length
      || options.workerId.length > 64) {
      throw new ServerError('INVALID_INPUT', `workerId는 '${WORKER_ID_PREFIX}' 접두 1..64자여야 한다.`);
    }
    if (typeof options.clock !== 'function') {
      throw new ServerError('INVALID_INPUT', 'clock 주입이 필요하다(벽시계 암묵 사용 금지).');
    }
    this.server = options.server;
    this.workerId = options.workerId;
    this.clock = options.clock;
    this.batchSize = options.batchSize === undefined
      ? 10
      : validateIntegerOption(options.batchSize, 'batchSize', 1, 100);
    this.leaseHours = options.leaseHours === undefined
      ? undefined
      : validateIntegerOption(options.leaseHours, 'leaseHours', 1, 168);
    this.pollIntervalMs = options.pollIntervalMs === undefined
      ? 1_000
      : validateIntegerOption(options.pollIntervalMs, 'pollIntervalMs', 1, 3_600_000);
    this.busyRetries = options.busyRetries === undefined
      ? 2
      : validateIntegerOption(options.busyRetries, 'busyRetries', 0, 10);
    this.sleep = options.sleep ?? defaultSleep;
    this.onTick = options.onTick;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 한 tick: due job claim → 각 job 완료 처리 → 실패 보고. tick 보고서를 돌려준다. */
  async runOnce(): Promise<WorkerTickReport> {
    const nowHour = this.clock();
    if (!Number.isSafeInteger(nowHour) || nowHour < 0) {
      throw new ServerError('INVALID_INPUT', '주입 시계가 유효한 서버 시각(hour)을 돌려주지 않았다.');
    }
    const context = { actorId: this.workerId, nowHour } as const;
    const claimResult = await this.server.claimDueConstructionJobs(
      context,
      this.leaseHours === undefined
        ? { limit: this.batchSize }
        : { limit: this.batchSize, leaseHours: this.leaseHours },
    );
    const jobs: JobProcessOutcome[] = [];
    for (const job of claimResult.claimed) {
      jobs.push(await this.processJob(job, nowHour));
    }
    const recoveriesCompleted = await this.completeDueRecoveries(nowHour);
    const citiesProduced = await this.creditDueProduction(nowHour);
    const report: WorkerTickReport = {
      workerId: this.workerId,
      nowHour,
      claimed: claimResult.claimed.length,
      deadLetteredOnScan: claimResult.deadLettered,
      jobs,
      recoveriesCompleted,
      citiesProduced,
    };
    this.onTick?.(report);
    return report;
  }

  /** stop() 요청까지 pollIntervalMs 간격으로 runOnce를 반복한다. 정지는 tick 경계에서 일어난다. */
  async run(): Promise<void> {
    if (this.running) {
      throw new ServerError('INVALID_INPUT', '워커 데몬이 이미 실행 중이다.');
    }
    this.running = true;
    this.stopRequested = false;
    try {
      while (!this.stopRequested) {
        await this.runOnce();
        if (this.stopRequested) break;
        await this.interruptibleSleep();
      }
    } finally {
      this.running = false;
      this.wake = undefined;
    }
  }

  /** 진행 중인 tick이 끝난 뒤 루프를 종료한다. */
  stop(): void {
    this.stopRequested = true;
    this.wake?.();
  }

  private async interruptibleSleep(): Promise<void> {
    await Promise.race([
      this.sleep(this.pollIntervalMs),
      new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
    ]);
    this.wake = undefined;
  }

  /**
   * 시간이 된 부상병 회복을 복귀시킨다(D-045).
   *
   * 건설과 달리 claim·lease를 쓰지 않는다. 완료는 `status = 'pending'` 조건부 UPDATE라
   * 워커가 여럿이어도 정확히 한 번만 적용되고, 실패해도 다음 tick이 같은 job을 다시 집는다.
   * 한 job의 실패가 다른 job을 막지 않도록 개별적으로 삼킨다.
   */
  private async completeDueRecoveries(nowHour: number): Promise<readonly string[]> {
    const completed: string[] = [];
    const due = await this.server.dueRecoveryJobs(nowHour, this.batchSize);
    for (const jobId of due) {
      try {
        const execution = await this.server.completeRecovery(
          { actorId: CONSTRUCTION_WORKER_ID, nowHour },
          { jobId },
        );
        if (!execution.replayed) completed.push(jobId);
      } catch {
        // 다음 tick에 다시 시도한다. 조건부 UPDATE라 중복 적용은 생기지 않는다.
      }
    }
    return completed;
  }

  /**
   * 밀린 도시의 시간당 생산을 정산한다(D-045).
   * 정산 구간이 commandId를 정하므로 중복 실행은 영수증에서 걸린다.
   */
  private async creditDueProduction(nowHour: number): Promise<readonly string[]> {
    const produced: string[] = [];
    const cities = await this.server.citiesNeedingProduction(nowHour, this.batchSize);
    for (const cityId of cities) {
      try {
        const execution = await this.server.creditProduction(
          { actorId: CONSTRUCTION_WORKER_ID, nowHour },
          { cityId, toHour: nowHour },
        );
        if (execution !== null) produced.push(cityId);
      } catch {
        // 다음 tick에 다시 시도한다. 정산 시각이 남아 있으므로 건너뛴 시간은 사라지지 않는다.
      }
    }
    return produced;
  }

  private async processJob(job: ClaimedJob, nowHour: number): Promise<JobProcessOutcome> {
    const commandId = completionCommandId(job.jobId, job.attempt);
    let failReason = '';
    for (let tryIndex = 0; tryIndex <= this.busyRetries; tryIndex += 1) {
      try {
        const execution = await this.server.completeConstruction(
          { actorId: CONSTRUCTION_WORKER_ID, nowHour },
          { commandId, jobId: job.jobId },
        );
        return {
          jobId: job.jobId,
          attempt: job.attempt,
          outcome: 'completed',
          replayed: execution.replayed,
        };
      } catch (error) {
        failReason = formatError(error);
        const retryable = error instanceof ServerError && error.retryable;
        if (!retryable || tryIndex === this.busyRetries) break;
      }
    }
    try {
      const failed = await this.server.failClaimedConstructionJob(
        { actorId: this.workerId, nowHour },
        { jobId: job.jobId, error: failReason },
      );
      return {
        jobId: job.jobId,
        attempt: failed.attempt,
        outcome: failed.state,
        error: failReason,
        nextEligibleHour: failed.nextEligibleHour,
      };
    } catch (reportError) {
      // 보고 실패(소유권 경쟁·lease 만료 등)는 새 상태를 만들지 않고 lease 만료 복구에 맡긴다.
      return {
        jobId: job.jobId,
        attempt: job.attempt,
        outcome: 'fail_report_lost',
        error: `${failReason} | 보고 실패: ${formatError(reportError)}`.slice(0, 400),
      };
    }
  }
}

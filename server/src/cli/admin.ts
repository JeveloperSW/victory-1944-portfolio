/**
 * 운영 관리자 CLI — dead letter 조회·재가동, 토큰 발급·폐기, 감사 조회.
 * 모든 조치는 admin_actions 감사 테이블에 남는다. DB 파일에 직접 접근하는 운영 도구다.
 *
 * 사용:
 *   tsx src/cli/admin.ts dead-letters --db <path>
 *   tsx src/cli/admin.ts audit --db <path>
 *   tsx src/cli/admin.ts requeue --db <path> --actor admin:ops --now-hour N --job <jobId> --reason "..."
 *   tsx src/cli/admin.ts issue-token --db <path> --actor admin:ops --now-hour N --for user:x --role player --reason "..."
 *   tsx src/cli/admin.ts revoke-token --db <path> --actor admin:ops --now-hour N --sha <64hex> --reason "..."
 */
import { parseArgs } from 'node:util';
import { ConstructionServer } from '../construction-server.js';
import { ServerError } from '../errors.js';
import type { TokenRole } from '../types.js';

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new ServerError('INVALID_INPUT', `--${label} 인자가 필요하다.`);
  }
  return value;
}

function requiredInt(value: string | undefined, label: string): number {
  const parsed = Number(required(value, label));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServerError('INVALID_INPUT', `--${label}는 0 이상의 정수여야 한다.`);
  }
  return parsed;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      db: { type: 'string' },
      actor: { type: 'string' },
      'now-hour': { type: 'string' },
      job: { type: 'string' },
      reason: { type: 'string' },
      for: { type: 'string' },
      role: { type: 'string' },
      sha: { type: 'string' },
    },
    strict: true,
  });

  const server = await ConstructionServer.open(required(values.db, 'db'));
  try {
    switch (command) {
      case 'dead-letters': {
        console.log(JSON.stringify({ deadLetters: await server.listDeadJobs() }, null, 2));
        return 0;
      }
      case 'funnel': {
        const rows = await server.listFunnel();
        if (rows.length === 0) {
          console.log('기록된 계측 이벤트가 없습니다.');
          return 0;
        }
        console.log('이벤트                대상          결과                 건수   세션');
        for (const row of rows) {
          console.log(
            `  ${row.name.padEnd(18)}${(row.subject ?? '-').padEnd(14)}`
            + `${(row.outcome ?? '-').padEnd(20)}${String(row.events).padStart(6)}`
            + `${String(row.sessions).padStart(7)}`,
          );
        }
        return 0;
      }
      case 'audit': {
        console.log(JSON.stringify({ actions: await server.listAdminActions() }, null, 2));
        return 0;
      }
      case 'requeue': {
        const result = await server.requeueDeadJob(
          { actorId: required(values.actor, 'actor'), nowHour: requiredInt(values['now-hour'], 'now-hour') },
          { jobId: required(values.job, 'job'), reason: required(values.reason, 'reason') },
        );
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'issue-token': {
        const result = await server.issueToken(
          { actorId: required(values.actor, 'actor'), nowHour: requiredInt(values['now-hour'], 'now-hour') },
          {
            actorId: required(values.for, 'for'),
            role: required(values.role, 'role') as TokenRole,
            reason: required(values.reason, 'reason'),
          },
        );
        // 토큰 원문은 이 출력에서만 확인 가능하다 — 저장되지 않는다.
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'revoke-token': {
        const result = await server.revokeToken(
          { actorId: required(values.actor, 'actor'), nowHour: requiredInt(values['now-hour'], 'now-hour') },
          { tokenSha256: required(values.sha, 'sha'), reason: required(values.reason, 'reason') },
        );
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      default:
        console.error('사용 가능한 명령: dead-letters | audit | funnel | requeue | issue-token | revoke-token');
        return 1;
    }
  } finally {
    await server.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof ServerError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error(`관리자 명령 실패: ${message}`);
    process.exitCode = 1;
  },
);

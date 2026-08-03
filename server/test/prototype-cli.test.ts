import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ConstructionServer } from '../src/construction-server.js';
import { SERVER_SCHEMA_VERSION } from '../src/database.js';
import { ServerError } from '../src/errors.js';

function statusWithHost(url: string, host: string): Promise<number | undefined> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const call = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      headers: { host },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    call.once('error', reject);
    call.end();
  });
}

test('prototype CLI는 루프백 UI·health를 열고 유한 스모크 실행 후 정상 종료한다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'victory1944-prototype-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  const databasePath = join(directory, 'prototype.sqlite');
  const tsxCli = fileURLToPath(new URL('../../engine/node_modules/tsx/dist/cli.mjs', import.meta.url));
  const entry = fileURLToPath(new URL('../src/cli/prototype.ts', import.meta.url));
  const child = spawn(process.execPath, [
    tsxCli,
    entry,
    `--db=${databasePath}`,
    '--port=0',
    '--hour-ms=200',
    '--run-ms=4000',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`prototype URL 대기 시간 초과\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    const inspect = (): void => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/prototype/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    };
    child.stdout.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    inspect();
  });

  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /첫 작전 검증판/);
  const tokenLiteral = html.match(/const TOKEN = ("(?:[^"\\]|\\.)*");/)?.[1];
  assert.ok(tokenLiteral, '프로토타입 세션 토큰 literal이 있어야 한다.');
  const token = JSON.parse(tokenLiteral) as string;
  const reboundStatus = await statusWithHost(url, 'attacker.example');
  assert.equal(reboundStatus, 403, 'DNS rebinding 형태의 Host는 토큰 HTML을 받을 수 없어야 한다.');
  const crossOrigin = await fetch(url, { headers: { origin: 'http://attacker.example' } });
  assert.equal(crossOrigin.status, 403, '다른 Origin은 프로토타입 세션에 접근할 수 없어야 한다.');
  const health = await fetch(url.replace('/prototype', '/health'));
  assert.equal(health.status, 200);
  const healthBody = await health.json() as Record<string, unknown>;
  assert.equal(healthBody.schemaVersion, SERVER_SCHEMA_VERSION);

  const base = url.replace('/prototype', '');
  const construction = await fetch(`${base}/v1/cities/city%3Aprototype/constructions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId: 'cmd:prototype-cli:farm',
      expectedVersion: 0,
      buildingId: 'farm',
    }),
  });
  assert.equal(construction.status, 201);

  let farmLevel = 1;
  let currentVersion = 0;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && farmLevel < 2) {
    const operations = await fetch(`${base}/v1/cities/city%3Aprototype/operations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(operations.status, 200);
    const snapshot = await operations.json() as {
      buildings: { farm: number };
      version: number;
    };
    farmLevel = snapshot.buildings.farm;
    currentVersion = snapshot.version;
    if (farmLevel < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(farmLevel, 2, '압축 시계 워커가 농장 건설을 완료해야 한다.');

  const commandHeaders = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const mobilized = await fetch(`${base}/v1/cities/city%3Aprototype/mobilizations`, {
    method: 'POST',
    headers: commandHeaders,
    body: JSON.stringify({
      commandId: 'cmd:prototype-cli:mobilize',
      expectedVersion: currentVersion,
      units: [
        { unitId: 'rifle', count: 10 },
        { unitId: 'scout', count: 1 },
        { unitId: 'medium_tank', count: 2 },
        { unitId: 'howitzer', count: 1 },
      ],
    }),
  });
  assert.equal(mobilized.status, 201);
  const mobilizedBody = await mobilized.json() as { response: { cityVersion: number } };
  currentVersion = mobilizedBody.response.cityVersion;

  const scouted = await fetch(`${base}/v1/cities/city%3Aprototype/recon`, {
    method: 'POST',
    headers: commandHeaders,
    body: JSON.stringify({
      commandId: 'cmd:prototype-cli:recon',
      expectedVersion: currentVersion,
      scenarioId: 'training_outpost',
    }),
  });
  assert.equal(scouted.status, 201);
  const scoutedBody = await scouted.json() as { response: { cityVersion: number } };
  currentVersion = scoutedBody.response.cityVersion;

  const fought = await fetch(`${base}/v1/cities/city%3Aprototype/battles`, {
    method: 'POST',
    headers: commandHeaders,
    body: JSON.stringify({
      commandId: 'cmd:prototype-cli:battle',
      expectedVersion: currentVersion,
      scenarioId: 'training_outpost',
      deployment: [
        { unitId: 'rifle', count: 10, row: 'front' },
        { unitId: 'medium_tank', count: 2, row: 'front' },
        { unitId: 'scout', count: 1, row: 'mid' },
        { unitId: 'howitzer', count: 1, row: 'back' },
      ],
      doctrine: 'artillery_support',
    }),
  });
  assert.equal(fought.status, 201);
  const foughtBody = await fought.json() as {
    response: {
      campaignRuleVersion: string;
      report: { result: { outcome: string }; campaignRuleVersion: string };
    };
  };
  assert.equal(foughtBody.response.campaignRuleVersion, '0.2.0');
  assert.equal(foughtBody.response.report.campaignRuleVersion, '0.2.0');
  assert.equal(foughtBody.response.report.result.outcome, 'attacker_win');

  const completedLoop = await fetch(`${base}/v1/cities/city%3Aprototype/operations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(completedLoop.status, 200);
  const completedSnapshot = await completedLoop.json() as {
    battleReports: unknown[];
    campaignRuleVersion: string;
  };
  assert.equal(completedSnapshot.campaignRuleVersion, '0.2.0');
  assert.equal(completedSnapshot.battleReports.length, 1);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`prototype 종료 시간 초과\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(exitCode, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);

  const firstHour = Number(stdout.match(/현재 권위 시각: h(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(firstHour), '첫 실행 권위 시각을 출력해야 한다.');
  const clockPath = `${databasePath}.clock.json`;
  const clockBeforeRestart = readFileSync(clockPath, 'utf8');

  const reopened = await ConstructionServer.open(databasePath);
  try {
    await assert.rejects(
      async () => await reopened.authenticateToken(token),
      (error: unknown) => error instanceof ServerError && error.code === 'UNAUTHORIZED',
      '정상 종료한 로컬 세션 토큰은 폐기되어야 한다.',
    );
  } finally {
    await reopened.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  const restarted = spawn(process.execPath, [
    tsxCli,
    entry,
    `--db=${databasePath}`,
    '--port=0',
    '--hour-ms=200',
    '--run-ms=300',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let restartStdout = '';
  let restartStderr = '';
  restarted.stdout.on('data', (chunk: Buffer) => { restartStdout += chunk.toString('utf8'); });
  restarted.stderr.on('data', (chunk: Buffer) => { restartStderr += chunk.toString('utf8'); });
  const restartExitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      restarted.kill();
      reject(new Error(`prototype 재시작 종료 시간 초과\nstdout:\n${restartStdout}\nstderr:\n${restartStderr}`));
    }, 30_000);
    restarted.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    restarted.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(restartExitCode, 0, `stdout:\n${restartStdout}\nstderr:\n${restartStderr}`);
  const restartedHour = Number(restartStdout.match(/현재 권위 시각: h(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(restartedHour));
  assert.ok(restartedHour > firstHour, '재시작 사이의 실제 경과 시간이 권위 시각에 반영되어야 한다.');
  assert.equal(readFileSync(clockPath, 'utf8'), clockBeforeRestart, '재시작이 epoch를 다시 앵커링하면 안 된다.');
});

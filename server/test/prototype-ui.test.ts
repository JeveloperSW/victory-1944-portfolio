import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPrototypePage } from '../src/prototype-ui.js';

test('프로토타입 UI: 루프백 첫 루프 계약과 접근성 표지를 렌더링한다', () => {
  const page = renderPrototypePage({ token: 'token:player', cityId: 'city:tutorial' });

  assert.match(page, /^<!doctype html>/);
  assert.match(page, /lang="ko"/);
  assert.match(page, /내부 검증용/);
  assert.match(page, /공개 배포 금지/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /\/constructions/);
  assert.match(page, /\/mobilizations/);
  assert.match(page, /\/recon/);
  assert.match(page, /\/battles/);
  assert.match(page, /\/operations/);
  assert.match(page, /authorization/);
  assert.match(page, /Bearer /);
  assert.match(page, /expectedVersion/);
  assert.match(page, /errorCode === 'STALE_VERSION'/);
  assert.match(page, /staleRetryCount === 0/);
  assert.match(page, /최신 상태 조회 후 1회 재시도/);
  assert.match(page, /scenarioId: SCENARIO_ID/);
  assert.match(page, /doctrine: DOCTRINE/);
  assert.match(page, /row: ROW_BY_UNIT/);
  assert.match(page, /api\('\/health'\)/);
  assert.match(page, /authoritativeNowHour/);
  assert.match(page, /remainingHours: Math\.max\(0, expiresAtHour - nowHour\)/);
  assert.match(page, /requireActiveRecon\(\)/);
  assert.match(page, /RECON_EXPIRED/);
  assert.match(page, /\{ refreshBefore: true \}/);
  assert.match(page, /\{ unitId: 'rifle', count: 10 \}/);
  assert.match(page, /\{ unitId: 'medium_tank', count: 2 \}/);
  assert.match(page, /\{ unitId: 'scout', count: 1 \}/);
  assert.match(page, /\{ unitId: 'howitzer', count: 1 \}/);
  assert.match(page, /raw \/ 1000/);
  assert.match(page, /data\.minimum/);
  assert.match(page, /data\.maximum/);
  assert.match(page, /data\.dead/);
  assert.match(page, /data\.wounded/);
  assert.match(page, /analysis\.recommendations/);
  assert.match(page, /job\.status === 'pending'/);
  assert.match(page, /job\.status === 'completed'/);
  assert.match(page, /item\.dataset\.status/);
  assert.match(page, /item\.setAttribute\(\s*'aria-label'/);
  assert.match(page, /className = 'visually-hidden'/);
  assert.doesNotMatch(page, /<svg|<img|https?:\/\//);
});

test('프로토타입 UI: 주입 값은 inline script 종료나 새 요소를 만들 수 없다', () => {
  const token = '</script><script>globalThis.pwned=true</script>&\u2028';
  const cityId = '</script><img src=x onerror=alert(1)>';
  const page = renderPrototypePage({ token, cityId });

  assert.equal(page.includes(token), false);
  assert.equal(page.includes(cityId), false);
  assert.equal(page.match(/<script>/g)?.length, 1);
  assert.equal(page.match(/<\/script>/g)?.length, 1);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /\\u003c\/script\\u003e/);
  assert.match(page, /\\u0026\\u2028/);
});

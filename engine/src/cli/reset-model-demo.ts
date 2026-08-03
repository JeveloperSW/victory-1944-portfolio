/**
 * 초기화 모델 비교 — D-027 승인 조건 1의 근거 수치를 생성한다.
 * 실행: npm run demo:reset-models
 *
 * 경제 축만 다루며 실제 승률·영토 점유율이 아니다. 판단 근거일 뿐 결론이 아니다.
 */
import {
  ECONOMY_ARCHETYPES,
  ECONOMY_RULESETS,
  buildingDef,
  RESET_MODEL_LABELS,
  compareAllModels,
  daysToBuildingCap,
  runSeasonChain,
  seasonsToBuildingCap,
  simulateSeason,
} from '../index.js';
import type { ArchetypeInput, ResetModel } from '../index.js';

const RULE_VERSION = '0.1.0';
const SEASONS = 4;
const DAYS = 42;

function pad(text: string, width: number): string {
  const length = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - length));
}

function ratioText(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function reportGrowthCurve(archetype: ArchetypeInput): void {
  const report = simulateSeason({ ruleVersion: RULE_VERSION, archetype, days: DAYS });
  const capDay = daysToBuildingCap(report, RULE_VERSION);
  const rules = ECONOMY_RULESETS[RULE_VERSION]!;
  const maxTotal = Object.values(rules.buildings).reduce((sum, b) => sum + b.maxLevel, 0);
  const finalTotal = Object.values(report.finalBuildings).reduce((sum, level) => sum + level, 0);
  console.log(
    `  ${pad(archetype.nameKo, 10)} 상한 도달일: ${capDay === null ? `미도달 (${finalTotal}/${maxTotal})` : `${capDay}일차`}`
    + ` · 완료 건설 ${report.constructionCompleted}건 · 최종 군사 가치 ${report.armyValue}`,
  );
}

function reportModel(archetype: ArchetypeInput, model: ResetModel): void {
  const chain = runSeasonChain(
    { ruleVersion: RULE_VERSION, archetype, seasons: SEASONS, days: DAYS },
    model,
  );
  const values = chain.map((report) => report.armyValue);
  const levels = chain.map((report) =>
    Object.values(report.finalBuildings).reduce((sum, level) => sum + level, 0));
  console.log(
    `    ${pad(RESET_MODEL_LABELS[model], 44)}`
    + ` 군사가치 ${values.map((value) => String(value).padStart(6)).join(' →')}`
    + ` · 건물합 ${levels.join('→')}`,
  );
}

console.log('=== Victory 1944 초기화 모델 비교 (D-027 근거) ===');
console.log(`규칙 v${RULE_VERSION} · 시즌 ${SEASONS}회 × ${DAYS}일 · 경제 축만 측정`);
console.log('');

console.log('[1] 성장 곡선: 도시 상한 도달일 (42일 시즌이 곡선에 맞는가)');
for (const archetype of Object.values(ECONOMY_ARCHETYPES)) {
  reportGrowthCurve(archetype);
}
console.log('');

console.log('[2] 모델별 시즌 진행 (시즌1 → 시즌4)');
for (const archetype of Object.values(ECONOMY_ARCHETYPES)) {
  console.log(`  ${archetype.nameKo}`);
  for (const model of ['full_reset', 'hybrid', 'fully_persistent'] as const) {
    reportModel(archetype, model);
  }
}
console.log('');

console.log('[3] 시즌 4 시점 신규/기존 군사 가치 비 (100%면 신규가 불리하지 않음)');
for (const archetype of Object.values(ECONOMY_ARCHETYPES)) {
  const results = compareAllModels({
    ruleVersion: RULE_VERSION,
    archetype,
    seasons: SEASONS,
    days: DAYS,
  });
  const cells = results
    .map((result) => `${result.model === 'full_reset' ? '전체초기화' : result.model === 'hybrid' ? '혼합형' : '완전영구'} ${ratioText(result.newcomerRatio)}`)
    .join(' · ');
  console.log(`  ${pad(archetype.nameKo, 10)} ${cells}`);
}
console.log('');
console.log('해석 주의: 군사 가치는 경제 산출의 대리 지표이며 실제 전투 승률이 아니다.');
console.log('연맹 전력·영토 점유·약탈 손실은 이 모델에 포함되지 않았다.');

// ---------------------------------------------------------------------------
// [4] 곡선 심화 후보: 영구 도시에서 상한 도달까지 몇 시즌이 걸리는가
// ---------------------------------------------------------------------------
console.log('');
console.log('[4] 곡선 심화 후보 (영구 도시 가정, 혼합형 인계, 최대 8시즌 관측)');
const DRAFT_VERSIONS = ['0.1.0', '0.2.0-draft-levels', '0.2.0-draft-cost', '0.2.0-draft-both'];
for (const version of DRAFT_VERSIONS) {
  const rules = ECONOMY_RULESETS[version]!;
  const sample = buildingDef(rules, 'farm');
  console.log(
    `  ${pad(version, 22)} 최대레벨 ${String(sample.maxLevel).padStart(2)}`
    + ` · 비용증가율 ${sample.costGrowth.toFixed(2)} · 시간증가율 ${sample.hourGrowth.toFixed(2)}`
    + ` · 창고/레벨 ${rules.balance.warehouseCapPerLevel}`,
  );
  for (const archetype of Object.values(ECONOMY_ARCHETYPES)) {
    const result = seasonsToBuildingCap({
      ruleVersion: version,
      archetype,
      seasons: 8,
      days: DAYS,
    });
    const text = result.season === null
      ? `8시즌 내 미도달 (${result.finalLevels}/${result.maxLevels})`
      : `${result.season}시즌차 도달`;
    console.log(`      ${pad(archetype.nameKo, 12)} ${text}`);
  }
}
console.log('');
console.log('영구 도시에서는 상한 도달이 곧 성장 축의 종료다. 시즌 1~2에 도달하면 곡선이 얕다.');

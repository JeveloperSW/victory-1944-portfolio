/**
 * 시나리오 사다리 난이도 보고서(D-046).
 *
 * 밸런스를 눈대중으로 고치지 않기 위한 계측 도구다. 규칙을 바꾸기 전과 후에 같은 표를 뽑아
 * 무엇이 어떻게 달라졌는지 숫자로 남긴다. 계산은 `campaign/ladder-metrics.ts`에 있고
 * 회귀 테스트가 같은 함수를 쓴다 — 보고서와 테스트가 갈라지지 않게 하기 위해서다.
 *
 * 실행: `npm run ladder` 또는 `tsx src/cli/ladder-report.ts [캠페인버전]`
 */

import { CAMPAIGN_RULESETS, CURRENT_CAMPAIGN_RULE_VERSION } from '../campaign/rules/index.js';
import { bundleValue, measureLadder } from '../campaign/ladder-metrics.js';
import type { PartialBundle } from '../economy/types.js';

function formatBundle(bundle: PartialBundle): string {
  return Object.entries(bundle)
    .filter(([, amount]) => (amount ?? 0) > 0)
    .map(([id, amount]) => `${id} ${Math.round(amount!)}`)
    .join(' ');
}

function main(): void {
  const version = process.argv[2] ?? CURRENT_CAMPAIGN_RULE_VERSION;
  const campaign = CAMPAIGN_RULESETS[version as keyof typeof CAMPAIGN_RULESETS];
  if (!campaign) throw new Error(`알 수 없는 캠페인 규칙: ${version}`);
  const tiers = measureLadder(version);

  console.log(`캠페인 ${campaign.version} · 경제 ${campaign.economyRuleVersion} · 전투 ${campaign.combatRuleVersion}`);
  console.log('');

  for (const tier of tiers) {
    console.log(`■ ${tier.tier}. ${tier.nameKo} (${tier.scenarioId})`);
    console.log(`  방어: ${tier.defenderUnits}기 · 전투가치 ${tier.defenderValue}`);
    console.log(`  가정 생산: ${formatBundle(tier.perHour)} /시간`);
    console.log(`  편성: ${tier.shape.map((entry) => `${entry.unitId}×${entry.weight}`).join(' ')}`);
    console.log('   배수 | 병력 | 승률 | 평균손실 | 라운드 | 훈련비 | 필요시간');
    for (const scale of tier.scales) {
      const flag = scale === tier.pass ? ' ←통과' : '';
      console.log(
        `  ${String(scale.scale).padStart(5)} | ${String(scale.units).padStart(4)}`
        + ` | ${(scale.winRate * 100).toFixed(0).padStart(3)}%`
        + ` | ${(scale.avgLossRate * 100).toFixed(0).padStart(7)}%`
        + ` | ${scale.avgRounds.toFixed(1).padStart(6)}`
        + ` | ${formatBundle(scale.cost).padEnd(38)}`
        + ` | ${scale.hours === Number.POSITIVE_INFINITY ? '불가' : `${scale.hours.toFixed(1)}h`}${flag}`,
      );
    }
    if (tier.pass === null) {
      console.log('  → 이 편성으로는 어떤 규모로도 통과 승률에 닿지 않는다.');
    } else {
      const reward = bundleValue(
        campaign.scenarios[tier.scenarioId]!.victoryReward,
      );
      console.log(`  → 통과 규모 ${tier.pass.units}기 · 필요 시간 ${tier.pass.hours.toFixed(1)}h`);
      console.log(
        `     승리 1회 손익: 보상 ${reward.toFixed(0)}`
        + ` − 출정 ${bundleValue(tier.pass.sortie).toFixed(0)}`
        + ` − 전사 ${tier.pass.deadValue.toFixed(0)}`
        + ` − 회복 ${(tier.pass.recoverySupplies * 1.5).toFixed(0)}`
        + ` = ${tier.net >= 0 ? '+' : ''}${tier.net.toFixed(0)}`,
      );
      console.log(`     효율(순이득/병력): ${tier.efficiency.toFixed(1)}`);
    }
    console.log('');
  }

  console.log('요약 (단계별로 커져야 한다)');
  console.log(`  통과 규모: ${tiers.map((tier) => tier.pass?.units ?? '-').join(' → ')}`);
  console.log(`  순이득   : ${tiers.map((tier) => tier.net.toFixed(0)).join(' → ')}`);
  console.log(`  효율     : ${tiers.map((tier) => tier.efficiency.toFixed(1)).join(' → ')}`);
}

main();

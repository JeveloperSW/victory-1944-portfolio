/**
 * 전투 PoC 데모 — 로드맵 1단계 통과 기준 시연.
 * 동일 비용 부대에서 조합·정찰·진형이 승패와 손실을 바꾸는 것을 보여준다.
 * 실행: npm run demo
 */
import { analyzeBattle } from '../analysis.js';
import type { ArmySnapshot, BattleInput, BattleResult, StackOrder } from '../types.js';
import { RULESETS } from '../rules/index.js';
import { simulateBattle } from '../simulate.js';

const RULE_VERSION = '0.1.0';
const rules = RULESETS[RULE_VERSION]!;

function army(stacks: StackOrder[], overrides: Partial<ArmySnapshot> = {}): ArmySnapshot {
  return {
    stacks,
    doctrine: 'none',
    supply: 1,
    reconAccuracy: 0.5,
    retreatThreshold: 0.2,
    ...overrides,
  };
}

function cost(snapshot: ArmySnapshot): number {
  return snapshot.stacks.reduce((sum, s) => sum + rules.units[s.unitId]!.cost * s.count, 0);
}

const OUTCOME_KO: Record<BattleResult['outcome'], string> = {
  attacker_win: '공격 측 승리',
  defender_win: '방어 측 승리',
  draw: '무승부',
};

const REASON_KO: Record<BattleResult['reason'], string> = {
  annihilation: '섬멸',
  retreat: '철수',
  mutual_retreat: '상호 철수',
  timeout: '교착(라운드 상한)',
};

function sideBlock(label: string, report: BattleResult['attacker']): string {
  const lines = report.stacks.map((s) => {
    const loss = s.dead + s.wounded;
    return `    ${s.nameKo.padEnd(6, '　')} [${s.row}] ${String(s.initial).padStart(3)}기 → 생존 ${String(s.survivors).padStart(3)} (전사 ${s.dead}, 부상 ${s.wounded}, 손실률 ${Math.round((loss / s.initial) * 100)}%)`;
  });
  return [
    `  ${label} | 비용 ${report.totalCost} | 정찰 점수 ${report.reconScore}${report.infoAdvantage ? ' (정보 우위)' : ''} | 잔존 전투력 ${Math.round(report.remainingRatio * 100)}%`,
    ...lines,
  ].join('\n');
}

function run(title: string, input: BattleInput, note: string): void {
  const result = simulateBattle(input);
  const analysis = analyzeBattle(result);
  console.log('═'.repeat(72));
  console.log(`■ ${title}`);
  console.log(`  ${note}`);
  console.log('─'.repeat(72));
  console.log(`  결과: ${OUTCOME_KO[result.outcome]} (${REASON_KO[result.reason]}, ${result.rounds}라운드)`);
  console.log(`  선제권: ${result.initiative === 'attacker' ? '공격 측' : result.initiative === 'defender' ? '방어 측' : '없음'}`);
  console.log(sideBlock('공격 측', result.attacker));
  console.log(sideBlock('방어 측', result.defender));
  const top = result.counters.slice(0, 3);
  if (top.length > 0) {
    console.log('  상성 기여 상위:');
    for (const c of top) {
      const who = c.side === 'attacker' ? '공격' : '방어';
      console.log(`    [${who}] ${rules.units[c.unitId]!.nameKo} → ${rules.units[c.targetUnitId]!.nameKo}: x${c.multiplier}, 누적 피해 ${c.totalDamage}`);
    }
  }
  console.log(`  전투 분석: ${analysis.issues.map((issue) => issue.messageKo).join(' ')}`);
  console.log(`  개선 추천: ${analysis.recommendations.map((item) => item.messageKo).join(' ')}`);
  console.log(`  재현 정보: 규칙 v${result.ruleVersion}, 시드 ${result.seed}, 해시 ${result.hash}`);
}

const seed = 20260718;

// 시나리오 1 — 조합: 동일 비용 800
const tankRush = army([{ unitId: 'heavy_tank', count: 10, row: 'front' }]);
const combined = army([
  { unitId: 'rifle', count: 22, row: 'front' },
  { unitId: 'at_infantry', count: 12, row: 'front' },
  { unitId: 'at_gun', count: 10, row: 'mid' },
]);
run(
  '시나리오 1 · 병종 조합 — 중전차 몰빵 vs 대전차 제병 협동',
  { ruleVersion: RULE_VERSION, seed, attacker: tankRush, defender: combined },
  `양측 비용 동일(${cost(tankRush)} vs ${cost(combined)}). 상성이 승패를 결정하는지 확인.`,
);

// 시나리오 2 — 정찰: 동일 구성 거울 부대
const mirror: StackOrder[] = [
  { unitId: 'medium_tank', count: 8, row: 'front' },
  { unitId: 'rifle', count: 10, row: 'front' },
  { unitId: 'howitzer', count: 2, row: 'back' },
  { unitId: 'scout', count: 2, row: 'mid' },
];
const reconAttacker = army(structuredClone(mirror), {
  reconAccuracy: 0.8,
  officer: { name: '강정찰', command: 0, tactics: 0, admin: 0, intel: 60, logistics: 0 },
});
const reconDefender = army(structuredClone(mirror), { reconAccuracy: 0.2 });
run(
  '시나리오 2 · 정보전 — 완전히 같은 부대, 정찰 우위만 다름',
  { ruleVersion: RULE_VERSION, seed, attacker: reconAttacker, defender: reconDefender },
  `양측 비용·구성 동일(${cost(reconAttacker)}). 정찰 정확도 0.8+정보장교 vs 0.2. 선제권 효과 확인.`,
);

// 시나리오 3 — 진형: 야포를 최전열에 노출 vs 전열 뒤 보호
const howitzerFront = army(
  [
    { unitId: 'howitzer', count: 5, row: 'front' },
    { unitId: 'medium_tank', count: 4, row: 'mid' },
    { unitId: 'rifle', count: 9, row: 'mid' },
  ],
  { retreatThreshold: 0.1 },
);
const howitzerBack = army(
  [
    { unitId: 'howitzer', count: 5, row: 'back' },
    { unitId: 'medium_tank', count: 4, row: 'front' },
    { unitId: 'rifle', count: 9, row: 'front' },
  ],
  { retreatThreshold: 0.1 },
);
run(
  '시나리오 3 · 진형 — 같은 부대, 야포를 최전열에 노출 vs 전열 뒤 보호',
  { ruleVersion: RULE_VERSION, seed, attacker: howitzerFront, defender: howitzerBack },
  `양측 비용·구성 동일(${cost(howitzerFront)}). 진형 실수가 처벌되는지 확인.`,
);

console.log('═'.repeat(72));
console.log('로드맵 1단계 통과 기준: "동일 전투력에서도 정찰·조합·진형이 의미 있는 차이를 만든다"');

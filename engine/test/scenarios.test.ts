import { describe, expect, it } from 'vitest';
import { CAMPAIGN_RULESETS, CURRENT_CAMPAIGN_RULE_VERSION } from '../src/campaign/index.js';
import { simulateBattle } from '../src/index.js';
import { RULESETS } from '../src/rules/index.js';
import type { DoctrineId, Row, StackOrder } from '../src/types.js';
import type { NpcScenario } from '../src/campaign/types.js';

const ROWS: readonly Row[] = ['front', 'mid', 'back'];

/** 시나리오 사다리(D-040)의 형식 불변식. 밸런스 수치는 검사 대상이 아니다. */

const current = CAMPAIGN_RULESETS[
  CURRENT_CAMPAIGN_RULE_VERSION as keyof typeof CAMPAIGN_RULESETS
];
const scenarios = Object.values(current.scenarios) as NpcScenario[];

describe('현재 캠페인 규칙의 시나리오 사다리', () => {
  it('현재 버전은 레지스트리에 있다', () => {
    expect(current).toBeDefined();
    expect(current.version).toBe(CURRENT_CAMPAIGN_RULE_VERSION);
  });

  it('시나리오가 여러 개 있고 id와 키가 일치한다', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    for (const [key, scenario] of Object.entries(current.scenarios)) {
      expect(scenario.id).toBe(key);
      expect(scenario.nameKo.length).toBeGreaterThan(0);
    }
  });

  it('모든 시나리오가 설명과 단계를 갖는다', () => {
    for (const scenario of scenarios) {
      expect(scenario.briefKo, `${scenario.id} 설명 없음`).toBeTruthy();
      expect(typeof scenario.tier, `${scenario.id} 단계 없음`).toBe('number');
    }
  });

  it('단계는 1부터 빈 곳 없이 이어지고 중복이 없다', () => {
    const tiers = scenarios.map((scenario) => scenario.tier!).sort((a, b) => a - b);
    expect(tiers).toEqual(tiers.map((_, index) => index + 1));
  });

  it('해금 사슬은 존재하는 시나리오를 가리키고 순환하지 않는다', () => {
    const roots = scenarios.filter((scenario) => scenario.unlockAfter === undefined);
    expect(roots, '해금 조건 없는 시작 시나리오는 정확히 하나여야 한다').toHaveLength(1);
    for (const scenario of scenarios) {
      if (scenario.unlockAfter === undefined) continue;
      const parent = current.scenarios[scenario.unlockAfter];
      expect(parent, `${scenario.id}의 해금 대상이 없다`).toBeDefined();
      // 선행 시나리오는 반드시 더 낮은 단계여야 한다 — 이것만 지키면 순환이 생기지 않는다.
      expect(parent!.tier!).toBeLessThan(scenario.tier!);
    }
  });

  it('방어 편성은 알려진 병종과 열만 쓴다', () => {
    const rules = RULESETS[current.combatRuleVersion as keyof typeof RULESETS];
    expect(rules).toBeDefined();
    for (const scenario of scenarios) {
      expect(scenario.defender.stacks.length).toBeGreaterThan(0);
      for (const stack of scenario.defender.stacks) {
        expect(rules!.units[stack.unitId], `${scenario.id}: ${stack.unitId}`).toBeDefined();
        expect(ROWS).toContain(stack.row);
        expect(stack.count).toBeGreaterThan(0);
        expect(Number.isInteger(stack.count)).toBe(true);
      }
      expect(rules!.doctrines[scenario.defender.doctrine]).toBeDefined();
    }
  });

  it('보상은 양수이며 단계가 오를수록 군표가 줄지 않는다', () => {
    const ordered = [...scenarios].sort((a, b) => a.tier! - b.tier!);
    let previousScrip = 0;
    for (const scenario of ordered) {
      const scrip = scenario.victoryReward.scrip ?? 0;
      expect(scrip, `${scenario.id} 군표 보상`).toBeGreaterThan(0);
      expect(scrip, `${scenario.id}는 앞 단계보다 보상이 낮다`).toBeGreaterThanOrEqual(previousScrip);
      previousScrip = scrip;
      for (const [resourceId, amount] of Object.entries(scenario.victoryReward)) {
        expect(amount, `${scenario.id}.${resourceId}`).toBeGreaterThan(0);
      }
    }
  });

  it('이전 규칙 버전의 시나리오를 지우지 않는다', () => {
    for (const id of Object.keys(CAMPAIGN_RULESETS['0.2.0'].scenarios)) {
      expect(current.scenarios[id], `${id}가 사라졌다`).toBeDefined();
    }
  });
});

/**
 * 교리 선택(D-041)이 실제로 전투 결과를 바꾸는지 확인한다.
 * 같은 seed·같은 편성으로 교리만 바꿔 비교해야 난수·적 구성의 영향을 배제할 수 있다.
 */
describe('교리는 같은 조건에서 결과를 바꾼다', () => {
  const attackerStacks: StackOrder[] = [
    { unitId: 'rifle', count: 10, row: 'front' },
    { unitId: 'medium_tank', count: 2, row: 'front' },
    { unitId: 'scout', count: 2, row: 'mid' },
    { unitId: 'howitzer', count: 2, row: 'back' },
  ];
  const defenderStacks: StackOrder[] = [
    { unitId: 'rifle', count: 8, row: 'front' },
    { unitId: 'at_infantry', count: 2, row: 'front' },
  ];

  function damageBy(doctrine: DoctrineId, unitId: string, seed: number): number {
    const result = simulateBattle({
      ruleVersion: current.combatRuleVersion,
      seed,
      attacker: {
        stacks: attackerStacks,
        doctrine,
        supply: 1,
        reconAccuracy: 0.6,
        retreatThreshold: 0.2,
      },
      defender: {
        stacks: defenderStacks,
        doctrine: 'none',
        supply: 1,
        reconAccuracy: 0.5,
        retreatThreshold: 0.2,
      },
    });
    return result.attacker.stacks.find((stack) => stack.unitId === unitId)?.damageDealt ?? 0;
  }

  it('정찰·기동 교리는 정찰 유닛 피해를 약 1.5배로 만든다', () => {
    for (const seed of [1, 2, 3]) {
      const base = damageBy('none', 'scout', seed);
      const boosted = damageBy('recon_mobility', 'scout', seed);
      expect(base).toBeGreaterThan(0);
      expect(boosted / base).toBeCloseTo(1.5, 1);
    }
  });

  it('포병 지원 교리는 포병 피해를 약 1.2배로 만든다', () => {
    for (const seed of [1, 2, 3]) {
      const base = damageBy('none', 'howitzer', seed);
      const boosted = damageBy('artillery_support', 'howitzer', seed);
      expect(base).toBeGreaterThan(0);
      expect(boosted / base).toBeCloseTo(1.2, 1);
    }
  });

  it('교리는 대상이 아닌 병종에는 영향을 주지 않는다', () => {
    // 포병 지원은 포병만 올린다. 소총병 피해가 같아야 배수가 엉뚱한 곳에 걸리지 않은 것이다.
    const base = damageBy('none', 'rifle', 7);
    const withArtillery = damageBy('artillery_support', 'rifle', 7);
    expect(withArtillery).toBeCloseTo(base, 5);
  });
});

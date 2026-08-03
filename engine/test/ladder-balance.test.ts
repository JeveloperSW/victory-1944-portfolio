import { describe, expect, it } from 'vitest';
import { CURRENT_CAMPAIGN_RULE_VERSION } from '../src/campaign/rules/index.js';
import { measureLadder } from '../src/campaign/ladder-metrics.js';

/**
 * 사다리 밸런스 목표(D-046).
 *
 * 수치를 고정하지 않는다 — 밸런스는 앞으로도 바뀐다.
 * 대신 **관계**를 고정한다. 이 셋이 깨지면 사다리가 사다리가 아니게 된다.
 *
 * 1. 위 단계일수록 더 큰 부대가 필요하다.
 * 2. 모든 단계는 이기면 남는 것이 있다. (이길수록 가난해지는 단계가 없다)
 * 3. 위 단계일수록 병력 1기당 이득이 크다. (낮은 단계 반복이 최적이 아니다)
 */
describe('시나리오 사다리 밸런스 (D-046)', () => {
  const tiers = measureLadder(CURRENT_CAMPAIGN_RULE_VERSION);

  it('모든 단계가 기준 편성으로 통과 가능하다', () => {
    for (const tier of tiers) {
      expect(tier.pass, `${tier.tier}단계 ${tier.nameKo}는 어떤 규모로도 통과하지 못한다`).not.toBeNull();
    }
  });

  it('위 단계일수록 더 큰 부대가 필요하다', () => {
    const sizes = tiers.map((tier) => tier.pass!.units);
    for (let index = 1; index < sizes.length; index += 1) {
      expect(
        sizes[index],
        `${index + 1}단계 통과 규모(${sizes[index]})가 ${index}단계(${sizes[index - 1]})보다 크지 않다`,
      ).toBeGreaterThan(sizes[index - 1]!);
    }
  });

  it('어느 단계도 이겨서 손해 보지 않는다', () => {
    for (const tier of tiers) {
      expect(
        tier.net,
        `${tier.tier}단계 ${tier.nameKo}는 이겨도 순손실이다`,
      ).toBeGreaterThan(0);
    }
  });

  it('위 단계일수록 병력 1기당 이득이 크다', () => {
    const efficiencies = tiers.map((tier) => tier.efficiency);
    for (let index = 1; index < efficiencies.length; index += 1) {
      expect(
        efficiencies[index],
        `${index + 1}단계 효율(${efficiencies[index]!.toFixed(1)})이`
        + ` ${index}단계(${efficiencies[index - 1]!.toFixed(1)})보다 크지 않다`
        + ' — 낮은 단계를 반복하는 쪽이 이득이 된다',
      ).toBeGreaterThan(efficiencies[index - 1]!);
    }
  });

  it('첫 단계는 시작 도시의 자원만으로 통과 편성을 마련할 수 있다', () => {
    // 시작 자원으로 첫 부대를 못 만들면 튜토리얼이 첫 화면에서 막힌다.
    const first = tiers[0]!;
    const starting = { food: 500, steel: 500, oil: 200, supplies: 100, manpower: 100, scrip: 50 };
    for (const [resourceId, amount] of Object.entries(first.pass!.cost)) {
      expect(
        amount ?? 0,
        `1단계 통과 편성의 ${resourceId} 비용이 시작 자원을 넘는다`,
      ).toBeLessThanOrEqual(starting[resourceId as keyof typeof starting]);
    }
  });
});

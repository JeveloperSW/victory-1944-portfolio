import { describe, expect, it } from 'vitest';
import { simulateBattle } from '../src/index.js';
import { armyCost, formationMirror, reconMirror } from './helpers.js';

const SEEDS = [1, 2, 3, 4, 5, 11, 42, 777, 999983, 20260718];

function totalLosses(stacks: { dead: number; wounded: number }[]): number {
  return stacks.reduce((sum, s) => sum + s.dead + s.wounded, 0);
}

describe('정찰과 진형 (로드맵 1단계: 동일 전투력·동일 구성에서도 차이를 만든다)', () => {
  it('같은 구성이라도 정찰 우위 측이 선제권을 얻고 손실이 적다', () => {
    for (const seed of SEEDS) {
      const input = reconMirror(seed);
      expect(armyCost(input.attacker)).toBe(armyCost(input.defender));
      const result = simulateBattle(input);
      expect(result.initiative).toBe('attacker');
      expect(result.attacker.infoAdvantage).toBe(true);
      expect(result.attacker.reconScore).toBeGreaterThan(result.defender.reconScore);
      expect(totalLosses(result.attacker.stacks)).toBeLessThan(totalLosses(result.defender.stacks));
      expect(result.attacker.remainingRatio).toBeGreaterThan(result.defender.remainingRatio);
    }
  });

  it('같은 구성이라도 야포를 후열에 둔 측이 야포를 지키고 우세해진다', () => {
    for (const seed of SEEDS) {
      const input = formationMirror(seed);
      expect(armyCost(input.attacker)).toBe(armyCost(input.defender));
      const result = simulateBattle(input);
      const frontHowitzer = result.attacker.stacks.find((s) => s.unitId === 'howitzer')!;
      const backHowitzer = result.defender.stacks.find((s) => s.unitId === 'howitzer')!;
      expect(result.outcome).toBe('defender_win');
      expect(backHowitzer.survivors).toBeGreaterThan(frontHowitzer.survivors);
      expect(result.defender.remainingRatio).toBeGreaterThan(result.attacker.remainingRatio);
    }
  });
});

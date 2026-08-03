import { describe, expect, it } from 'vitest';
import { simulateBattle } from '../src/index.js';
import { bombersVsFlak, formationMirror, reconMirror, tankRushVsCombinedArms } from './helpers.js';

describe('불변식 (병력 보존, 음수 금지, 보고서-이벤트 정합)', () => {
  const scenarios = [tankRushVsCombinedArms, bombersVsFlak, reconMirror, formationMirror];

  it('모든 스택에서 전사 + 부상 + 생존 = 초기 병력', () => {
    for (const make of scenarios) {
      for (const seed of [1, 99, 2026]) {
        const result = simulateBattle(make(seed));
        for (const stack of [...result.attacker.stacks, ...result.defender.stacks]) {
          expect(stack.dead + stack.wounded + stack.survivors).toBe(stack.initial);
          expect(stack.survivors).toBeGreaterThanOrEqual(0);
          expect(stack.dead).toBeGreaterThanOrEqual(0);
          expect(stack.wounded).toBeGreaterThanOrEqual(0);
          expect(stack.damageDealt).toBeGreaterThanOrEqual(0);
          expect(stack.damageTaken).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('잔존 비율은 0..1이고 해시는 64비트 16진 문자열이다', () => {
    for (const make of scenarios) {
      const result = simulateBattle(make(7));
      for (const side of [result.attacker, result.defender]) {
        expect(side.remainingRatio).toBeGreaterThanOrEqual(0);
        expect(side.remainingRatio).toBeLessThanOrEqual(1);
      }
      expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(result.rounds).toBeGreaterThanOrEqual(1);
      expect(result.rounds).toBeLessThanOrEqual(30);
    }
  });

  it('보고서의 피해 합계가 이벤트 합계와 일치한다 (QUALITY_GATES 전투 게이트)', () => {
    const result = simulateBattle(tankRushVsCombinedArms(3));
    for (const side of ['attacker', 'defender'] as const) {
      const reported = result[side].stacks.reduce((sum, s) => sum + s.damageDealt, 0);
      const fromEvents = result.events
        .filter((e) => e.side === side)
        .reduce((sum, e) => sum + e.damage, 0);
      expect(Math.abs(reported - fromEvents)).toBeLessThan(1);
    }
  });
});

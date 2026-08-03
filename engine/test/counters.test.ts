import { describe, expect, it } from 'vitest';
import { simulateBattle } from '../src/index.js';
import { armyCost, army, battle, bombersVsFlak, tankRushVsCombinedArms } from './helpers.js';

const SEEDS = [1, 2, 3, 4, 5];

describe('상성 (로드맵 1단계: 동일 전투력에서 조합이 승패를 가른다)', () => {
  it('동일 비용에서 중전차 몰빵은 대전차 제병 협동에 진다', () => {
    for (const seed of SEEDS) {
      const input = tankRushVsCombinedArms(seed);
      expect(armyCost(input.attacker)).toBe(armyCost(input.defender));
      const result = simulateBattle(input);
      expect(result.outcome).toBe('defender_win');
      const atBonus = result.counters.find(
        (c) => c.side === 'defender' && c.unitId === 'at_gun' && c.targetUnitId === 'heavy_tank',
      );
      expect(atBonus, '대전차포의 상성 피해가 보고서에 기록되어야 한다').toBeDefined();
      expect(atBonus!.multiplier).toBeGreaterThan(2.5);
    }
  });

  it('동일 비용에서 호위 없는 폭격기는 대공 방어에 진다', () => {
    for (const seed of SEEDS) {
      const input = bombersVsFlak(seed);
      expect(armyCost(input.attacker)).toBe(armyCost(input.defender));
      const result = simulateBattle(input);
      expect(result.outcome).toBe('defender_win');
      const bombers = result.attacker.stacks.find((s) => s.unitId === 'bomber')!;
      expect(bombers.survivors).toBeLessThanOrEqual(1);
    }
  });

  it('전투기는 폭격기를 일방적으로 요격한다', () => {
    for (const seed of SEEDS) {
      const input = battle(
        army([{ unitId: 'bomber', count: 5, row: 'back' }], { retreatThreshold: 0 }),
        army([{ unitId: 'fighter', count: 5, row: 'back' }], { retreatThreshold: 0 }),
        seed,
      );
      const result = simulateBattle(input);
      expect(result.outcome).toBe('defender_win');
      expect(result.reason).toBe('annihilation');
      const fighters = result.defender.stacks.find((s) => s.unitId === 'fighter')!;
      expect(fighters.survivors).toBe(5);
    }
  });

  it('전투기 호위는 폭격기 손실을 줄인다', () => {
    for (const seed of SEEDS) {
      const escorted = battle(
        army([
          { unitId: 'bomber', count: 4, row: 'back' },
          { unitId: 'fighter', count: 6, row: 'back' },
        ]),
        army([
          { unitId: 'fighter', count: 6, row: 'back' },
          { unitId: 'rifle', count: 20, row: 'front' },
        ]),
        seed,
      );
      const unescorted = battle(
        army([{ unitId: 'bomber', count: 4, row: 'back' }]),
        army([
          { unitId: 'fighter', count: 6, row: 'back' },
          { unitId: 'rifle', count: 20, row: 'front' },
        ]),
        seed,
      );
      const withEscort = simulateBattle(escorted).attacker.stacks.find((s) => s.unitId === 'bomber')!;
      const withoutEscort = simulateBattle(unescorted).attacker.stacks.find((s) => s.unitId === 'bomber')!;
      expect(withEscort.survivors).toBeGreaterThan(withoutEscort.survivors);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { simulateBattle } from '../src/index.js';
import { mulberry32 } from '../src/rng.js';
import type { ArmySnapshot, BattleInput, DoctrineId, Row, StackOrder } from '../src/types.js';
import { army, battle } from './helpers.js';

const UNIT_IDS = [
  'rifle', 'at_infantry', 'scout', 'medium_tank', 'heavy_tank', 'howitzer',
  'at_gun', 'aa_gun', 'fighter', 'bomber', 'engineer', 'supply_truck',
];
const ROWS: Row[] = ['front', 'mid', 'back'];
const DOCTRINES: DoctrineId[] = [
  'none', 'armor_breakthrough', 'artillery_support', 'air_superiority',
  'defense', 'logistics', 'recon_mobility',
];

function randomArmy(rng: () => number): ArmySnapshot {
  const stackCount = 1 + Math.floor(rng() * 5);
  const stacks: StackOrder[] = [];
  for (let i = 0; i < stackCount; i += 1) {
    stacks.push({
      unitId: UNIT_IDS[Math.floor(rng() * UNIT_IDS.length)]!,
      count: 1 + Math.floor(rng() * 50),
      row: ROWS[Math.floor(rng() * ROWS.length)]!,
      ...(rng() < 0.2 ? { reserveRound: 1 + Math.floor(rng() * 5) } : {}),
    });
  }
  const officer = rng() < 0.5
    ? {
        name: 'fuzz',
        command: Math.floor(rng() * 101),
        tactics: Math.floor(rng() * 101),
        admin: Math.floor(rng() * 101),
        intel: Math.floor(rng() * 101),
        logistics: Math.floor(rng() * 101),
      }
    : undefined;
  return {
    stacks,
    doctrine: DOCTRINES[Math.floor(rng() * DOCTRINES.length)]!,
    supply: Math.round(rng() * 100) / 100,
    reconAccuracy: Math.round(rng() * 100) / 100,
    retreatThreshold: Math.round(rng() * 50) / 100,
    ...(officer ? { officer } : {}),
  };
}

describe('퍼즈: 무작위 부대 100종에서 불변식이 유지된다', () => {
  it('병력 보존·비율 범위·라운드 상한·결정론', () => {
    const rng = mulberry32(777);
    for (let i = 0; i < 100; i += 1) {
      const input: BattleInput = {
        ruleVersion: '0.1.0',
        seed: Math.floor(rng() * 0xffffffff),
        attacker: randomArmy(rng),
        defender: randomArmy(rng),
      };
      const result = simulateBattle(input);
      for (const stack of [...result.attacker.stacks, ...result.defender.stacks]) {
        expect(stack.dead + stack.wounded + stack.survivors).toBe(stack.initial);
        expect(stack.survivors).toBeGreaterThanOrEqual(0);
      }
      for (const side of [result.attacker, result.defender]) {
        expect(side.remainingRatio).toBeGreaterThanOrEqual(0);
        expect(side.remainingRatio).toBeLessThanOrEqual(1);
      }
      expect(result.rounds).toBeLessThanOrEqual(30);
      expect(simulateBattle(input).hash).toBe(result.hash);
    }
  });

  it('대량 화력 섬멸 시 유령 생존자가 없다 (부동소수점 잔여치 회귀)', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const input = battle(
        army([{ unitId: 'heavy_tank', count: 60, row: 'front' }], { retreatThreshold: 0 }),
        army(
          [
            { unitId: 'rifle', count: 3, row: 'front' },
            { unitId: 'engineer', count: 2, row: 'front' },
            { unitId: 'scout', count: 2, row: 'mid' },
            { unitId: 'supply_truck', count: 2, row: 'mid' },
            { unitId: 'at_infantry', count: 3, row: 'back' },
          ],
          { retreatThreshold: 0 },
        ),
        seed,
      );
      const result = simulateBattle(input);
      expect(result.outcome).toBe('attacker_win');
      expect(result.reason).toBe('annihilation');
      expect(result.defender.remainingRatio).toBe(0);
      for (const stack of result.defender.stacks) {
        expect(stack.survivors).toBe(0);
      }
    }
  });
});

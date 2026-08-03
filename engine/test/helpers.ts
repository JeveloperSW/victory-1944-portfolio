import type { ArmySnapshot, BattleInput, StackOrder } from '../src/types.js';
import { RULESETS } from '../src/rules/index.js';

export const RULE_VERSION = '0.1.0';

export function army(stacks: StackOrder[], overrides: Partial<ArmySnapshot> = {}): ArmySnapshot {
  return {
    stacks,
    doctrine: 'none',
    supply: 1,
    reconAccuracy: 0.5,
    retreatThreshold: 0.2,
    ...overrides,
  };
}

export function battle(attacker: ArmySnapshot, defender: ArmySnapshot, seed = 42): BattleInput {
  return { ruleVersion: RULE_VERSION, seed, attacker, defender };
}

/** 부대 총비용 — "동일 전투력" 시나리오 검증용 */
export function armyCost(snapshot: ArmySnapshot): number {
  const rules = RULESETS[RULE_VERSION]!;
  let total = 0;
  for (const stack of snapshot.stacks) {
    total += rules.units[stack.unitId]!.cost * stack.count;
  }
  return total;
}

/** 시나리오: 중전차 몰빵(800) vs 대전차 제병 협동(800) */
export function tankRushVsCombinedArms(seed: number): BattleInput {
  const attacker = army([{ unitId: 'heavy_tank', count: 10, row: 'front' }]);
  const defender = army([
    { unitId: 'rifle', count: 22, row: 'front' },
    { unitId: 'at_infantry', count: 12, row: 'front' },
    { unitId: 'at_gun', count: 10, row: 'mid' },
  ]);
  return battle(attacker, defender, seed);
}

/** 시나리오: 호위 없는 폭격기(500) vs 대공 방어(500) — 섬멸까지 진행 */
export function bombersVsFlak(seed: number): BattleInput {
  const attacker = army(
    [
      { unitId: 'bomber', count: 5, row: 'back' },
      { unitId: 'rifle', count: 5, row: 'front' },
    ],
    { retreatThreshold: 0 },
  );
  const defender = army(
    [
      { unitId: 'aa_gun', count: 10, row: 'mid' },
      { unitId: 'rifle', count: 15, row: 'front' },
    ],
    { retreatThreshold: 0 },
  );
  return battle(attacker, defender, seed);
}

/** 시나리오: 동일 구성 거울 부대 — 정찰 우위만 다름(600 vs 600) */
export function reconMirror(seed: number): BattleInput {
  const composition: StackOrder[] = [
    { unitId: 'medium_tank', count: 8, row: 'front' },
    { unitId: 'rifle', count: 10, row: 'front' },
    { unitId: 'howitzer', count: 2, row: 'back' },
    { unitId: 'scout', count: 2, row: 'mid' },
  ];
  const attacker = army(structuredClone(composition), {
    reconAccuracy: 0.8,
    officer: { name: '강정찰', command: 0, tactics: 0, admin: 0, intel: 60, logistics: 0 },
  });
  const defender = army(structuredClone(composition), { reconAccuracy: 0.2 });
  return battle(attacker, defender, seed);
}

/**
 * 시나리오: 동일 구성 거울 부대 — 야포 배치만 다름(520 vs 520).
 * 공격 측은 야포를 최전열에 단독 노출(전열 실수), 방어 측은 전열 뒤 후열에 보호.
 */
export function formationMirror(seed: number): BattleInput {
  const attacker = army(
    [
      { unitId: 'howitzer', count: 5, row: 'front' },
      { unitId: 'medium_tank', count: 4, row: 'mid' },
      { unitId: 'rifle', count: 9, row: 'mid' },
    ],
    { retreatThreshold: 0.1 },
  );
  const defender = army(
    [
      { unitId: 'howitzer', count: 5, row: 'back' },
      { unitId: 'medium_tank', count: 4, row: 'front' },
      { unitId: 'rifle', count: 9, row: 'front' },
    ],
    { retreatThreshold: 0.1 },
  );
  return battle(attacker, defender, seed);
}

import { describe, expect, it } from 'vitest';
import {
  BattleAnalysisError,
  CAMPAIGN_RULESETS,
  analyzeBattle,
  fnv1a64,
  npcSortieCost,
  simulateBattle,
  stableStringify,
} from '../src/index.js';
import type { BattleResult } from '../src/index.js';
import { army, battle, tankRushVsCombinedArms } from './helpers.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rehash(result: BattleResult): void {
  const { hash: _hash, ...payload } = result;
  result.hash = fnv1a64(stableStringify(payload));
}

describe('첫 전투 NPC 시나리오', () => {
  const rules = CAMPAIGN_RULESETS['0.2.0']!;
  const scenario = rules.scenarios.training_outpost!;

  it('0.1.0을 바꾸지 않고 0.2.0에서 동결된 훈련 전초기지를 제공한다', () => {
    expect(CAMPAIGN_RULESETS['0.1.0']?.scenarios.training_outpost).toBeUndefined();
    expect(scenario.id).toBe('training_outpost');
    expect(scenario.nameKo).toBe('훈련 전초기지');
    expect(rules.scenarios.fortified_roadblock?.id).toBe('fortified_roadblock');
    expect(Object.isFrozen(scenario)).toBe(true);
    expect(Object.isFrozen(scenario.defender.stacks)).toBe(true);
  });

  it('과소 편성은 패배하고 기본 제병협동 편성은 여러 시드에서 승리한다', () => {
    const understrength = army([
      { unitId: 'rifle', count: 5, row: 'front' },
      { unitId: 'scout', count: 1, row: 'mid' },
    ], { reconAccuracy: 0.65, retreatThreshold: 0.35 });
    const combinedArms = army([
      { unitId: 'rifle', count: 10, row: 'front' },
      { unitId: 'medium_tank', count: 2, row: 'front' },
      { unitId: 'scout', count: 1, row: 'mid' },
      { unitId: 'howitzer', count: 1, row: 'back' },
    ], { reconAccuracy: 0.65, retreatThreshold: 0.35 });

    for (const seed of [1, 1944, 20260724]) {
      expect(simulateBattle(battle(understrength, scenario.defender, seed)).outcome)
        .toBe('defender_win');
      expect(simulateBattle(battle(combinedArms, scenario.defender, seed)).outcome)
        .toBe('attacker_win');
    }
  });
});

describe('NPC 출정 비용 공개 경계', () => {
  it('병력 가치를 버전 규칙으로 계산하고 변경 불가능한 정확한 비용을 반환한다', () => {
    const deployment = [
      { unitId: 'rifle', count: 10, row: 'front' },
      { unitId: 'medium_tank', count: 2, row: 'front' },
      { unitId: 'scout', count: 1, row: 'mid' },
      { unitId: 'howitzer', count: 1, row: 'back' },
    ] as const;
    const cost = npcSortieCost('0.2.0', deployment);

    // 전투 가치 260, v0.1.0: supplies=ceil(30+260*0.005), oil=ceil(10+260*0.002)
    expect(cost).toEqual({ oil: 11, supplies: 32 });
    expect(Object.isFrozen(cost)).toBe(true);
  });

  it('미지 규칙과 허용되지 않은 deployment를 거부한다', () => {
    expect(() => npcSortieCost('9.9.9', [])).toThrow();
    expect(() => npcSortieCost('0.2.0', [])).toThrow();
    expect(() => npcSortieCost('0.2.0', [
      { unitId: 'battleship', count: 1, row: 'front' },
    ])).toThrow();
  });
});

describe('구조화 전투 분석', () => {
  it('안정 코드와 상위 상성·사상자 사실을 결정론적으로 반환하고 깊게 동결한다', () => {
    const result = simulateBattle(tankRushVsCombinedArms(20260724));
    const first = analyzeBattle(result);
    const second = analyzeBattle(clone(result));

    expect(second).toEqual(first);
    expect(first.resultHash).toBe(result.hash);
    expect(first.losingSide).toBe('attacker');
    expect(first.issues[0]?.code).toBe('COUNTER_VULNERABILITY');
    expect(first.recommendations[0]?.code).toBe('COUNTER_DECISIVE_UNIT');
    expect(first.keyCounters[0]).toMatchObject({
      side: 'defender',
      unitNameKo: expect.any(String),
      targetUnitNameKo: '중전차',
    });
    for (const fact of Object.values(first.casualties)) {
      expect(fact.survivors + fact.wounded + fact.dead).toBe(fact.initial);
      expect(fact.losses).toBe(fact.wounded + fact.dead);
      expect(fact.lossRate).toBeGreaterThanOrEqual(0);
      expect(fact.lossRate).toBeLessThanOrEqual(1);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.casualties)).toBe(true);
    expect(Object.isFrozen(first.keyCounters)).toBe(true);
    expect(Object.isFrozen(first.keyCounters[0])).toBe(true);
    expect(Object.isFrozen(first.issues)).toBe(true);
    expect(Object.isFrozen(first.recommendations)).toBe(true);
  });

  it('무승부와 상성 없는 패배를 별도 코드로 구분한다', () => {
    const drawResult = simulateBattle(battle(
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { retreatThreshold: 0 }),
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { retreatThreshold: 0 }),
      7,
    ));
    const draw = analyzeBattle(drawResult);
    expect(draw.outcome).toBe('draw');
    expect(draw.issues[0]?.code).toBe('BATTLE_STALEMATE');
    expect(draw.recommendations[0]?.code).toBe('BREAK_STALEMATE');

    const attritionResult = simulateBattle(battle(
      army([{ unitId: 'rifle', count: 2, row: 'front' }], { retreatThreshold: 0.5 }),
      army([{ unitId: 'rifle', count: 8, row: 'front' }], { retreatThreshold: 0 }),
      7,
    ));
    const attrition = analyzeBattle(attritionResult);
    expect(attrition.outcome).toBe('defender_win');
    expect(attrition.keyCounters).toHaveLength(0);
    expect(attrition.issues[0]?.code).toBe('ATTRITION_DEFEAT');
    expect(attrition.recommendations[0]?.code).toBe('ADD_COUNTER_COVERAGE');
  });

  it('해시 변조와 해시만 재계산한 의미 변조를 fail closed로 거부한다', () => {
    const original = simulateBattle(tankRushVsCombinedArms(99));
    const hashTampered = clone(original);
    hashTampered.attacker.stacks[0]!.dead += 1;

    expect(() => analyzeBattle(hashTampered)).toThrowError(BattleAnalysisError);
    try {
      analyzeBattle(hashTampered);
      expect.unreachable('해시 변조를 거부해야 한다');
    } catch (error) {
      expect((error as BattleAnalysisError).code).toBe('RESULT_HASH_MISMATCH');
    }

    const semanticTampered = clone(original);
    semanticTampered.attacker.stacks[0]!.dead += 1;
    rehash(semanticTampered);
    try {
      analyzeBattle(semanticTampered);
      expect.unreachable('병력 보존 변조를 거부해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(BattleAnalysisError);
      expect((error as BattleAnalysisError).code).toBe('INVALID_BATTLE_RESULT');
    }
  });
});

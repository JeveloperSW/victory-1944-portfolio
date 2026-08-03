import { describe, expect, it } from 'vitest';
import { fnv1a64, RULESETS, simulateBattle, stableStringify } from '../src/index.js';
import { army, battle, bombersVsFlak, reconMirror, tankRushVsCombinedArms } from './helpers.js';

describe('결정론 (전투 게이트: 같은 입력·규칙 버전·시드 → 같은 결과 해시)', () => {
  it('같은 입력을 반복 실행하면 결과와 해시가 완전히 같다', () => {
    for (const seed of [1, 7, 12345, 4294967295]) {
      const first = simulateBattle(tankRushVsCombinedArms(seed));
      const second = simulateBattle(tankRushVsCombinedArms(seed));
      expect(second).toEqual(first);
      expect(second.hash).toBe(first.hash);
    }
  });

  it('여러 시나리오에서 100회 반복해도 해시가 흔들리지 않는다', () => {
    const scenarios = [tankRushVsCombinedArms(9), bombersVsFlak(9), reconMirror(9)];
    for (const input of scenarios) {
      const baseline = simulateBattle(input).hash;
      for (let i = 0; i < 100; i += 1) {
        expect(simulateBattle(input).hash).toBe(baseline);
      }
    }
  });

  it('시드가 다르면 난수 경로가 달라질 수 있지만 각 시드 안에서는 안정적이다', () => {
    const a = simulateBattle(tankRushVsCombinedArms(1));
    const b = simulateBattle(tankRushVsCombinedArms(2));
    expect(a.hash).toBe(simulateBattle(tankRushVsCombinedArms(1)).hash);
    expect(b.hash).toBe(simulateBattle(tankRushVsCombinedArms(2)).hash);
  });

  it('결과 해시는 반환된 전투 결과의 모든 필드를 포함한다', () => {
    const noInitiative = simulateBattle(battle(
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { reconAccuracy: 0.5, retreatThreshold: 0 }),
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { reconAccuracy: 0.5, retreatThreshold: 0 }),
      7,
    ));
    const attackerInitiative = simulateBattle(battle(
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { reconAccuracy: 0.6, retreatThreshold: 0 }),
      army([{ unitId: 'supply_truck', count: 1, row: 'front' }], { reconAccuracy: 0.5, retreatThreshold: 0 }),
      7,
    ));

    expect(noInitiative.events).toEqual(attackerInitiative.events);
    expect(noInitiative.initiative).toBeNull();
    expect(attackerInitiative.initiative).toBe('attacker');
    expect(noInitiative.hash).not.toBe(attackerInitiative.hash);

    for (const result of [noInitiative, attackerInitiative]) {
      const { hash, ...resultWithoutHash } = result;
      expect(hash).toBe(fnv1a64(stableStringify(resultWithoutHash)));
    }
  });

  it('규칙 레지스트리와 중첩 규칙은 런타임에 동결되어 같은 버전을 바꿀 수 없다', () => {
    const input = tankRushVsCombinedArms(7);
    const before = simulateBattle(input);
    const rules = RULESETS['0.1.0']!;
    const rifle = rules.units.rifle!;

    expect(Object.isFrozen(RULESETS)).toBe(true);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.units)).toBe(true);
    expect(Object.isFrozen(rules.balance)).toBe(true);
    expect(Object.isFrozen(rifle)).toBe(true);
    expect(Object.isFrozen(rifle.tags)).toBe(true);
    expect(Object.isFrozen(rifle.counters)).toBe(true);

    expect(() => { rifle.attack = 999; }).toThrow(TypeError);
    expect(() => { rules.balance.maxRounds = 1; }).toThrow(TypeError);
    expect(simulateBattle(input)).toEqual(before);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CURVE_DRAFTS,
  ECONOMY_ARCHETYPES,
  ECONOMY_RULESETS,
  EconomyError,
  deepenCurve,
  seasonsToBuildingCap,
  carryOverFor,
  compareAllModels,
  compareModel,
  runSeasonChain,
  simulateSeason,
} from '../src/index.js';
import type { MultiSeasonInput, SeasonInput } from '../src/index.js';

const RULE_VERSION = '0.1.0';
const ARCHETYPE = ECONOMY_ARCHETYPES.two;

function input(overrides: Partial<MultiSeasonInput> = {}): MultiSeasonInput {
  return {
    ruleVersion: RULE_VERSION,
    archetype: ARCHETYPE,
    seasons: 3,
    days: 42,
    ...overrides,
  };
}

describe('시즌 간 인계 (D-027 검토용)', () => {
  it('인계가 없으면 기존 동작과 완전히 같다 (회귀)', () => {
    const base: SeasonInput = { ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 42 };
    const withUndefined: SeasonInput = { ...base, carryOver: undefined };
    expect(simulateSeason(withUndefined)).toEqual(simulateSeason(base));
  });

  it('건물 인계는 시작 상태에 반영된다', () => {
    const base = simulateSeason({ ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 3 });
    const carried = simulateSeason({
      ruleVersion: RULE_VERSION,
      archetype: ARCHETYPE,
      days: 3,
      carryOver: { buildings: { farm: 6, steel_mill: 5 } },
    });
    // 농장·제철소가 6·5에서 출발하므로 3일 뒤 생산 누적이 더 크다.
    expect(carried.totals.food.produced).toBeGreaterThan(base.totals.food.produced);
    expect(carried.finalBuildings.farm).toBeGreaterThanOrEqual(6);
  });

  it('병력·자원 인계가 반영된다', () => {
    const carried = simulateSeason({
      ruleVersion: RULE_VERSION,
      archetype: ARCHETYPE,
      days: 1,
      carryOver: { army: { rifle: 40 }, resources: { steel: 900 } },
    });
    expect(carried.finalArmy.rifle).toBeGreaterThanOrEqual(40);
    expect(carried.armyValue).toBeGreaterThan(0);
  });

  it('같은 인계는 같은 결과를 만든다 (결정론)', () => {
    const seasonInput: SeasonInput = {
      ruleVersion: RULE_VERSION,
      archetype: ARCHETYPE,
      days: 10,
      carryOver: { buildings: { farm: 4 }, army: { rifle: 5 } },
    };
    expect(simulateSeason(seasonInput)).toEqual(simulateSeason(seasonInput));
  });

  it('잘못된 인계를 거부한다', () => {
    const bad: { carryOver: unknown; code: string }[] = [
      { carryOver: { buildings: { unknown_building: 3 } }, code: 'UNKNOWN_CARRY_OVER_BUILDING' },
      { carryOver: { army: { battleship: 3 } }, code: 'UNKNOWN_CARRY_OVER_UNIT' },
      { carryOver: { buildings: { farm: 0 } }, code: 'INVALID_CARRY_OVER' },
      { carryOver: { buildings: { farm: 99 } }, code: 'INVALID_CARRY_OVER' },
      { carryOver: { army: { rifle: -1 } }, code: 'INVALID_CARRY_OVER' },
      { carryOver: { resources: { food: -5 } }, code: 'INVALID_CARRY_OVER' },
      { carryOver: { resources: { unknown: 5 } }, code: 'INVALID_CARRY_OVER' },
      { carryOver: { extra: 1 }, code: 'INVALID_CARRY_OVER' },
      { carryOver: [], code: 'INVALID_CARRY_OVER' },
    ];
    for (const { carryOver, code } of bad) {
      try {
        simulateSeason({
          ruleVersion: RULE_VERSION,
          archetype: ARCHETYPE,
          days: 2,
          carryOver,
        } as SeasonInput);
        expect.unreachable(`${code}로 거부되어야 한다: ${JSON.stringify(carryOver)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EconomyError);
        expect((error as EconomyError).code).toBe(code);
      }
    }
  });
});

describe('초기화 모델 비교', () => {
  it('모델별 인계 규칙이 정의대로 동작한다', () => {
    const first = simulateSeason({ ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 42 });
    expect(carryOverFor('full_reset', first)).toBeUndefined();
    expect(carryOverFor('hybrid', null)).toBeUndefined();

    const hybrid = carryOverFor('hybrid', first);
    expect(hybrid?.buildings).toBeDefined();
    expect(hybrid?.army).toBeUndefined();
    expect(hybrid?.resources).toBeUndefined();

    const persistent = carryOverFor('fully_persistent', first);
    expect(persistent?.buildings).toBeDefined();
    expect(persistent?.army).toBeDefined();
    expect(persistent?.resources).toBeDefined();
  });

  it('전체 초기화는 시즌마다 같은 결과를 반복한다', () => {
    const chain = runSeasonChain(input({ seasons: 3 }), 'full_reset');
    expect(chain).toHaveLength(3);
    expect(chain[1]).toEqual(chain[0]);
    expect(chain[2]).toEqual(chain[0]);
  });

  it('혼합형·완전 영구형은 시즌이 지날수록 건물이 누적된다', () => {
    for (const model of ['hybrid', 'fully_persistent'] as const) {
      const chain = runSeasonChain(input({ seasons: 3 }), model);
      const levels = chain.map((report) =>
        Object.values(report.finalBuildings).reduce((sum, level) => sum + level, 0));
      expect(levels[1]).toBeGreaterThanOrEqual(levels[0]!);
      expect(levels[2]).toBeGreaterThanOrEqual(levels[1]!);
    }
  });

  it('전체 초기화에서는 신규와 기존의 전력이 같다', () => {
    const comparison = compareModel(input({ seasons: 4 }), 'full_reset');
    expect(comparison.newcomerRatio).toBe(1);
  });

  it('완전 영구형은 혼합형보다 신규 격차가 크거나 같다', () => {
    const results = compareAllModels(input({ seasons: 4 }));
    const byModel = new Map(results.map((result) => [result.model, result]));
    const hybrid = byModel.get('hybrid')!;
    const persistent = byModel.get('fully_persistent')!;
    expect(persistent.newcomerRatio).toBeLessThanOrEqual(hybrid.newcomerRatio);
  });

  it('시즌 수 범위를 검증한다', () => {
    expect(() => runSeasonChain(input({ seasons: 0 }), 'hybrid')).toThrow(RangeError);
    expect(() => runSeasonChain(input({ seasons: 21 }), 'hybrid')).toThrow(RangeError);
  });
});

describe('곡선 심화 초안 (D-027 선행 과제)', () => {
  it('초안이 레지스트리에 등록되고 정식 v0.1.0은 변경되지 않는다', () => {
    expect(ECONOMY_RULESETS['0.1.0']!.buildings.farm!.maxLevel).toBe(10);
    expect(ECONOMY_RULESETS['0.1.0']!.buildings.farm!.costGrowth).toBeCloseTo(1.5, 5);
    for (const version of Object.keys(CURVE_DRAFTS)) {
      expect(ECONOMY_RULESETS[version]).toBeDefined();
      // 초안(draft)과 진단(diag) 변형만 허용한다 — 정식 버전은 0.1.0뿐이다.
      expect(version).toMatch(/^0\.2\.0-(draft|diag|gate1|benefit)-/);
    }
  });

  it('곡선을 깊게 만들면 저장 용량도 함께 올라 고레벨이 감당 가능해진다', () => {
    const base = ECONOMY_RULESETS['0.1.0']!;
    const deeper = deepenCurve(base, {
      maxLevel: 16,
      costGrowthMultiplier: 1.2,
      hourGrowthMultiplier: 1.2,
    });
    expect(deeper.buildings.farm!.maxLevel).toBe(16);
    expect(deeper.buildings.farm!.costGrowth).toBeGreaterThan(base.buildings.farm!.costGrowth);
    // 저장 상한이 최고 업그레이드 비용을 담을 수 있어야 한다.
    const maxStorage = deeper.balance.warehouseCapBase + deeper.balance.warehouseCapPerLevel * 16;
    const costEntries: readonly (number | undefined)[] = Object.values(deeper.buildings.farm!.baseCost);
    const baseTotal = costEntries.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const topCost = baseTotal * deeper.buildings.farm!.costGrowth ** 14;
    expect(maxStorage).toBeGreaterThan(topCost);
  });

  it('잘못된 곡선 파라미터를 거부한다', () => {
    const base = ECONOMY_RULESETS['0.1.0']!;
    expect(() => deepenCurve(base, { maxLevel: 1, costGrowthMultiplier: 1, hourGrowthMultiplier: 1 }))
      .toThrow(RangeError);
    expect(() => deepenCurve(base, { maxLevel: 61, costGrowthMultiplier: 1, hourGrowthMultiplier: 1 }))
      .toThrow(RangeError);
    expect(() => deepenCurve(base, { maxLevel: 10, costGrowthMultiplier: 0, hourGrowthMultiplier: 1 }))
      .toThrow(RangeError);
  });

  it('현행 곡선은 1시즌에 상한에 도달하고 심화 곡선은 더 오래 걸린다', () => {
    const shallow = seasonsToBuildingCap({
      ruleVersion: '0.1.0', archetype: ARCHETYPE, seasons: 8, days: 42,
    });
    expect(shallow.season).toBe(1);

    const deep = seasonsToBuildingCap({
      ruleVersion: '0.2.0-gate1-c132', archetype: ARCHETYPE, seasons: 8, days: 42,
    });
    expect(deep.season).not.toBeNull();
    expect(deep.season!).toBeGreaterThan(shallow.season!);
  });
});

describe('맵 자원 영토 수입 (D-028)', () => {
  const CYCLE = 30 * 24;
  const baseNodes = {
    holdLimit: 6,
    heldNodes: 6,
    yieldPerHour: 50,
    stockPerNode: 50 * CYCLE,
    resetIntervalHours: CYCLE,
    recaptureHours: 12,
    typeSeed: 7,
  } as const;

  it('nodes를 생략하면 기존 동작과 같고 수입이 0이다', () => {
    const base = simulateSeason({ ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 10 });
    expect(base.nodeIncomeShare).toBe(0);
    for (const value of Object.values(base.nodeIncome)) expect(value).toBe(0);
  });

  it('자원지 수입이 여러 자원에 분산되고 비중이 보고된다', () => {
    const report = simulateSeason({
      ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 10, nodes: baseNodes,
    });
    expect(report.nodeIncomeShare).toBeGreaterThan(0);
    const withIncome = Object.values(report.nodeIncome).filter((value) => value > 0);
    // 노드마다 종류가 달라 단일 자원에만 쏟아지지 않는다(D-028 결정 3).
    expect(withIncome.length).toBeGreaterThan(1);
    // 인력·군표는 채취 대상이 아니다.
    expect(report.nodeIncome.manpower).toBe(0);
    expect(report.nodeIncome.scrip).toBe(0);
  });

  it('매장량이 적으면 조기 고갈되어 수입이 줄어든다', () => {
    const rich = simulateSeason({
      ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 20, nodes: baseNodes,
    });
    const poor = simulateSeason({
      ruleVersion: RULE_VERSION,
      archetype: ARCHETYPE,
      days: 20,
      nodes: { ...baseNodes, stockPerNode: baseNodes.stockPerNode * 0.25 },
    });
    expect(poor.nodeIncomeShare).toBeLessThan(rich.nodeIncomeShare);
  });

  it('동시 보유 상한을 넘는 heldNodes와 잘못된 값을 거부한다 (결정 1)', () => {
    const bad: unknown[] = [
      { ...baseNodes, heldNodes: 7 },
      { ...baseNodes, holdLimit: 0 },
      { ...baseNodes, yieldPerHour: -1 },
      { ...baseNodes, recaptureHours: CYCLE },
      [],
    ];
    for (const nodes of bad) {
      try {
        simulateSeason({
          ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 5, nodes,
        } as SeasonInput);
        expect.unreachable(`INVALID_NODES로 거부되어야 한다: ${JSON.stringify(nodes)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EconomyError);
        expect((error as EconomyError).code).toBe('INVALID_NODES');
      }
    }
  });

  it('같은 입력은 같은 결과를 만든다 (결정론)', () => {
    const seasonInput: SeasonInput = {
      ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 12, nodes: baseNodes,
    };
    expect(simulateSeason(seasonInput)).toEqual(simulateSeason(seasonInput));
  });
});

describe('도시 인프라 따라잡기 보정 (D-029)', () => {
  const CAP = 70;
  const catchUp = {
    referenceLevels: CAP,
    perLevelRate: 0.04,
    maxReduction: 0.7,
    applyToCost: true,
    applyToHours: false,
  } as const;

  it('catchUp을 생략하면 기존 동작과 같고 절약이 0이다', () => {
    const base = simulateSeason({ ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 20 });
    expect(base.catchUpSavedCost).toBe(0);
    expect(base.catchUpSavedHours).toBe(0);
  });

  it('기준보다 뒤처지면 건설 비용이 줄고 인프라가 더 빨리 오른다', () => {
    const plain = simulateSeason({ ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 20 });
    const boosted = simulateSeason({
      ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 20, catchUp,
    });
    expect(boosted.catchUpSavedCost).toBeGreaterThan(0);
    const levels = (report: typeof plain): number =>
      Object.values(report.finalBuildings).reduce((sum, level) => sum + level, 0);
    expect(levels(boosted)).toBeGreaterThanOrEqual(levels(plain));
  });

  it('기준에 도달한 계정에는 보정이 적용되지 않는다 (대칭 규칙)', () => {
    // 이미 상한인 도시는 뒤처짐이 0이므로 절약이 없다.
    const maxed = simulateSeason({
      ruleVersion: RULE_VERSION,
      archetype: ARCHETYPE,
      days: 10,
      carryOver: {
        buildings: {
          hq: 10, farm: 10, steel_mill: 10, refinery: 10,
          supply_depot: 10, housing: 10, warehouse: 10,
        },
      },
      catchUp,
    });
    expect(maxed.catchUpSavedCost).toBe(0);
  });

  it('잘못된 보정 입력을 거부한다', () => {
    const bad: unknown[] = [
      { ...catchUp, perLevelRate: -0.1 },
      { ...catchUp, perLevelRate: 1.5 },
      { ...catchUp, maxReduction: 1 },
      { ...catchUp, referenceLevels: -1 },
      { ...catchUp, applyToCost: 'yes' },
      [],
    ];
    for (const value of bad) {
      try {
        simulateSeason({
          ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 5, catchUp: value,
        } as SeasonInput);
        expect.unreachable(`INVALID_CATCH_UP로 거부되어야 한다: ${JSON.stringify(value)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EconomyError);
        expect((error as EconomyError).code).toBe('INVALID_CATCH_UP');
      }
    }
  });

  it('같은 입력은 같은 결과를 만든다 (결정론)', () => {
    const seasonInput: SeasonInput = {
      ruleVersion: RULE_VERSION, archetype: ARCHETYPE, days: 15, catchUp,
    };
    expect(simulateSeason(seasonInput)).toEqual(simulateSeason(seasonInput));
  });
});

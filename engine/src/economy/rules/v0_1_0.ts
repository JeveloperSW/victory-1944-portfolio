import type { BuildingId, EconomyRuleset, EconomyUnitId } from '../types.js';

/**
 * 경제 규칙 v0.1.0 — 검증용 초안 밸런스.
 * 목적은 최종 수치 확정이 아니라 GAME_DESIGN.md의 생산·상한·소모처 구조와
 * D-017의 결정론적 시간 정산·감사 원장 계약을 검증하는 것이다.
 */

const BUILDINGS = {
  hq: {
    id: 'hq', nameKo: '사령부', maxLevel: 10,
    baseCost: { steel: 150, food: 100 }, costGrowth: 1.55,
    baseHours: 1, hourGrowth: 1.5,
  },
  farm: {
    id: 'farm', nameKo: '농장', maxLevel: 10,
    baseCost: { steel: 50, food: 20 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
    perHourPerLevel: { food: 20 },
  },
  steel_mill: {
    id: 'steel_mill', nameKo: '제철소', maxLevel: 10,
    baseCost: { steel: 60, food: 30 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
    perHourPerLevel: { steel: 12 },
  },
  refinery: {
    id: 'refinery', nameKo: '정유소', maxLevel: 10,
    baseCost: { steel: 80, food: 40 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
    perHourPerLevel: { oil: 4 },
  },
  supply_depot: {
    id: 'supply_depot', nameKo: '물류센터', maxLevel: 10,
    baseCost: { steel: 70, food: 40 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
    perHourPerLevel: { supplies: 3 },
  },
  housing: {
    id: 'housing', nameKo: '주거지', maxLevel: 10,
    baseCost: { steel: 60, food: 50 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
  },
  warehouse: {
    id: 'warehouse', nameKo: '창고', maxLevel: 10,
    baseCost: { steel: 100, food: 30 }, costGrowth: 1.5,
    baseHours: 1, hourGrowth: 1.4,
  },
} satisfies EconomyRuleset['buildings'];

/** 병종 id는 전투 규칙 v0.1.0과 동일하다. */
const UNITS = {
  rifle: { unitId: 'rifle', trainCost: { food: 20, steel: 10, manpower: 1 }, upkeepFoodPerHour: 0.2 },
  at_infantry: { unitId: 'at_infantry', trainCost: { food: 25, steel: 20, manpower: 1 }, upkeepFoodPerHour: 0.25 },
  scout: { unitId: 'scout', trainCost: { steel: 40, oil: 10, manpower: 1 }, upkeepFoodPerHour: 0.15 },
  medium_tank: { unitId: 'medium_tank', trainCost: { food: 30, steel: 90, oil: 20, manpower: 2 }, upkeepFoodPerHour: 0.5 },
  heavy_tank: { unitId: 'heavy_tank', trainCost: { food: 40, steel: 160, oil: 40, manpower: 3 }, upkeepFoodPerHour: 0.8 },
  howitzer: { unitId: 'howitzer', trainCost: { food: 20, steel: 100, manpower: 2 }, upkeepFoodPerHour: 0.3 },
  at_gun: { unitId: 'at_gun', trainCost: { steel: 80, manpower: 2 }, upkeepFoodPerHour: 0.25 },
  aa_gun: { unitId: 'aa_gun', trainCost: { steel: 70, manpower: 2 }, upkeepFoodPerHour: 0.25 },
  fighter: { unitId: 'fighter', trainCost: { steel: 120, oil: 60, manpower: 2 }, upkeepFoodPerHour: 0.6 },
  bomber: { unitId: 'bomber', trainCost: { steel: 180, oil: 90, manpower: 3 }, upkeepFoodPerHour: 0.9 },
  engineer: { unitId: 'engineer', trainCost: { food: 25, steel: 30, manpower: 1 }, upkeepFoodPerHour: 0.2 },
  supply_truck: { unitId: 'supply_truck', trainCost: { steel: 40, oil: 10, manpower: 1 }, upkeepFoodPerHour: 0.15 },
} satisfies Record<EconomyUnitId, EconomyRuleset['units'][EconomyUnitId]>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const ECONOMY_RULESET_V0_1_0: EconomyRuleset = deepFreeze({
  version: '0.1.0',
  combatRuleVersion: '0.1.0',
  buildings: BUILDINGS,
  units: UNITS,
  balance: {
    warehouseCapBase: 1200,
    warehouseCapPerLevel: 800,
    housingCapBase: 120,
    housingCapPerLevel: 80,
    housingRegenBase: 1,
    housingRegenPerLevel: 0.25,
    scripCapBase: 500,
    scripCapPerHqLevel: 250,
    scripPerManpowerHour: 0.02,
    researchBaseCost: 100,
    researchCostStep: 50,
    sortieBaseCost: { supplies: 30, oil: 10 },
    sortieCostPerArmyValue: { supplies: 0.005, oil: 0.002 },
    sortieReward: { scrip: 25, food: 40 },
    researchChargesPerDay: 1,
    sortieChargesPerDay: 2,
    trainReserve: { food: 200, steel: 100, oil: 50 },
    upkeepReserveHours: 24,
    buildSlots: 2,
    nonHqLevelOffset: 0,
    buildPriority: ['farm', 'steel_mill', 'refinery', 'supply_depot', 'housing', 'warehouse', 'hq'],
    seasonDays: 42,
    maxSessionsPerDay: 6,
    maxTrainRatioWeight: 100,
    maxTrainRatioTotal: 1000,
    startingResources: { food: 500, steel: 500, oil: 200, supplies: 100, manpower: 100, scrip: 50 },
    startingBuildings: {
      hq: 1, farm: 1, steel_mill: 1, refinery: 1, supply_depot: 1, housing: 1, warehouse: 1,
    },
  },
} satisfies EconomyRuleset);

import { RESOURCE_IDS, buildingDef, cityBuildingIds } from './types.js';
import type {
  BuildingId,
  EconomyRuleset,
  PartialBundle,
} from './types.js';

/** 서버와 순수 경제 시뮬레이터가 공유하는 목표 레벨별 건설 비용 계산. */
export function constructionCost(
  rules: EconomyRuleset,
  buildingId: BuildingId,
  targetLevel: number,
): PartialBundle {
  const definition = buildingDef(rules, buildingId);
  const exponent = targetLevel - 2;
  const result: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const base = definition.baseCost[resourceId];
    if (base !== undefined) result[resourceId] = Math.ceil(base * definition.costGrowth ** exponent);
  }
  return result;
}

/**
 * 1시간 생산량(D-045). **시뮬레이터와 서버가 같은 함수를 쓴다** —
 * 예전에는 이 식이 시뮬레이터 안에만 있어서 서버에는 생산이 아예 없었다.
 *
 * - 건물 생산: `perHourPerLevel × 레벨`의 합
 * - 인력: 주거지 레벨에 따른 회복량(누적이 아니라 시간당 생산이다)
 * - 군표: **현재 인력에 비례**하므로 시간마다 값이 달라진다. 여러 시간을 한 번에
 *   정산할 때는 시간 단위로 반복해야 시뮬레이터와 같은 결과가 나온다.
 */
export function hourlyProduction(
  rules: EconomyRuleset,
  levels: Readonly<Partial<Record<BuildingId, number>>>,
  manpower: number,
): PartialBundle {
  const produced: PartialBundle = {};
  for (const buildingId of cityBuildingIds(rules)) {
    const perHour = buildingDef(rules, buildingId).perHourPerLevel;
    if (!perHour) continue;
    const level = levels[buildingId] ?? 0;
    for (const resourceId of RESOURCE_IDS) {
      const amount = perHour[resourceId] ?? 0;
      if (amount > 0) produced[resourceId] = (produced[resourceId] ?? 0) + amount * level;
    }
  }
  produced.manpower = rules.balance.housingRegenBase
    + rules.balance.housingRegenPerLevel * (levels.housing ?? 0);
  produced.scrip = manpower * rules.balance.scripPerManpowerHour;
  return produced;
}

/** 서버와 순수 경제 시뮬레이터가 공유하는 목표 레벨별 건설 시간 계산. */
export function constructionHours(
  rules: EconomyRuleset,
  buildingId: BuildingId,
  targetLevel: number,
): number {
  const definition = buildingDef(rules, buildingId);
  return Math.max(
    1,
    Math.ceil(definition.baseHours * definition.hourGrowth ** (targetLevel - 2)),
  );
}

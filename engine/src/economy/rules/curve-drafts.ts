import type { BuildingDef, BuildingId, EconomyRuleset } from '../types.js';
import { buildingDef, cityBuildingIds } from '../types.js';
import { ECONOMY_RULESET_V0_1_0 } from './v0_1_0.js';

/**
 * 성장 곡선 심화 초안(D-027 선행 과제).
 *
 * 도시를 영구로 두면 곡선이 시즌 길이보다 짧을 때 시즌 2부터 모두가 상한에 머물러
 * 도시 성장 축이 사라진다. 여기서는 v0.1.0에서 파생한 후보 곡선을 만들어
 * "상한 도달까지 몇 시즌이 걸리는가"를 측정한다.
 *
 * 이 버전들은 **초안**이며 어떤 도시에도 결속되지 않는다. 채택 시 정식 버전으로
 * 다시 고정하고 초안은 제거한다. 배포된 v0.1.0은 변경하지 않는다.
 */

export interface CurveDraftOptions {
  /** 모든 건물의 최대 레벨 */
  readonly maxLevel: number;
  /** 레벨당 비용 증가율에 곱할 계수 */
  readonly costGrowthMultiplier: number;
  /** 레벨당 시간 증가율에 곱할 계수 */
  readonly hourGrowthMultiplier: number;
  /** 비사령부 건물이 사령부보다 앞설 수 있는 레벨 수(D-031). 생략 시 원본 유지 */
  readonly nonHqLevelOffset?: number;
  /** 동시 건설 슬롯. 생략 시 원본 유지 */
  readonly buildSlots?: number;
}

function upgradeCostAt(definition: BuildingDef, level: number): number {
  let total = 0;
  for (const value of Object.values(definition.baseCost)) {
    total += value ?? 0;
  }
  return total * definition.costGrowth ** (level - 2);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 곡선을 깊게 만든 파생 규칙을 만든다.
 *
 * 저장 상한을 함께 올리는 이유: 상한만 올리면 고레벨 업그레이드 비용이 창고 용량을
 * 넘어 **영원히 감당할 수 없게 되고**, 곡선이 아니라 저장 한계 때문에 미도달이 된다.
 * 최대 단일 업그레이드 비용의 1.5배를 저장할 수 있도록 창고 용량을 맞춘다.
 */
export function deepenCurve(base: EconomyRuleset, options: CurveDraftOptions): EconomyRuleset {
  const { maxLevel, costGrowthMultiplier, hourGrowthMultiplier } = options;
  if (!Number.isInteger(maxLevel) || maxLevel < 2 || maxLevel > 60) {
    throw new RangeError('maxLevel은 2..60 정수여야 합니다.');
  }
  if (!(costGrowthMultiplier > 0) || !(hourGrowthMultiplier > 0)) {
    throw new RangeError('증가율 계수는 양수여야 합니다.');
  }

  const buildings = {} as Record<BuildingId, BuildingDef>;
  let mostExpensive = 0;
  for (const buildingId of cityBuildingIds(base)) {
    const source = buildingDef(base, buildingId);
    const definition: BuildingDef = {
      ...source,
      maxLevel,
      costGrowth: source.costGrowth * costGrowthMultiplier,
      hourGrowth: source.hourGrowth * hourGrowthMultiplier,
    };
    buildings[buildingId] = definition;
    mostExpensive = Math.max(mostExpensive, upgradeCostAt(definition, maxLevel));
  }

  // 저장 상한은 최고 비용의 1.5배를 담을 수 있어야 한다.
  const requiredCap = Math.ceil(mostExpensive * 1.5);
  const baseBalance = base.balance;
  const currentCap = baseBalance.warehouseCapBase + baseBalance.warehouseCapPerLevel * maxLevel;
  const capacityMultiplier = Math.max(1, requiredCap / currentCap);

  return deepFreeze({
    ...base,
    version: `${base.version}-draft`,
    buildings,
    balance: {
      ...baseBalance,
      warehouseCapBase: Math.ceil(baseBalance.warehouseCapBase * capacityMultiplier),
      warehouseCapPerLevel: Math.ceil(baseBalance.warehouseCapPerLevel * capacityMultiplier),
      housingCapBase: Math.ceil(baseBalance.housingCapBase * capacityMultiplier),
      housingCapPerLevel: Math.ceil(baseBalance.housingCapPerLevel * capacityMultiplier),
      scripCapBase: Math.ceil(baseBalance.scripCapBase * capacityMultiplier),
      scripCapPerHqLevel: Math.ceil(baseBalance.scripCapPerHqLevel * capacityMultiplier),
      ...(options.nonHqLevelOffset === undefined
        ? {}
        : { nonHqLevelOffset: options.nonHqLevelOffset }),
      ...(options.buildSlots === undefined ? {} : { buildSlots: options.buildSlots }),
    },
  }) as EconomyRuleset;
}

/**
 * 수익화 혜택 후보를 적용한 변형(D-033 측정용).
 * 어떤 혜택이 실제로 성장에 영향을 주는지 재기 위한 진단 도구이며,
 * 여기서 값을 매긴다고 해서 그 상품을 판매하기로 결정한 것은 아니다.
 */
export interface BenefitVariantOptions {
  /** 건물 시간당 생산량 배수 */
  readonly productionMultiplier?: number;
  /** 저장 상한 배수 */
  readonly storageMultiplier?: number;
  /** 건설 기본 비용 배수 */
  readonly costMultiplier?: number;
  /** 건설 기본 시간 배수 */
  readonly hoursMultiplier?: number;
  /** 동시 건설 슬롯 */
  readonly buildSlots?: number;
}

export function applyBenefit(base: EconomyRuleset, options: BenefitVariantOptions): EconomyRuleset {
  const buildings = {} as Record<BuildingId, BuildingDef>;
  for (const buildingId of cityBuildingIds(base)) {
    const source = buildingDef(base, buildingId);
    const baseCost: Record<string, number> = {};
    for (const [resourceId, amount] of Object.entries(source.baseCost)) {
      if (amount === undefined) continue;
      baseCost[resourceId] = Math.max(1, Math.ceil(amount * (options.costMultiplier ?? 1)));
    }
    const perHour = source.perHourPerLevel;
    const scaledPerHour: Record<string, number> | undefined = perHour === undefined
      ? undefined
      : Object.fromEntries(Object.entries(perHour)
        .filter(([, value]) => value !== undefined)
        .map(([resourceId, value]) => [resourceId, (value ?? 0) * (options.productionMultiplier ?? 1)]));
    buildings[buildingId] = {
      ...source,
      baseCost,
      baseHours: Math.max(1, Math.ceil(source.baseHours * (options.hoursMultiplier ?? 1))),
      ...(scaledPerHour === undefined ? {} : { perHourPerLevel: scaledPerHour }),
    };
  }
  const storage = options.storageMultiplier ?? 1;
  return deepFreeze({
    ...base,
    buildings,
    balance: {
      ...base.balance,
      warehouseCapBase: Math.ceil(base.balance.warehouseCapBase * storage),
      warehouseCapPerLevel: Math.ceil(base.balance.warehouseCapPerLevel * storage),
      ...(options.buildSlots === undefined ? {} : { buildSlots: options.buildSlots }),
    },
  }) as EconomyRuleset;
}

/** 채택 후보 곡선(D-032). 혜택 변형의 기준이 된다. */
const ADOPTED_BASE = deepenCurve(ECONOMY_RULESET_V0_1_0, {
  maxLevel: 10,
  costGrowthMultiplier: 1.32,
  hourGrowthMultiplier: 1.37,
  nonHqLevelOffset: 1,
});

/**
 * 곡선 후보와 진단 변형.
 *
 * `0.2.0-gate1-c132`가 현재 채택 후보다(D-032). 사령부 게이트를 1레벨 완화하고
 * 비용을 v0.1.0 대비 x1.32로 깊게 잡아, 30일 주기에서 세 접속 아키타입 모두
 * **6주기(180일)** 에 도시 상한에 도달한다.
 *
 * 모두 초안·진단용이며 어떤 도시에도 결속되지 않는다.
 * 채택 시 정식 버전으로 고정하고 이 목록은 제거한다.
 */
export const CURVE_DRAFTS: Readonly<Record<string, EconomyRuleset>> = Object.freeze({
  // 게이트 0 기준선(D-030). 6주기이지만 슬롯 가동률이 29%로 낮고 접속 빈도가 무의미하다.
  '0.2.0-draft-c128': deepenCurve(ECONOMY_RULESET_V0_1_0, {
    maxLevel: 10,
    costGrowthMultiplier: 1.28,
    hourGrowthMultiplier: 1.33,
  }),
  // 채택 후보(D-032): 게이트 +1 · 6주기 · 가동률 39%.
  '0.2.0-gate1-c132': deepenCurve(ECONOMY_RULESET_V0_1_0, {
    maxLevel: 10,
    costGrowthMultiplier: 1.32,
    hourGrowthMultiplier: 1.37,
    nonHqLevelOffset: 1,
  }),
  // 진단용(D-031·D-032): 채택 후보에 세 번째 건설 슬롯만 추가. 상한 도달일이 바뀌지 않음을 보인다.
  '0.2.0-gate1-c132-slots3': deepenCurve(ECONOMY_RULESET_V0_1_0, {
    maxLevel: 10,
    costGrowthMultiplier: 1.32,
    hourGrowthMultiplier: 1.37,
    nonHqLevelOffset: 1,
    buildSlots: 3,
  }),
  // 수익화 혜택 후보 비교(D-033). 모두 채택 후보 위에 하나씩만 얹는다.
  '0.2.0-benefit-production': applyBenefit(ADOPTED_BASE, { productionMultiplier: 1.2 }),
  '0.2.0-benefit-storage': applyBenefit(ADOPTED_BASE, { storageMultiplier: 1.5 }),
  '0.2.0-benefit-cost': applyBenefit(ADOPTED_BASE, { costMultiplier: 0.8 }),
  '0.2.0-benefit-hours': applyBenefit(ADOPTED_BASE, { hoursMultiplier: 0.8 }),
});

/**
 * 시나리오 사다리 계측(D-046).
 *
 * **규칙이 아니라 측정 도구다.** 전투 결과에 영향을 주지 않으며, 밸런스 목표가 지켜지는지
 * 숫자로 확인하는 데만 쓴다. CLI 보고서와 회귀 테스트가 이 모듈을 함께 쓴다 —
 * 보고서와 테스트가 서로 다른 계산을 하면 둘 중 하나는 거짓말이 된다.
 */

import { CAMPAIGN_RULESETS } from './rules/index.js';
import { ECONOMY_RULESETS } from '../economy/rules/index.js';
import { hourlyProduction } from '../economy/construction.js';
import { RESOURCE_IDS } from '../economy/types.js';
import { RULESETS } from '../rules/index.js';
import { simulateBattle } from '../simulate.js';
import type { ArmySnapshot, BattleInput, Row, StackOrder } from '../types.js';
import type {
  BuildingId,
  EconomyRuleset,
  EconomyUnitId,
  PartialBundle,
  ResourceId,
} from '../economy/types.js';
import type { NpcScenario } from './types.js';

/** 시드 40개. 결과가 시드 하나의 운에 좌우되지 않을 만큼이고 테스트가 느려지지 않을 만큼이다. */
export const LADDER_SEEDS: readonly number[] = Array.from(
  { length: 40 },
  (_, index) => 1_000 + index * 7919,
);

/**
 * 단계별로 플레이어가 가졌을 법한 건물 레벨. 해금과 생산량이 여기서 나온다.
 * 1단계는 **실제 시작 도시와 같아야 한다**(경제 규칙의 `startingBuildings`).
 */
export const LADDER_PROGRESSION: readonly {
  readonly tier: number;
  readonly buildings: Partial<Record<BuildingId, number>>;
}[] = [
  { tier: 1, buildings: { hq: 3, farm: 2, steel_mill: 2, refinery: 1, supply_depot: 1, housing: 1, warehouse: 1, barracks: 1, arsenal: 1, airfield: 1, radar: 1, research_lab: 1 } },
  { tier: 2, buildings: { hq: 3, farm: 3, steel_mill: 3, refinery: 2, supply_depot: 2, housing: 2, warehouse: 2, barracks: 2, arsenal: 2, airfield: 1, radar: 1, research_lab: 1 } },
  { tier: 3, buildings: { hq: 4, farm: 4, steel_mill: 4, refinery: 2, supply_depot: 2, housing: 3, warehouse: 3, barracks: 3, arsenal: 3, airfield: 2, radar: 2, research_lab: 1 } },
  { tier: 4, buildings: { hq: 5, farm: 5, steel_mill: 5, refinery: 3, supply_depot: 3, housing: 4, warehouse: 4, barracks: 4, arsenal: 4, airfield: 3, radar: 2, research_lab: 2 } },
  { tier: 5, buildings: { hq: 6, farm: 6, steel_mill: 6, refinery: 4, supply_depot: 4, housing: 5, warehouse: 5, barracks: 5, arsenal: 5, airfield: 4, radar: 3, research_lab: 2 } },
  { tier: 6, buildings: { hq: 7, farm: 7, steel_mill: 7, refinery: 5, supply_depot: 5, housing: 6, warehouse: 6, barracks: 6, arsenal: 6, airfield: 5, radar: 3, research_lab: 3 } },
];

interface ForceShape {
  readonly unitId: EconomyUnitId;
  readonly weight: number;
  readonly row: Row;
}

/**
 * 단계별 "상식적인" 편성. **정답이 아니라 측정 기준선이다.**
 * 그 단계가 내는 문제(포병·기갑·항공)에 대응하는 병종을 넣되, 최적화하지 않는다.
 */
const SHAPES: Readonly<Record<number, readonly ForceShape[]>> = {
  1: [
    { unitId: 'rifle', weight: 4, row: 'front' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 1, row: 'back' },
  ],
  2: [
    { unitId: 'rifle', weight: 4, row: 'front' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 1, row: 'back' },
  ],
  3: [
    { unitId: 'rifle', weight: 4, row: 'front' },
    { unitId: 'at_infantry', weight: 1, row: 'front' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 2, row: 'back' },
  ],
  4: [
    { unitId: 'rifle', weight: 3, row: 'front' },
    { unitId: 'at_infantry', weight: 2, row: 'front' },
    { unitId: 'at_gun', weight: 2, row: 'mid' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 1, row: 'back' },
  ],
  5: [
    { unitId: 'rifle', weight: 3, row: 'front' },
    { unitId: 'aa_gun', weight: 2, row: 'mid' },
    { unitId: 'fighter', weight: 2, row: 'back' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 1, row: 'back' },
  ],
  6: [
    { unitId: 'rifle', weight: 3, row: 'front' },
    { unitId: 'at_infantry', weight: 1, row: 'front' },
    { unitId: 'medium_tank', weight: 1, row: 'front' },
    { unitId: 'at_gun', weight: 1, row: 'mid' },
    { unitId: 'aa_gun', weight: 1, row: 'mid' },
    { unitId: 'fighter', weight: 1, row: 'back' },
    { unitId: 'scout', weight: 1, row: 'mid' },
    { unitId: 'howitzer', weight: 2, row: 'back' },
  ],
};

/** 규모 배수. 통과 규모를 이 눈금에서 찾는다. */
export const LADDER_SCALES: readonly number[] = [0.5, 1, 1.5, 2, 3, 4, 6];

/**
 * 자원 번들을 전투가치와 견줄 수 있게 한 숫자로 접는다.
 * 가중치는 병종 훈련비의 자원 구성비에서 왔고 **계측 전용**이다 — 게임 규칙이 아니다.
 */
const RESOURCE_WEIGHT: Readonly<Record<ResourceId, number>> = {
  food: 0.5, steel: 1, oil: 1.5, supplies: 1.5, manpower: 2, scrip: 3,
};

export function bundleValue(bundle: PartialBundle): number {
  return Object.entries(bundle).reduce(
    (sum, [id, amount]) => sum + (amount ?? 0) * RESOURCE_WEIGHT[id as ResourceId],
    0,
  );
}

function unlocked(
  rules: EconomyRuleset,
  levels: Partial<Record<BuildingId, number>>,
  unitId: EconomyUnitId,
): boolean {
  const requirement = rules.unitUnlocks?.[unitId];
  if (requirement === undefined) return true;
  return (levels[requirement.buildingId] ?? 0) >= requirement.level;
}

function buildForce(shape: readonly ForceShape[], scale: number): StackOrder[] {
  return shape.map((entry) => ({
    unitId: entry.unitId,
    count: Math.max(1, Math.round(entry.weight * scale)),
    row: entry.row,
  }));
}

function trainCost(rules: EconomyRuleset, stacks: readonly StackOrder[]): PartialBundle {
  const total: PartialBundle = {};
  for (const stack of stacks) {
    const cost = rules.units[stack.unitId as EconomyUnitId].trainCost;
    for (const resourceId of RESOURCE_IDS) {
      const amount = cost[resourceId];
      if (amount === undefined) continue;
      total[resourceId] = (total[resourceId] ?? 0) + amount * stack.count;
    }
  }
  return total;
}

/** 훈련비를 시간당 생산으로 나눈 최댓값. 가장 오래 걸리는 자원이 병목이다. */
function hoursToAfford(perHour: PartialBundle, cost: PartialBundle): number {
  let worst = 0;
  for (const resourceId of RESOURCE_IDS) {
    const amount = cost[resourceId] ?? 0;
    if (amount <= 0) continue;
    const rate = perHour[resourceId] ?? 0;
    if (rate <= 0) return Number.POSITIVE_INFINITY;
    worst = Math.max(worst, amount / rate);
  }
  return worst;
}

export interface ScaleMeasurement {
  readonly scale: number;
  readonly units: number;
  readonly winRate: number;
  readonly avgLossRate: number;
  readonly avgRounds: number;
  readonly cost: PartialBundle;
  readonly hours: number;
  /** 전사 병력의 전투가치 평균. **영구 손실**이며 전투의 진짜 값이다. */
  readonly deadValue: number;
  /** 부상 병력의 전투가치 평균. 보급품과 시간으로 되돌아온다. */
  readonly woundedValue: number;
  readonly sortie: PartialBundle;
  readonly recoverySupplies: number;
}

export interface TierMeasurement {
  readonly tier: number;
  readonly scenarioId: string;
  readonly nameKo: string;
  readonly defenderUnits: number;
  readonly defenderValue: number;
  readonly perHour: PartialBundle;
  readonly shape: readonly ForceShape[];
  readonly scales: readonly ScaleMeasurement[];
  /** 승률 80% 이상에 처음 닿는 규모. 없으면 null. */
  readonly pass: ScaleMeasurement | null;
  /** 승리 1회의 순이득(보상 − 출정 − 전사 − 회복). 통과 규모 기준. */
  readonly net: number;
  /** 순이득을 투입 병력으로 나눈 값. 단계마다 커져야 사다리가 의미를 갖는다. */
  readonly efficiency: number;
}

/** 통과로 인정하는 승률. */
export const PASS_WIN_RATE = 0.8;

function measureScale(
  scenario: NpcScenario,
  shape: readonly ForceShape[],
  scale: number,
  campaignVersion: string,
  economy: EconomyRuleset,
  perHour: PartialBundle,
): ScaleMeasurement {
  const campaign = CAMPAIGN_RULESETS[campaignVersion as keyof typeof CAMPAIGN_RULESETS];
  const combat = RULESETS[campaign.combatRuleVersion as keyof typeof RULESETS];
  if (!combat) throw new Error('전투 규칙을 찾을 수 없다.');
  const stacks = buildForce(shape, scale);
  let wins = 0;
  let lossRateSum = 0;
  let roundSum = 0;
  let deadValueSum = 0;
  let woundedValueSum = 0;
  for (const seed of LADDER_SEEDS) {
    const attacker: ArmySnapshot = {
      stacks,
      doctrine: 'none',
      supply: campaign.attackerDefaults.supply,
      reconAccuracy: campaign.attackerDefaults.reconAccuracy,
      retreatThreshold: campaign.attackerDefaults.retreatThreshold,
    };
    const input: BattleInput = {
      ruleVersion: campaign.combatRuleVersion,
      seed,
      attacker,
      defender: scenario.defender,
    };
    const result = simulateBattle(input);
    if (result.outcome === 'attacker_win') wins += 1;
    const initial = result.attacker.stacks.reduce((sum, stack) => sum + stack.initial, 0);
    const lost = result.attacker.stacks.reduce((sum, stack) => sum + stack.dead + stack.wounded, 0);
    lossRateSum += initial === 0 ? 0 : lost / initial;
    roundSum += result.rounds;
    for (const stack of result.attacker.stacks) {
      const unitValue = combat.units[stack.unitId]?.cost ?? 0;
      deadValueSum += stack.dead * unitValue;
      woundedValueSum += stack.wounded * unitValue;
    }
  }
  const deployedValue = stacks.reduce(
    (sum, stack) => sum + stack.count * (combat.units[stack.unitId]?.cost ?? 0),
    0,
  );
  const sortie: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const base = economy.balance.sortieBaseCost[resourceId] ?? 0;
    const ratio = economy.balance.sortieCostPerArmyValue[resourceId] ?? 0;
    const amount = Math.ceil(base + deployedValue * ratio);
    if (amount > 0) sortie[resourceId] = amount;
  }
  const woundedValue = woundedValueSum / LADDER_SEEDS.length;
  const cost = trainCost(economy, stacks);
  return {
    scale,
    units: stacks.reduce((sum, stack) => sum + stack.count, 0),
    winRate: wins / LADDER_SEEDS.length,
    avgLossRate: lossRateSum / LADDER_SEEDS.length,
    avgRounds: roundSum / LADDER_SEEDS.length,
    cost,
    hours: hoursToAfford(perHour, cost),
    deadValue: deadValueSum / LADDER_SEEDS.length,
    woundedValue,
    sortie,
    recoverySupplies: Math.ceil(woundedValue * campaign.recoverySupplyCostRatio),
  };
}

/** 사다리 전체를 잰다. 결과는 단계 순이다. */
export function measureLadder(campaignVersion: string): TierMeasurement[] {
  const campaign = CAMPAIGN_RULESETS[campaignVersion as keyof typeof CAMPAIGN_RULESETS];
  if (!campaign) throw new Error(`알 수 없는 캠페인 규칙: ${campaignVersion}`);
  const economy = ECONOMY_RULESETS[campaign.economyRuleVersion];
  if (!economy) throw new Error('경제 규칙을 찾을 수 없다.');
  const combat = RULESETS[campaign.combatRuleVersion as keyof typeof RULESETS];
  if (!combat) throw new Error('전투 규칙을 찾을 수 없다.');

  return Object.values(campaign.scenarios)
    .slice()
    .sort((left, right) => (left.tier ?? 99) - (right.tier ?? 99))
    .map((scenario): TierMeasurement => {
      const tier = scenario.tier ?? 1;
      const progression = LADDER_PROGRESSION.find((entry) => entry.tier === tier)
        ?? LADDER_PROGRESSION[0]!;
      const perHour = hourlyProduction(economy, progression.buildings, 100);
      const shape = (SHAPES[tier] ?? SHAPES[1]!)
        .filter((entry) => unlocked(economy, progression.buildings, entry.unitId));
      const scales = LADDER_SCALES.map(
        (scale) => measureScale(scenario, shape, scale, campaignVersion, economy, perHour),
      );
      const pass = scales.find((entry) => entry.winRate >= PASS_WIN_RATE) ?? null;
      const net = pass === null
        ? Number.NEGATIVE_INFINITY
        : bundleValue(scenario.victoryReward)
          - bundleValue(pass.sortie)
          - pass.deadValue
          - pass.recoverySupplies * RESOURCE_WEIGHT.supplies;
      return {
        tier,
        scenarioId: scenario.id,
        nameKo: scenario.nameKo,
        defenderUnits: scenario.defender.stacks.reduce((sum, stack) => sum + stack.count, 0),
        defenderValue: scenario.defender.stacks.reduce(
          (sum, stack) => sum + stack.count * (combat.units[stack.unitId]?.cost ?? 0),
          0,
        ),
        perHour,
        shape,
        scales,
        pass,
        net,
        efficiency: pass === null ? Number.NEGATIVE_INFINITY : net / pass.units,
      };
    });
}

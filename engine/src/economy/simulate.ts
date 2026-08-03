import { RULESETS } from '../rules/index.js';
import { constructionCost, constructionHours, hourlyProduction } from './construction.js';
import { settleMicroDelta } from './ledger.js';
import {
  ECONOMY_UNIT_IDS,
  NODE_RESOURCE_IDS,
  RESOURCE_IDS,
  buildingDef,
  cityBuildingIds,
} from './types.js';
import { validateSeasonInput } from './validate.js';
import type {
  BuildingId,
  ConstructionEvent,
  DailyLedger,
  EconomyLedgerEntry,
  EconomyLedgerReason,
  EconomyRuleset,
  EconomyUnitId,
  PartialBundle,
  PendingConstruction,
  ResourceBundle,
  ResourceId,
  ResourceTotals,
  CatchUpInput,
  NodeResourceId,
  ResourceNodeInput,
  SeasonCarryOver,
  SeasonInput,
  SeasonReport,
} from './types.js';

const SCALE = 1000;

type MicroBundle = Record<ResourceId, number>;

interface PendingInternal {
  buildingId: BuildingId;
  targetLevel: number;
  completeAtHour: number;
}

interface DailyAccumulator {
  start: MicroBundle;
  produced: MicroBundle;
  consumed: MicroBundle;
  overflow: MicroBundle;
  entries: EconomyLedgerEntry[];
}

interface SimulationState {
  resources: MicroBundle;
  buildings: Record<BuildingId, number>;
  army: Record<EconomyUnitId, number>;
  pending: PendingInternal[];
  constructions: ConstructionEvent[];
  ledgerSequence: number;
  trainingSequence: number;
  trainPointer: number;
  starvationHours: number;
  unmetUpkeepFoodMicro: number;
  researchCount: number;
  sortieCount: number;
  constructionStarted: number;
  constructionCompleted: number;
  trainedUnits: number;
  /** 자원지 잔여 매장량(보유 노드 합계) */
  nodeStock: number;
  /** 자원지에서 유입된 누적량 */
  nodeIncome: MicroBundle;
  /** 따라잡기 보정으로 절약한 비용·시간 */
  catchUpSavedCost: number;
  catchUpSavedHours: number;
}

function emptyMicroBundle(): MicroBundle {
  return { food: 0, steel: 0, oil: 0, supplies: 0, manpower: 0, scrip: 0 };
}

function copyMicroBundle(bundle: MicroBundle): MicroBundle {
  return { ...bundle };
}

function toMicro(value: number): number {
  const scaled = Math.round(value * SCALE);
  if (!Number.isSafeInteger(scaled)) throw new RangeError(`고정소수점 범위를 벗어났습니다: ${value}`);
  return scaled;
}

function fromMicro(value: number): number {
  return value / SCALE;
}

function publicBundle(bundle: MicroBundle): ResourceBundle {
  return {
    food: fromMicro(bundle.food),
    steel: fromMicro(bundle.steel),
    oil: fromMicro(bundle.oil),
    supplies: fromMicro(bundle.supplies),
    manpower: fromMicro(bundle.manpower),
    scrip: fromMicro(bundle.scrip),
  };
}

function initialResources(rules: EconomyRuleset, carryOver?: SeasonCarryOver): MicroBundle {
  const carried = carryOver?.resources;
  const pick = (resourceId: ResourceId): number =>
    toMicro(carried?.[resourceId] ?? rules.balance.startingResources[resourceId]);
  return {
    food: pick('food'),
    steel: pick('steel'),
    oil: pick('oil'),
    supplies: pick('supplies'),
    manpower: pick('manpower'),
    scrip: pick('scrip'),
  };
}

function initialBuildings(
  rules: EconomyRuleset,
  carryOver?: SeasonCarryOver,
): Record<BuildingId, number> {
  const carried = carryOver?.buildings;
  // 규칙이 정의한 건물만 만든다. 시작 레벨이 없으면 1로 둔다.
  const levels = {} as Record<BuildingId, number>;
  for (const buildingId of cityBuildingIds(rules)) {
    levels[buildingId] = carried?.[buildingId]
      ?? rules.balance.startingBuildings[buildingId]
      ?? 1;
  }
  return levels;
}

function initialArmy(carryOver?: SeasonCarryOver): Record<EconomyUnitId, number> {
  const carried = carryOver?.army;
  if (carried !== undefined) {
    const army = {} as Record<EconomyUnitId, number>;
    for (const unitId of ECONOMY_UNIT_IDS) army[unitId] = carried[unitId] ?? 0;
    return army;
  }
  return {
    rifle: 0,
    at_infantry: 0,
    scout: 0,
    medium_tank: 0,
    heavy_tank: 0,
    howitzer: 0,
    at_gun: 0,
    aa_gun: 0,
    fighter: 0,
    bomber: 0,
    engineer: 0,
    supply_truck: 0,
  };
}

function capMicro(rules: EconomyRuleset, state: SimulationState, resourceId: ResourceId): number {
  if (resourceId === 'manpower') {
    return toMicro(
      rules.balance.housingCapBase
      + rules.balance.housingCapPerLevel * state.buildings.housing,
    );
  }
  if (resourceId === 'scrip') {
    return toMicro(
      rules.balance.scripCapBase
      + rules.balance.scripCapPerHqLevel * state.buildings.hq,
    );
  }
  return toMicro(
    rules.balance.warehouseCapBase
    + rules.balance.warehouseCapPerLevel * state.buildings.warehouse,
  );
}

function bundleMicro(bundle: Readonly<PartialBundle>): Partial<Record<ResourceId, number>> {
  const result: Partial<Record<ResourceId, number>> = {};
  for (const resourceId of RESOURCE_IDS) {
    const value = bundle[resourceId] ?? 0;
    if (value !== 0) result[resourceId] = toMicro(value);
  }
  return result;
}

function canAfford(
  state: SimulationState,
  cost: Readonly<PartialBundle>,
  reserve: Readonly<PartialBundle> = {},
): boolean {
  for (const resourceId of RESOURCE_IDS) {
    const required = toMicro(cost[resourceId] ?? 0);
    const retained = toMicro(reserve[resourceId] ?? 0);
    if (state.resources[resourceId] - required < retained) return false;
  }
  return true;
}

function sessionHours(sessionsPerDay: number): Map<number, number> {
  const result = new Map<number, number>();
  for (let index = 0; index < sessionsPerDay; index += 1) {
    result.set(Math.floor(index * 24 / sessionsPerDay), index + 1);
  }
  return result;
}

function buildTrainCycle(input: SeasonInput): EconomyUnitId[] {
  const cycle: EconomyUnitId[] = [];
  const entries = Object.entries(input.archetype.trainRatio)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [unitId, weight] of entries) {
    for (let index = 0; index < (weight ?? 0); index += 1) {
      cycle.push(unitId as EconomyUnitId);
    }
  }
  return cycle;
}

function armyValue(
  state: SimulationState,
  rules: EconomyRuleset,
): number {
  const combatRules = RULESETS[rules.combatRuleVersion];
  if (!combatRules) throw new Error(`전투 규칙 누락: ${rules.combatRuleVersion}`);
  let value = 0;
  for (const unitId of ECONOMY_UNIT_IDS) {
    const unit = combatRules.units[unitId];
    if (!unit) throw new Error(`전투 병종 누락: ${unitId}`);
    value += state.army[unitId] * unit.cost;
  }
  return value;
}

/**
 * 자원지 종류(D-028 결정 3). 노드마다 종류가 다르고, 리셋 회차마다 전부 다시 배정된다.
 * 결정론을 위해 시드·회차·노드 번호만으로 계산한다 — 같은 입력은 같은 종류 배치를 만든다.
 */
function typeFor(nodes: ResourceNodeInput, resetIndex: number, nodeIndex: number): NodeResourceId {
  const mixed = Math.abs(Math.imul(nodes.typeSeed + resetIndex * 977 + nodeIndex * 31, 2654435761));
  return NODE_RESOURCE_IDS[mixed % NODE_RESOURCE_IDS.length]!;
}

/** 이번 회차에 보유한 노드들의 종류별 개수. */
function nodeTypeCounts(
  nodes: ResourceNodeInput,
  resetIndex: number,
  held: number,
): Map<NodeResourceId, number> {
  const counts = new Map<NodeResourceId, number>();
  for (let index = 0; index < held; index += 1) {
    const resourceId = typeFor(nodes, resetIndex, index);
    counts.set(resourceId, (counts.get(resourceId) ?? 0) + 1);
  }
  return counts;
}

function sortieCost(rules: EconomyRuleset, currentArmyValue: number): PartialBundle {
  const cost: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const base = rules.balance.sortieBaseCost[resourceId] ?? 0;
    const ratio = rules.balance.sortieCostPerArmyValue[resourceId] ?? 0;
    const amount = Math.ceil(base + currentArmyValue * ratio);
    if (amount > 0) cost[resourceId] = amount;
  }
  return cost;
}

/** 외부 시간·DB·네트워크 없이 경제 규칙을 정수 시간축으로 재생한다. */
export function simulateSeason(input: SeasonInput): SeasonReport {
  const rules = validateSeasonInput(input);
  const sortieMode = input.sortieMode ?? 'abstract';
  const combatRules = RULESETS[rules.combatRuleVersion];
  if (!combatRules) throw new Error(`전투 규칙 누락: ${rules.combatRuleVersion}`);

  const state: SimulationState = {
    resources: initialResources(rules, input.carryOver),
    buildings: initialBuildings(rules, input.carryOver),
    army: initialArmy(input.carryOver),
    pending: [],
    constructions: [],
    ledgerSequence: 0,
    trainingSequence: 0,
    trainPointer: 0,
    starvationHours: 0,
    unmetUpkeepFoodMicro: 0,
    researchCount: 0,
    sortieCount: 0,
    constructionStarted: 0,
    constructionCompleted: 0,
    trainedUnits: 0,
    nodeStock: input.nodes === undefined
      ? 0
      : Math.min(input.nodes.heldNodes, input.nodes.holdLimit) * input.nodes.stockPerNode,
    nodeIncome: emptyMicroBundle(),
    catchUpSavedCost: 0,
    catchUpSavedHours: 0,
  };
  const trainCycle = buildTrainCycle(input);
  const visits = sessionHours(input.archetype.sessionsPerDay);
  const dailyReports: DailyLedger[] = [];
  const totalProduced = emptyMicroBundle();
  const totalConsumed = emptyMicroBundle();
  const totalOverflow = emptyMicroBundle();
  let accumulator: DailyAccumulator;

  const recordMutation = (
    absoluteHour: number,
    resourceId: ResourceId,
    requestedDelta: number,
    reason: EconomyLedgerReason,
    causeId: string,
  ): { applied: number; overflow: number; shortfall: number } => {
    if (requestedDelta === 0) return { applied: 0, overflow: 0, shortfall: 0 };
    const before = state.resources[resourceId];
    const settlement = settleMicroDelta(
      before,
      capMicro(rules, state, resourceId),
      requestedDelta,
    );
    const applied = settlement.appliedDelta;
    const overflow = settlement.overflow;
    const shortfall = settlement.shortfall;
    if (requestedDelta > 0) {
      accumulator.produced[resourceId] += requestedDelta;
      accumulator.overflow[resourceId] += overflow;
      totalProduced[resourceId] += requestedDelta;
      totalOverflow[resourceId] += overflow;
    } else {
      const paid = -applied;
      accumulator.consumed[resourceId] += paid;
      totalConsumed[resourceId] += paid;
    }
    const after = settlement.balanceAfter;
    if (after < 0 || after > capMicro(rules, state, resourceId)) {
      throw new Error(`자원 불변식 위반: ${resourceId} ${before} -> ${after}`);
    }
    state.resources[resourceId] = after;
    state.ledgerSequence += 1;
    accumulator.entries.push({
      id: `ledger-${String(state.ledgerSequence).padStart(7, '0')}`,
      hour: absoluteHour,
      day: Math.floor(absoluteHour / 24) + 1,
      resourceId,
      reason,
      causeId,
      requestedDelta: fromMicro(requestedDelta),
      appliedDelta: fromMicro(applied),
      overflow: fromMicro(overflow),
      shortfall: fromMicro(shortfall),
      balanceBefore: fromMicro(before),
      balanceAfter: fromMicro(after),
    });
    return { applied, overflow, shortfall };
  };

  const consume = (
    absoluteHour: number,
    cost: Readonly<PartialBundle>,
    reason: EconomyLedgerReason,
    causeId: string,
  ): void => {
    for (const resourceId of RESOURCE_IDS) {
      const amount = toMicro(cost[resourceId] ?? 0);
      if (amount > 0) recordMutation(absoluteHour, resourceId, -amount, reason, causeId);
    }
  };

  const credit = (
    absoluteHour: number,
    reward: Readonly<PartialBundle>,
    reason: EconomyLedgerReason,
    causeId: string,
  ): void => {
    const micro = bundleMicro(reward);
    for (const resourceId of RESOURCE_IDS) {
      const amount = micro[resourceId] ?? 0;
      if (amount > 0) recordMutation(absoluteHour, resourceId, amount, reason, causeId);
    }
  };

  const completeConstructions = (absoluteHour: number): void => {
    const completed = state.pending
      .filter((item) => item.completeAtHour <= absoluteHour)
      .sort((left, right) => left.completeAtHour - right.completeAtHour
        || rules.balance.buildPriority.indexOf(left.buildingId)
          - rules.balance.buildPriority.indexOf(right.buildingId));
    if (completed.length === 0) return;
    for (const item of completed) {
      state.buildings[item.buildingId] = item.targetLevel;
      state.constructionCompleted += 1;
    }
    const completedSet = new Set(completed);
    state.pending = state.pending.filter((item) => !completedSet.has(item));
  };

  const startConstruction = (absoluteHour: number, sessionId: string): void => {
    while (state.pending.length < rules.balance.buildSlots) {
      const pendingIds = new Set(state.pending.map((item) => item.buildingId));
      const candidates = cityBuildingIds(rules)
        .filter((buildingId) => !pendingIds.has(buildingId))
        .map((buildingId) => ({
          buildingId,
          currentLevel: state.buildings[buildingId],
          targetLevel: state.buildings[buildingId] + 1,
        }))
        .filter(({ buildingId, targetLevel }) => targetLevel <= buildingDef(rules, buildingId).maxLevel)
        .filter(({ buildingId, targetLevel }) => buildingId === 'hq'
          || targetLevel <= state.buildings.hq + rules.balance.nonHqLevelOffset)
        .sort((left, right) => left.currentLevel - right.currentLevel
          || rules.balance.buildPriority.indexOf(left.buildingId)
            - rules.balance.buildPriority.indexOf(right.buildingId));
      const selected = candidates.find(({ buildingId, targetLevel }) => (
        canAfford(state, adjustedCost(buildingId, targetLevel))
      ));
      if (!selected) return;
      const baseCost = constructionCost(rules, selected.buildingId, selected.targetLevel);
      const cost = adjustedCost(selected.buildingId, selected.targetLevel);
      for (const resourceId of RESOURCE_IDS) {
        state.catchUpSavedCost += (baseCost[resourceId] ?? 0) - (cost[resourceId] ?? 0);
      }
      const causeId = `${sessionId}:construction:${selected.buildingId}:${selected.targetLevel}`;
      consume(absoluteHour, cost, 'construction', causeId);
      const baseHours = constructionHours(rules, selected.buildingId, selected.targetLevel);
      const hours = adjustedHours(selected.buildingId, selected.targetLevel);
      state.catchUpSavedHours += baseHours - hours;
      const completeAtHour = absoluteHour + hours;
      state.pending.push({
        buildingId: selected.buildingId,
        targetLevel: selected.targetLevel,
        completeAtHour,
      });
      state.constructions.push({
        causeId,
        buildingId: selected.buildingId,
        targetLevel: selected.targetLevel,
        startedAtHour: absoluteHour,
        completeAtHour,
      });
      state.constructionStarted += 1;
    }
  };

  /**
   * 따라잡기 감소율(D-029). 기준 인프라보다 뒤처진 만큼 건설 비용·시간을 줄인다.
   * 기준 이상이면 0이므로 앞선 계정에는 적용되지 않는다.
   */
  const catchUpReduction = (): number => {
    const catchUp = input.catchUp;
    if (catchUp === undefined) return 0;
    let current = 0;
    for (const buildingId of cityBuildingIds(rules)) current += state.buildings[buildingId];
    const gap = Math.max(0, catchUp.referenceLevels - current);
    return Math.min(catchUp.maxReduction, gap * catchUp.perLevelRate);
  };

  const adjustedCost = (buildingId: BuildingId, targetLevel: number): PartialBundle => {
    const base = constructionCost(rules, buildingId, targetLevel);
    const reduction = input.catchUp?.applyToCost === true ? catchUpReduction() : 0;
    if (reduction <= 0) return base;
    const scaled: PartialBundle = {};
    for (const resourceId of RESOURCE_IDS) {
      const amount = base[resourceId];
      if (amount === undefined || amount === 0) continue;
      scaled[resourceId] = Math.max(1, Math.ceil(amount * (1 - reduction)));
    }
    return scaled;
  };

  const adjustedHours = (buildingId: BuildingId, targetLevel: number): number => {
    const base = constructionHours(rules, buildingId, targetLevel);
    const reduction = input.catchUp?.applyToHours === true ? catchUpReduction() : 0;
    if (reduction <= 0) return base;
    return Math.max(1, Math.ceil(base * (1 - reduction)));
  };

  const nextConstructionReserve = (): PartialBundle => {
    const projected = { ...state.buildings };
    for (const item of state.pending) projected[item.buildingId] = item.targetLevel;
    const selected = cityBuildingIds(rules)
      .map((buildingId) => ({
        buildingId,
        currentLevel: projected[buildingId],
        targetLevel: projected[buildingId] + 1,
      }))
      .filter(({ buildingId, targetLevel }) => targetLevel <= buildingDef(rules, buildingId).maxLevel)
      .filter(({ buildingId, targetLevel }) => buildingId === 'hq'
        || targetLevel <= projected.hq + rules.balance.nonHqLevelOffset)
      .sort((left, right) => left.currentLevel - right.currentLevel
        || rules.balance.buildPriority.indexOf(left.buildingId)
          - rules.balance.buildPriority.indexOf(right.buildingId))[0];
    return selected ? adjustedCost(selected.buildingId, selected.targetLevel) : {};
  };

  const upkeepFoodPerHour = (): number => {
    let food = 0;
    for (const unitId of ECONOMY_UNIT_IDS) {
      food += state.army[unitId] * rules.units[unitId].upkeepFoodPerHour;
    }
    return food;
  };

  const trainUnits = (absoluteHour: number, sessionId: string): void => {
    while (true) {
      const unitId = trainCycle[state.trainPointer];
      if (!unitId) throw new Error('훈련 주기가 비어 있습니다.');
      const definition = rules.units[unitId];
      const reserve: PartialBundle = { ...rules.balance.trainReserve };
      const constructionReserve = nextConstructionReserve();
      for (const resourceId of RESOURCE_IDS) {
        reserve[resourceId] = Math.max(
          reserve[resourceId] ?? 0,
          constructionReserve[resourceId] ?? 0,
        );
      }
      reserve.food = Math.max(
        reserve.food ?? 0,
        (upkeepFoodPerHour() + definition.upkeepFoodPerHour) * rules.balance.upkeepReserveHours,
      );
      if (canAfford(state, definition.trainCost, reserve)) {
        state.trainPointer = (state.trainPointer + 1) % trainCycle.length;
        state.trainingSequence += 1;
        consume(
          absoluteHour,
          definition.trainCost,
          'training',
          `${sessionId}:training:${state.trainingSequence}:${unitId}`,
        );
        state.army[unitId] += 1;
        state.trainedUnits += 1;
      } else {
        return;
      }
    }
  };

  const passiveProduction = (absoluteHour: number): void => {
    // 식은 construction.ts에 있다 — 서버가 같은 함수를 써야 두 곳의 생산이 갈라지지 않는다(D-045).
    const produced = hourlyProduction(
      rules,
      state.buildings,
      fromMicro(state.resources.manpower),
    );
    credit(absoluteHour, produced, 'passive_production', `hour:${absoluteHour}:production`);
  };

  /**
   * 자원지 수입(D-028). 리셋마다 매장량이 리필되고 종류가 바뀐다.
   * 리셋 직후 recaptureHours 동안은 재확보 중이라 산출이 0이다.
   */
  const nodeProduction = (absoluteHour: number): void => {
    const nodes = input.nodes;
    if (nodes === undefined) return;
    const held = Math.min(nodes.heldNodes, nodes.holdLimit);
    if (held <= 0) return;

    const resetIndex = Math.floor(absoluteHour / nodes.resetIntervalHours);
    const hoursSinceReset = absoluteHour - resetIndex * nodes.resetIntervalHours;
    if (hoursSinceReset === 0 && absoluteHour > 0) {
      // 리셋: 매장량 리필. 종류는 아래 typeFor가 resetIndex로 결정한다.
      state.nodeStock = held * nodes.stockPerNode;
    }
    if (hoursSinceReset < nodes.recaptureHours) return;
    if (state.nodeStock <= 0) return;

    const yielded = Math.min(state.nodeStock, held * nodes.yieldPerHour);
    if (yielded <= 0) return;
    state.nodeStock -= yielded;
    // 보유 노드의 종류 구성대로 나눠 담는다 — 단일 자원만 쏟아지지 않는다.
    const counts = nodeTypeCounts(nodes, resetIndex, held);
    const produced: PartialBundle = {};
    for (const [resourceId, count] of counts) {
      const share = yielded * (count / held);
      if (share <= 0) continue;
      produced[resourceId] = (produced[resourceId] ?? 0) + share;
      state.nodeIncome[resourceId] += toMicro(share);
    }
    credit(absoluteHour, produced, 'node_income', `hour:${absoluteHour}:node`);
  };

  const payUpkeep = (absoluteHour: number): void => {
    const food = upkeepFoodPerHour();
    if (food <= 0) return;
    const result = recordMutation(
      absoluteHour,
      'food',
      -toMicro(food),
      'unit_upkeep',
      `hour:${absoluteHour}:unit-upkeep`,
    );
    if (result.shortfall > 0) {
      state.starvationHours += 1;
      state.unmetUpkeepFoodMicro += result.shortfall;
    }
  };

  for (let day = 1; day <= input.days; day += 1) {
    accumulator = {
      start: copyMicroBundle(state.resources),
      produced: emptyMicroBundle(),
      consumed: emptyMicroBundle(),
      overflow: emptyMicroBundle(),
      entries: [],
    };
    let researchCharges = rules.balance.researchChargesPerDay;
    let sortieCharges = sortieMode === 'abstract' ? rules.balance.sortieChargesPerDay : 0;

    for (let hourInDay = 0; hourInDay < 24; hourInDay += 1) {
      const absoluteHour = (day - 1) * 24 + hourInDay;
      completeConstructions(absoluteHour);
      const visitIndex = visits.get(hourInDay);
      if (visitIndex !== undefined) {
        const sessionId = `day:${day}:session:${visitIndex}:hour:${absoluteHour}`;
        while (researchCharges > 0) {
          const researchCost = rules.balance.researchBaseCost
            + rules.balance.researchCostStep * state.researchCount;
          const cost = { scrip: researchCost };
          if (!canAfford(state, cost)) break;
          consume(absoluteHour, cost, 'research', `${sessionId}:research:${state.researchCount + 1}`);
          state.researchCount += 1;
          researchCharges -= 1;
        }
        while (sortieCharges > 0) {
          const currentArmyValue = armyValue(state, rules);
          if (currentArmyValue <= 0) break;
          const cost = sortieCost(rules, currentArmyValue);
          if (!canAfford(state, cost)) break;
          const causeId = `${sessionId}:sortie:${state.sortieCount + 1}`;
          consume(absoluteHour, cost, 'sortie_cost', causeId);
          credit(absoluteHour, rules.balance.sortieReward, 'sortie_reward', causeId);
          state.sortieCount += 1;
          sortieCharges -= 1;
        }
        startConstruction(absoluteHour, sessionId);
        trainUnits(absoluteHour, sessionId);
      }
      passiveProduction(absoluteHour);
      nodeProduction(absoluteHour);
      payUpkeep(absoluteHour);
    }

    const resources = {} as DailyLedger['resources'] & Record<ResourceId, DailyLedger['resources'][ResourceId]>;
    for (const resourceId of RESOURCE_IDS) {
      resources[resourceId] = {
        startBalance: fromMicro(accumulator.start[resourceId]),
        produced: fromMicro(accumulator.produced[resourceId]),
        consumed: fromMicro(accumulator.consumed[resourceId]),
        overflow: fromMicro(accumulator.overflow[resourceId]),
        endBalance: fromMicro(state.resources[resourceId]),
        cap: fromMicro(capMicro(rules, state, resourceId)),
      };
    }
    dailyReports.push({ day, resources, entries: accumulator.entries });
  }

  const totalHours = input.days * 24;
  completeConstructions(totalHours);
  const totals = {} as Record<ResourceId, ResourceTotals>;
  for (const resourceId of RESOURCE_IDS) {
    totals[resourceId] = {
      produced: fromMicro(totalProduced[resourceId]),
      consumed: fromMicro(totalConsumed[resourceId]),
      overflow: fromMicro(totalOverflow[resourceId]),
      overflowRatio: Number((totalOverflow[resourceId] / Math.max(SCALE, totalProduced[resourceId])).toFixed(6)),
    };
  }
  const pendingConstructions: PendingConstruction[] = state.pending
    .slice()
    .sort((left, right) => left.completeAtHour - right.completeAtHour
      || rules.balance.buildPriority.indexOf(left.buildingId)
        - rules.balance.buildPriority.indexOf(right.buildingId))
    .map((item) => ({
      ...item,
      remainingHours: item.completeAtHour - totalHours,
    }));

  return {
    ruleVersion: rules.version,
    combatRuleVersion: rules.combatRuleVersion,
    sortieMode,
    archetypeId: input.archetype.id,
    days: input.days,
    sessionsPerDay: input.archetype.sessionsPerDay,
    totalSessions: input.days * input.archetype.sessionsPerDay,
    daily: dailyReports,
    finalResources: publicBundle(state.resources),
    finalBuildings: { ...state.buildings },
    constructions: state.constructions.slice(),
    pendingConstructions,
    finalArmy: { ...state.army },
    armyValue: armyValue(state, rules),
    totals,
    starvationHours: state.starvationHours,
    unmetUpkeepFood: fromMicro(state.unmetUpkeepFoodMicro),
    researchCount: state.researchCount,
    sortieCount: state.sortieCount,
    constructionStarted: state.constructionStarted,
    constructionCompleted: state.constructionCompleted,
    trainedUnits: state.trainedUnits,
    nodeIncome: publicBundle(state.nodeIncome),
    catchUpSavedCost: state.catchUpSavedCost,
    catchUpSavedHours: state.catchUpSavedHours,
    nodeIncomeShare: (() => {
      let nodeTotal = 0;
      let grandTotal = 0;
      for (const resourceId of RESOURCE_IDS) {
        nodeTotal += state.nodeIncome[resourceId];
        grandTotal += totalProduced[resourceId];
      }
      return grandTotal <= 0 ? 0 : nodeTotal / grandTotal;
    })(),
  };
}

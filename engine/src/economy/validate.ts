import { RULESETS } from '../rules/index.js';
import { ECONOMY_RULESETS } from './rules/index.js';
import { RESOURCE_IDS, buildingDef } from './types.js';
import type { BuildingId, EconomyRuleset, ResourceId, SeasonInput } from './types.js';

export type EconomyErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_RULE_VERSION'
  | 'INVALID_RULESET'
  | 'INVALID_DAYS'
  | 'INVALID_SORTIE_MODE'
  | 'INVALID_ARCHETYPE'
  | 'INVALID_SESSIONS_PER_DAY'
  | 'EMPTY_TRAIN_RATIO'
  | 'UNKNOWN_TRAIN_UNIT'
  | 'INVALID_TRAIN_RATIO'
  | 'INVALID_CARRY_OVER'
  | 'UNKNOWN_CARRY_OVER_BUILDING'
  | 'UNKNOWN_CARRY_OVER_UNIT'
  | 'INVALID_NODES'
  | 'INVALID_CATCH_UP';

export class EconomyError extends Error {
  readonly code: EconomyErrorCode;

  constructor(code: EconomyErrorCode, message: string) {
    super(message);
    this.name = 'EconomyError';
    this.code = code;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRuleset(rules: EconomyRuleset): void {
  if (!Object.hasOwn(RULESETS, rules.combatRuleVersion)) {
    throw new EconomyError('INVALID_RULESET', `연결된 전투 규칙 버전이 없습니다: ${rules.combatRuleVersion}`);
  }
  const combatRules = RULESETS[rules.combatRuleVersion];
  if (!combatRules) {
    throw new EconomyError('INVALID_RULESET', `전투 규칙을 불러올 수 없습니다: ${rules.combatRuleVersion}`);
  }
  const economyUnitIds = Object.keys(rules.units).sort();
  const combatUnitIds = Object.keys(combatRules.units).sort();
  if (economyUnitIds.length !== combatUnitIds.length
    || economyUnitIds.some((unitId, index) => unitId !== combatUnitIds[index])) {
    throw new EconomyError('INVALID_RULESET', '경제 병종과 전투 병종 집합이 일치하지 않습니다.');
  }
  for (const [buildingId, definition] of Object.entries(rules.buildings)) {
    if (definition.id !== buildingId) {
      throw new EconomyError('INVALID_RULESET', `건물 키와 id가 일치하지 않습니다: ${buildingId}`);
    }
  }
  for (const [unitId, definition] of Object.entries(rules.units)) {
    if (definition.unitId !== unitId) {
      throw new EconomyError('INVALID_RULESET', `병종 키와 id가 일치하지 않습니다: ${unitId}`);
    }
    const totalCost = Object.values(definition.trainCost).reduce((sum, value) => sum + (value ?? 0), 0);
    if (!(totalCost > 0)) {
      throw new EconomyError('INVALID_RULESET', `훈련 비용이 없는 병종입니다: ${unitId}`);
    }
  }
  const priority = rules.balance.buildPriority;
  if (new Set(priority).size !== Object.keys(rules.buildings).length
    || priority.some((buildingId) => !Object.hasOwn(rules.buildings, buildingId))) {
    throw new EconomyError('INVALID_RULESET', '건설 우선순위는 모든 건물을 정확히 한 번 포함해야 합니다.');
  }
}

export function validateSeasonInput(input: SeasonInput): EconomyRuleset {
  if (!isPlainRecord(input)) {
    throw new EconomyError('INVALID_INPUT', '시즌 입력은 객체여야 합니다.');
  }
  const ruleVersion = input.ruleVersion;
  if (typeof ruleVersion !== 'string' || !Object.hasOwn(ECONOMY_RULESETS, ruleVersion)) {
    throw new EconomyError('UNKNOWN_RULE_VERSION', `지원하지 않는 경제 규칙 버전입니다: ${String(ruleVersion)}`);
  }
  const rules = ECONOMY_RULESETS[ruleVersion];
  if (!rules) {
    throw new EconomyError('UNKNOWN_RULE_VERSION', `경제 규칙을 불러올 수 없습니다: ${ruleVersion}`);
  }
  validateRuleset(rules);

  if (!Number.isInteger(input.days) || input.days < 1 || input.days > rules.balance.seasonDays) {
    throw new EconomyError('INVALID_DAYS', `days는 1..${rules.balance.seasonDays} 정수여야 합니다.`);
  }
  if (input.sortieMode !== undefined
    && input.sortieMode !== 'abstract'
    && input.sortieMode !== 'disabled') {
    throw new EconomyError(
      'INVALID_SORTIE_MODE',
      `sortieMode는 abstract 또는 disabled여야 합니다: ${String(input.sortieMode)}`,
    );
  }
  if (!isPlainRecord(input.archetype)
    || typeof input.archetype.id !== 'string'
    || input.archetype.id.trim().length === 0
    || typeof input.archetype.nameKo !== 'string'
    || input.archetype.nameKo.trim().length === 0) {
    throw new EconomyError('INVALID_ARCHETYPE', '접속 코호트 id와 이름이 필요합니다.');
  }
  const sessions = input.archetype.sessionsPerDay;
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > rules.balance.maxSessionsPerDay) {
    throw new EconomyError(
      'INVALID_SESSIONS_PER_DAY',
      `sessionsPerDay는 1..${rules.balance.maxSessionsPerDay} 정수여야 합니다.`,
    );
  }
  if (!isPlainRecord(input.archetype.trainRatio)) {
    throw new EconomyError('INVALID_TRAIN_RATIO', 'trainRatio는 병종별 양의 정수 가중치 객체여야 합니다.');
  }
  const ratioEntries = Object.entries(input.archetype.trainRatio);
  if (ratioEntries.length === 0) {
    throw new EconomyError('EMPTY_TRAIN_RATIO', '훈련 비율에 병종이 하나 이상 필요합니다.');
  }
  let totalWeight = 0;
  for (const [unitId, weight] of ratioEntries) {
    if (!Object.hasOwn(rules.units, unitId)) {
      throw new EconomyError('UNKNOWN_TRAIN_UNIT', `알 수 없는 훈련 병종입니다: ${unitId}`);
    }
    if (!Number.isInteger(weight) || weight < 1 || weight > rules.balance.maxTrainRatioWeight) {
      throw new EconomyError(
        'INVALID_TRAIN_RATIO',
        `훈련 가중치는 1..${rules.balance.maxTrainRatioWeight} 정수여야 합니다: ${unitId}`,
      );
    }
    totalWeight += weight;
  }
  if (totalWeight > rules.balance.maxTrainRatioTotal) {
    throw new EconomyError(
      'INVALID_TRAIN_RATIO',
      `훈련 가중치 합은 ${rules.balance.maxTrainRatioTotal} 이하여야 합니다.`,
    );
  }
  validateCarryOver(input.carryOver, rules);
  validateNodes(input.nodes);
  validateCatchUp(input.catchUp);
  return rules;
}

/** 따라잡기 보정 입력 검증(D-029). */
function validateCatchUp(catchUp: unknown): void {
  if (catchUp === undefined) return;
  if (!isPlainRecord(catchUp)) {
    throw new EconomyError('INVALID_CATCH_UP', 'catchUp은 객체여야 합니다.');
  }
  const reference = catchUp.referenceLevels;
  if (!Number.isInteger(reference) || (reference as number) < 0 || (reference as number) > 100_000) {
    throw new EconomyError('INVALID_CATCH_UP', 'referenceLevels는 0..100000 정수여야 합니다.');
  }
  const rate = catchUp.perLevelRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new EconomyError('INVALID_CATCH_UP', 'perLevelRate는 0..1 이어야 합니다.');
  }
  const max = catchUp.maxReduction;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0 || max > 0.9) {
    throw new EconomyError('INVALID_CATCH_UP', 'maxReduction은 0..0.9 이어야 합니다.');
  }
  for (const key of ['applyToCost', 'applyToHours'] as const) {
    if (typeof catchUp[key] !== 'boolean') {
      throw new EconomyError('INVALID_CATCH_UP', `${key}는 boolean이어야 합니다.`);
    }
  }
}

/** 맵 자원 영토 입력 검증(D-028). heldNodes는 동시 보유 상한을 넘을 수 없다. */
function validateNodes(nodes: unknown): void {
  if (nodes === undefined) return;
  if (!isPlainRecord(nodes)) {
    throw new EconomyError('INVALID_NODES', 'nodes는 객체여야 합니다.');
  }
  const positiveInts = ['holdLimit', 'resetIntervalHours'] as const;
  for (const key of positiveInts) {
    const value = nodes[key];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100_000) {
      throw new EconomyError('INVALID_NODES', `${key}는 1..100000 정수여야 합니다.`);
    }
  }
  const nonNegativeInts = ['heldNodes', 'recaptureHours', 'typeSeed'] as const;
  for (const key of nonNegativeInts) {
    const value = nodes[key];
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000) {
      throw new EconomyError('INVALID_NODES', `${key}는 0..100000 정수여야 합니다.`);
    }
  }
  const nonNegativeNumbers = ['yieldPerHour', 'stockPerNode'] as const;
  for (const key of nonNegativeNumbers) {
    const value = nodes[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new EconomyError('INVALID_NODES', `${key}는 0 이상 유한수여야 합니다.`);
    }
  }
  if ((nodes.heldNodes as number) > (nodes.holdLimit as number)) {
    throw new EconomyError('INVALID_NODES', 'heldNodes는 holdLimit을 넘을 수 없습니다(D-028 결정 1).');
  }
  if ((nodes.recaptureHours as number) >= (nodes.resetIntervalHours as number)) {
    throw new EconomyError('INVALID_NODES', 'recaptureHours는 resetIntervalHours보다 작아야 합니다.');
  }
}

/** 시즌 간 인계 상태 검증(D-027 검토용). 생략 시 규칙의 시작값을 쓴다. */
function validateCarryOver(carryOver: unknown, rules: EconomyRuleset): void {
  if (carryOver === undefined) return;
  if (!isPlainRecord(carryOver)) {
    throw new EconomyError('INVALID_CARRY_OVER', 'carryOver는 객체여야 합니다.');
  }
  for (const key of Object.keys(carryOver)) {
    if (key !== 'buildings' && key !== 'army' && key !== 'resources') {
      throw new EconomyError('INVALID_CARRY_OVER', `carryOver에 허용되지 않은 필드가 있습니다: ${key}`);
    }
  }
  if (carryOver.buildings !== undefined) {
    if (!isPlainRecord(carryOver.buildings)) {
      throw new EconomyError('INVALID_CARRY_OVER', 'carryOver.buildings는 객체여야 합니다.');
    }
    for (const [buildingId, level] of Object.entries(carryOver.buildings)) {
      if (!Object.hasOwn(rules.buildings, buildingId)) {
        throw new EconomyError('UNKNOWN_CARRY_OVER_BUILDING', `알 수 없는 건물입니다: ${buildingId}`);
      }
      const maxLevel = buildingDef(rules, buildingId as BuildingId).maxLevel;
      if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > maxLevel) {
        throw new EconomyError(
          'INVALID_CARRY_OVER',
          `${buildingId} 인계 레벨은 1..${maxLevel} 정수여야 합니다.`,
        );
      }
    }
  }
  if (carryOver.army !== undefined) {
    if (!isPlainRecord(carryOver.army)) {
      throw new EconomyError('INVALID_CARRY_OVER', 'carryOver.army는 객체여야 합니다.');
    }
    for (const [unitId, count] of Object.entries(carryOver.army)) {
      if (!Object.hasOwn(rules.units, unitId)) {
        throw new EconomyError('UNKNOWN_CARRY_OVER_UNIT', `알 수 없는 병종입니다: ${unitId}`);
      }
      if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 1_000_000) {
        throw new EconomyError('INVALID_CARRY_OVER', `${unitId} 인계 수량은 0..1000000 정수여야 합니다.`);
      }
    }
  }
  if (carryOver.resources !== undefined) {
    if (!isPlainRecord(carryOver.resources)) {
      throw new EconomyError('INVALID_CARRY_OVER', 'carryOver.resources는 객체여야 합니다.');
    }
    for (const [resourceId, amount] of Object.entries(carryOver.resources)) {
      if (!RESOURCE_IDS.includes(resourceId as ResourceId)) {
        throw new EconomyError('INVALID_CARRY_OVER', `알 수 없는 자원입니다: ${resourceId}`);
      }
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new EconomyError('INVALID_CARRY_OVER', `${resourceId} 인계량은 0 이상 유한수여야 합니다.`);
      }
    }
  }
}

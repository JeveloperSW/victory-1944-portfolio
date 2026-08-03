import { RULESETS } from '../rules/index.js';
import {
  cityBuildingIds,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
} from '../economy/types.js';
import { ECONOMY_RULESETS } from '../economy/rules/index.js';
import { CAMPAIGN_RULESETS } from './rules/index.js';
import type {
  ArmyInventory,
  CampaignCheckpointInput,
  CampaignRuleset,
} from './types.js';

export type CampaignErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_RULE_VERSION'
  | 'INCOMPATIBLE_RULE_VERSION'
  | 'ABSTRACT_SORTIES_NOT_ALLOWED'
  | 'INVALID_CHECKPOINT'
  | 'INVALID_STATE'
  | 'STATE_HASH_MISMATCH'
  | 'INVALID_COMMAND_ID'
  | 'INVALID_REVISION'
  | 'STALE_REVISION'
  | 'UNKNOWN_SCENARIO'
  | 'INSUFFICIENT_UNITS'
  | 'INSUFFICIENT_RESOURCES'
  | 'COMMAND_ID_REUSED'
  | 'INVALID_RECOVERY'
  | 'INVALID_TIME'
  | 'INTERNAL_INVARIANT';

export class CampaignError extends Error {
  readonly code: CampaignErrorCode;

  constructor(code: CampaignErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'CampaignError';
    this.code = code;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateInventory(value: unknown, label: string): ArmyInventory {
  if (!isPlainRecord(value) || !hasExactKeys(value, ECONOMY_UNIT_IDS)) {
    throw new CampaignError('INVALID_CHECKPOINT', `${label} 병력표는 12종 병종을 정확히 포함해야 한다.`);
  }
  const inventory = {} as ArmyInventory;
  for (const unitId of ECONOMY_UNIT_IDS) {
    const count = value[unitId];
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new CampaignError('INVALID_CHECKPOINT', `${label}.${unitId} 수량은 0 이상의 정수여야 한다.`);
    }
    inventory[unitId] = count as number;
  }
  return inventory;
}

export function validateCampaignCheckpoint(input: CampaignCheckpointInput): CampaignRuleset {
  if (!isPlainRecord(input)) {
    throw new CampaignError('INVALID_INPUT', '캠페인 체크포인트 입력은 객체여야 한다.');
  }
  if (typeof input.ruleVersion !== 'string' || !Object.hasOwn(CAMPAIGN_RULESETS, input.ruleVersion)) {
    throw new CampaignError('UNKNOWN_RULE_VERSION', `지원하지 않는 캠페인 규칙 버전: ${String(input.ruleVersion)}`);
  }
  const rules = CAMPAIGN_RULESETS[input.ruleVersion as keyof typeof CAMPAIGN_RULESETS];
  if (!rules) throw new CampaignError('UNKNOWN_RULE_VERSION', '캠페인 규칙을 불러올 수 없다.');
  if (!isPlainRecord(input.season)) {
    throw new CampaignError('INVALID_CHECKPOINT', '경제 시즌 보고서 형식이 잘못됐다.');
  }
  const season = input.season;
  if (season.ruleVersion !== rules.economyRuleVersion
    || season.combatRuleVersion !== rules.combatRuleVersion
    || !Object.hasOwn(ECONOMY_RULESETS, season.ruleVersion as string)
    || !Object.hasOwn(RULESETS, season.combatRuleVersion as string)) {
    throw new CampaignError('INCOMPATIBLE_RULE_VERSION', '캠페인·경제·전투 규칙 버전이 호환되지 않는다.');
  }
  if (season.sortieMode !== 'disabled') {
    throw new CampaignError(
      'ABSTRACT_SORTIES_NOT_ALLOWED',
      '실제 NPC 전투에 연결할 경제 보고서는 추상 출정을 비활성화해야 한다.',
    );
  }
  if (!Number.isInteger(season.days) || (season.days as number) < 1) {
    throw new CampaignError('INVALID_CHECKPOINT', '경제 체크포인트 일수가 잘못됐다.');
  }
  const army = validateInventory(season.finalArmy, 'finalArmy');
  const combatRules = RULESETS[rules.combatRuleVersion];
  if (!combatRules) throw new CampaignError('INCOMPATIBLE_RULE_VERSION', '전투 규칙이 없다.');
  const computedArmyValue = ECONOMY_UNIT_IDS.reduce(
    (sum, unitId) => sum + army[unitId] * (combatRules.units[unitId]?.cost ?? 0),
    0,
  );
  if (season.armyValue !== computedArmyValue) {
    throw new CampaignError('INVALID_CHECKPOINT', '경제 보고서의 병력 가치와 실제 병종 합계가 일치하지 않는다.');
  }
  if (!isPlainRecord(season.finalResources) || !hasExactKeys(season.finalResources, RESOURCE_IDS)) {
    throw new CampaignError('INVALID_CHECKPOINT', '최종 자원표가 완전하지 않다.');
  }
  for (const resourceId of RESOURCE_IDS) {
    const amount = season.finalResources[resourceId];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new CampaignError('INVALID_CHECKPOINT', `${resourceId} 잔액이 유효하지 않다.`);
    }
  }
  // 건물 집합은 전역 목록이 아니라 이 체크포인트의 경제 규칙이 정한다(D-043).
  const economyRules = ECONOMY_RULESETS[rules.economyRuleVersion];
  if (!economyRules) {
    throw new CampaignError('UNKNOWN_RULE_VERSION', `알 수 없는 경제 규칙: ${rules.economyRuleVersion}`);
  }
  const buildingIds = cityBuildingIds(economyRules);
  if (!isPlainRecord(season.finalBuildings) || !hasExactKeys(season.finalBuildings, buildingIds)) {
    throw new CampaignError('INVALID_CHECKPOINT', '최종 건물표가 완전하지 않다.');
  }
  for (const buildingId of buildingIds) {
    const level = season.finalBuildings[buildingId];
    if (!Number.isInteger(level) || (level as number) < 1) {
      throw new CampaignError('INVALID_CHECKPOINT', `${buildingId} 레벨이 유효하지 않다.`);
    }
  }
  return rules;
}

export function validateCommandId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(value)) {
    throw new CampaignError('INVALID_COMMAND_ID', 'commandId는 영문·숫자·콜론·밑줄·하이픈 1..64자여야 한다.');
  }
  return value;
}

export function validateExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CampaignError('INVALID_REVISION', 'expectedRevision은 0 이상의 정수여야 한다.');
  }
  return value as number;
}

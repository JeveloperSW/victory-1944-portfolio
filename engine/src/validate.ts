import type { ArmySnapshot, BattleInput, Ruleset } from './types.js';
import { RULESETS } from './rules/index.js';

export type EngineErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_RULE_VERSION'
  | 'INVALID_SEED'
  | 'EMPTY_ARMY'
  | 'TOO_MANY_STACKS'
  | 'INVALID_UNIT'
  | 'INVALID_COUNT'
  | 'INVALID_ROW'
  | 'INVALID_RESERVE'
  | 'INVALID_SUPPLY'
  | 'INVALID_RECON'
  | 'INVALID_THRESHOLD'
  | 'INVALID_OFFICER'
  | 'INVALID_DOCTRINE';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'EngineError';
    this.code = code;
  }
}

const ROWS = new Set(['front', 'mid', 'back']);

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function inUnitRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArmy(label: string, army: ArmySnapshot, rules: Ruleset): void {
  if (!isRecord(army)) {
    throw new EngineError('INVALID_INPUT', `${label}: 부대 스냅샷 형식이 잘못됐다`);
  }
  const { balance } = rules;
  if (!Array.isArray(army.stacks)) {
    throw new EngineError('INVALID_INPUT', `${label}: 스택 목록 형식이 잘못됐다`);
  }
  if (army.stacks.length === 0) {
    throw new EngineError('EMPTY_ARMY', `${label}: 부대가 비어 있다`);
  }
  if (army.stacks.length > balance.maxStacks) {
    throw new EngineError('TOO_MANY_STACKS', `${label}: 스택 수 상한(${balance.maxStacks}) 초과`);
  }
  for (const stack of army.stacks) {
    if (!isRecord(stack)) {
      throw new EngineError('INVALID_INPUT', `${label}: 스택 형식이 잘못됐다`);
    }
    if (typeof stack.unitId !== 'string' || !Object.hasOwn(rules.units, stack.unitId)) {
      throw new EngineError('INVALID_UNIT', `${label}: 알 수 없는 병종 ${String(stack.unitId)}`);
    }
    const def = rules.units[stack.unitId]!;
    if (!isInt(stack.count) || stack.count < 1 || stack.count > balance.maxStackCount) {
      throw new EngineError('INVALID_COUNT', `${label}: ${stack.unitId} 수량이 1..${balance.maxStackCount} 정수가 아니다`);
    }
    if (!ROWS.has(stack.row)) {
      throw new EngineError('INVALID_ROW', `${label}: ${stack.unitId} 열 값이 잘못됐다`);
    }
    if (stack.reserveRound !== undefined && (!isInt(stack.reserveRound) || stack.reserveRound < 1 || stack.reserveRound > balance.maxRounds)) {
      throw new EngineError('INVALID_RESERVE', `${label}: ${stack.unitId} 예비대 라운드가 1..${balance.maxRounds} 정수가 아니다`);
    }
  }
  if (!inUnitRange(army.supply)) {
    throw new EngineError('INVALID_SUPPLY', `${label}: 보급은 0..1 이어야 한다`);
  }
  if (!inUnitRange(army.reconAccuracy)) {
    throw new EngineError('INVALID_RECON', `${label}: 정찰 정확도는 0..1 이어야 한다`);
  }
  if (typeof army.retreatThreshold !== 'number' || !Number.isFinite(army.retreatThreshold) || army.retreatThreshold < 0 || army.retreatThreshold > 0.9) {
    throw new EngineError('INVALID_THRESHOLD', `${label}: 철수 임계값은 0..0.9 이어야 한다`);
  }
  if (typeof army.doctrine !== 'string' || !Object.hasOwn(rules.doctrines, army.doctrine)) {
    throw new EngineError('INVALID_DOCTRINE', `${label}: 알 수 없는 교리 ${String(army.doctrine)}`);
  }
  if (army.officer !== undefined) {
    const o = army.officer;
    if (!isRecord(o)) {
      throw new EngineError('INVALID_OFFICER', `${label}: 장교 스냅샷 형식이 잘못됐다`);
    }
    const stats = [o.command, o.tactics, o.admin, o.intel, o.logistics];
    if (stats.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 100)) {
      throw new EngineError('INVALID_OFFICER', `${label}: 장교 능력치는 0..100 이어야 한다`);
    }
  }
}

/** 입력을 검증하고 규칙 세트를 반환한다. 실패 시 EngineError를 던진다. */
export function validateInput(input: BattleInput): Ruleset {
  if (!isRecord(input)) {
    throw new EngineError('INVALID_INPUT', '전투 입력 형식이 잘못됐다');
  }
  if (typeof input.ruleVersion !== 'string') {
    throw new EngineError('INVALID_INPUT', '규칙 버전 형식이 잘못됐다');
  }
  if (!Object.hasOwn(RULESETS, input.ruleVersion)) {
    throw new EngineError('UNSUPPORTED_RULE_VERSION', `지원하지 않는 규칙 버전 ${input.ruleVersion}`);
  }
  const rules = RULESETS[input.ruleVersion]!;
  if (!isInt(input.seed) || input.seed < 0 || input.seed > 0xffffffff) {
    throw new EngineError('INVALID_SEED', '시드는 0..2^32-1 정수여야 한다');
  }
  validateArmy('attacker', input.attacker, rules);
  validateArmy('defender', input.defender, rules);
  return rules;
}

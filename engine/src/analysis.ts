import { fnv1a64, stableStringify } from './hash.js';
import { RULESETS } from './rules/index.js';
import type {
  AttackEvent,
  BattleAnalysis,
  BattleCasualtyFact,
  BattleCounterFact,
  BattleResult,
  CounterReport,
  Ruleset,
  Side,
  SideReport,
} from './types.js';

export type BattleAnalysisErrorCode =
  | 'INVALID_BATTLE_RESULT'
  | 'UNSUPPORTED_RULE_VERSION'
  | 'RESULT_HASH_MISMATCH';

export class BattleAnalysisError extends Error {
  readonly code: BattleAnalysisErrorCode;

  constructor(code: BattleAnalysisErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'BattleAnalysisError';
    this.code = code;
  }
}

const SIDES = new Set(['attacker', 'defender']);
const ROWS = new Set(['front', 'mid', 'back']);
const OUTCOMES = new Set(['attacker_win', 'defender_win', 'draw']);
const REASONS = new Set(['annihilation', 'retreat', 'timeout', 'mutual_retreat']);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function invalid(message: string): never {
  throw new BattleAnalysisError('INVALID_BATTLE_RESULT', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function counterOrder(left: CounterReport, right: CounterReport): number {
  return right.totalDamage - left.totalDamage
    || compareText(left.side, right.side)
    || compareText(left.unitId, right.unitId)
    || compareText(left.targetUnitId, right.targetUnitId)
    || right.multiplier - left.multiplier;
}

function buildCounterReports(events: readonly AttackEvent[]): CounterReport[] {
  const reports = new Map<string, CounterReport>();
  for (const event of events) {
    if (event.counterMult <= 1.001) continue;
    const key = `${event.side}|${event.unitId}|${event.targetUnitId}`;
    const existing = reports.get(key);
    if (existing) {
      existing.totalDamage += event.damage;
      if (event.counterMult > existing.multiplier) existing.multiplier = event.counterMult;
    } else {
      reports.set(key, {
        side: event.side,
        unitId: event.unitId,
        targetUnitId: event.targetUnitId,
        multiplier: event.counterMult,
        totalDamage: event.damage,
      });
    }
  }
  const result = [...reports.values()];
  for (const report of result) report.totalDamage = Math.round(report.totalDamage * 10) / 10;
  result.sort((left, right) =>
    right.totalDamage - left.totalDamage || compareText(left.unitId, right.unitId));
  return result;
}

function validateSideReport(label: Side, report: unknown, rules: Ruleset): asserts report is SideReport {
  if (!isRecord(report) || !Array.isArray(report.stacks) || report.stacks.length === 0) {
    invalid(`${label}: 병력 보고서 형식이 잘못됐다`);
  }
  if (typeof report.infoAdvantage !== 'boolean'
    || !isNonNegativeFinite(report.reconScore)
    || !isNonNegativeFinite(report.effectiveSupply)
    || !isNonNegativeFinite(report.attackMultiplier)
    || !isNonNegativeFinite(report.remainingRatio)
    || report.remainingRatio > 1
    || !isNonNegativeInteger(report.totalCost)) {
    invalid(`${label}: 전투 지표 형식이 잘못됐다`);
  }

  let expectedCost = 0;
  for (const stack of report.stacks) {
    if (!isRecord(stack)
      || typeof stack.unitId !== 'string'
      || !Object.hasOwn(rules.units, stack.unitId)) {
      invalid(`${label}: 알 수 없는 병종 보고서가 있다`);
    }
    const unit = rules.units[stack.unitId]!;
    if (stack.nameKo !== unit.nameKo
      || typeof stack.row !== 'string'
      || !ROWS.has(stack.row)) {
      invalid(`${label}: 병종 이름 또는 열 보고서가 규칙과 다르다`);
    }
    if (!isNonNegativeInteger(stack.initial) || stack.initial < 1
      || !isNonNegativeInteger(stack.survivors)
      || !isNonNegativeInteger(stack.dead)
      || !isNonNegativeInteger(stack.wounded)
      || !isNonNegativeFinite(stack.damageDealt)
      || !isNonNegativeFinite(stack.damageTaken)
      || stack.survivors + stack.dead + stack.wounded !== stack.initial) {
      invalid(`${label}: 병력 보존 또는 피해 보고서가 잘못됐다`);
    }
    expectedCost += unit.cost * stack.initial;
  }
  if (report.totalCost !== expectedCost) {
    invalid(`${label}: 총비용이 병종 보고서와 일치하지 않는다`);
  }
}

function validateEvents(result: BattleResult, rules: Ruleset): void {
  if (!Array.isArray(result.events) || !Array.isArray(result.counters)) {
    invalid('이벤트 또는 상성 보고서 형식이 잘못됐다');
  }
  for (const event of result.events) {
    if (!isRecord(event)
      || !isNonNegativeInteger(event.round)
      || event.round < 1
      || event.round > result.rounds
      || !SIDES.has(event.side)
      || typeof event.unitId !== 'string'
      || !Object.hasOwn(rules.units, event.unitId)
      || typeof event.targetUnitId !== 'string'
      || !Object.hasOwn(rules.units, event.targetUnitId)
      || !isNonNegativeFinite(event.damage)
      || !isNonNegativeFinite(event.counterMult)) {
      invalid('전투 이벤트 형식이 잘못됐다');
    }
  }
  for (const counter of result.counters) {
    if (!isRecord(counter)
      || !SIDES.has(counter.side)
      || typeof counter.unitId !== 'string'
      || !Object.hasOwn(rules.units, counter.unitId)
      || typeof counter.targetUnitId !== 'string'
      || !Object.hasOwn(rules.units, counter.targetUnitId)
      || !isNonNegativeFinite(counter.multiplier)
      || !isNonNegativeFinite(counter.totalDamage)) {
      invalid('상성 보고서 형식이 잘못됐다');
    }
  }
  if (stableStringify(buildCounterReports(result.events)) !== stableStringify(result.counters)) {
    invalid('상성 보고서가 전투 이벤트와 일치하지 않는다');
  }
}

function validateBattleResult(value: unknown): { result: BattleResult; rules: Ruleset } {
  if (!isRecord(value)) invalid('전투 결과 형식이 잘못됐다');
  if (typeof value.ruleVersion !== 'string') invalid('규칙 버전 형식이 잘못됐다');
  if (!Object.hasOwn(RULESETS, value.ruleVersion)) {
    throw new BattleAnalysisError(
      'UNSUPPORTED_RULE_VERSION',
      `지원하지 않는 규칙 버전 ${value.ruleVersion}`,
    );
  }
  if (typeof value.hash !== 'string' || !/^[0-9a-f]{16}$/.test(value.hash)) {
    invalid('결과 해시 형식이 잘못됐다');
  }
  const { hash, ...payload } = value;
  if (fnv1a64(stableStringify(payload)) !== hash) {
    throw new BattleAnalysisError('RESULT_HASH_MISMATCH', '전투 결과 해시가 payload와 일치하지 않는다');
  }

  const result = value as unknown as BattleResult;
  const rules = RULESETS[value.ruleVersion]!;
  if (!Number.isInteger(result.seed) || result.seed < 0 || result.seed > 0xffffffff
    || !OUTCOMES.has(result.outcome)
    || !REASONS.has(result.reason)
    || !Number.isInteger(result.rounds)
    || result.rounds < 1
    || result.rounds > rules.balance.maxRounds
    || (result.initiative !== null && !SIDES.has(result.initiative))) {
    invalid('전투 결과 메타데이터가 잘못됐다');
  }
  validateSideReport('attacker', result.attacker, rules);
  validateSideReport('defender', result.defender, rules);
  validateEvents(result, rules);
  return { result, rules };
}

function casualtyFact(side: Side, report: SideReport): BattleCasualtyFact {
  const initial = report.stacks.reduce((sum, stack) => sum + stack.initial, 0);
  const survivors = report.stacks.reduce((sum, stack) => sum + stack.survivors, 0);
  const wounded = report.stacks.reduce((sum, stack) => sum + stack.wounded, 0);
  const dead = report.stacks.reduce((sum, stack) => sum + stack.dead, 0);
  const losses = wounded + dead;
  return {
    side,
    initial,
    survivors,
    wounded,
    dead,
    losses,
    lossRate: Math.round((losses / initial) * 1000) / 1000,
  };
}

/**
 * 전투 결과를 영속 보고서와 UI가 공통으로 소비할 수 있는 구조로 분석한다.
 * 외부 상태를 읽지 않고 결과 해시·핵심 불변식을 검증한 뒤 깊게 동결된 값을 반환한다.
 */
export function analyzeBattle(value: BattleResult): BattleAnalysis {
  const { result, rules } = validateBattleResult(value);
  const losingSide: Side | null =
    result.outcome === 'attacker_win'
      ? 'defender'
      : result.outcome === 'defender_win'
        ? 'attacker'
        : null;
  const winningSide: Side | null =
    losingSide === 'attacker' ? 'defender' : losingSide === 'defender' ? 'attacker' : null;
  const keyCounters: BattleCounterFact[] = [...result.counters]
    .sort(counterOrder)
    .slice(0, 3)
    .map((counter) => ({
      side: counter.side,
      unitId: counter.unitId,
      unitNameKo: rules.units[counter.unitId]!.nameKo,
      targetUnitId: counter.targetUnitId,
      targetUnitNameKo: rules.units[counter.targetUnitId]!.nameKo,
      multiplier: counter.multiplier,
      totalDamage: counter.totalDamage,
    }));
  const decisive = winningSide === null
    ? undefined
    : keyCounters.find((counter) => counter.side === winningSide);

  const issues: BattleAnalysis['issues'] = losingSide === null
    ? [{
        code: 'BATTLE_STALEMATE',
        side: null,
        messageKo: '결정적 우세 없이 전투가 교착됐다.',
      }]
    : decisive
      ? [{
          code: 'COUNTER_VULNERABILITY',
          side: losingSide,
          messageKo:
            `적 ${decisive.unitNameKo}의 ${decisive.targetUnitNameKo} 대상 공격은 `
            + `${decisive.multiplier}배 상성이며 누적 피해는 ${decisive.totalDamage}다.`,
        }]
      : [{
          code: 'ATTRITION_DEFEAT',
          side: losingSide,
          messageKo: '결정적 상성 없이 소모전에서 패배했다.',
        }];
  const recommendations: BattleAnalysis['recommendations'] = losingSide === null
    ? [{
        code: 'BREAK_STALEMATE',
        side: null,
        messageKo: '조합을 바꾸거나 예비대 투입 시점을 조정하세요.',
      }]
    : decisive
      ? [{
          code: 'COUNTER_DECISIVE_UNIT',
          side: losingSide,
          messageKo:
            `${decisive.unitNameKo}에 대응하는 병종을 먼저 배치하거나 `
            + '포병·항공 선제 타격을 고려하세요.',
        }]
      : [{
          code: 'ADD_COUNTER_COVERAGE',
          side: losingSide,
          messageKo: '적 주력에 맞는 상성 병종 편성을 추가하세요.',
        }];

  return deepFreeze({
    ruleVersion: result.ruleVersion,
    resultHash: result.hash,
    outcome: result.outcome,
    losingSide,
    casualties: {
      attacker: casualtyFact('attacker', result.attacker),
      defender: casualtyFact('defender', result.defender),
    },
    keyCounters,
    issues,
    recommendations,
  });
}

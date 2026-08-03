import { fnv1a64, stableStringify } from '../hash.js';
import { RULESETS } from '../rules/index.js';
import { simulateBattle } from '../simulate.js';
import { validateInput } from '../validate.js';
import type {
  ArmySnapshot,
  BattleInput,
  DoctrineId,
  StackOrder,
} from '../types.js';
import { ECONOMY_RULESETS } from '../economy/rules/index.js';
import {
  cityBuildingIds,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
} from '../economy/types.js';
import type {
  BuildingId,
  EconomyUnitId,
  PartialBundle,
  ResourceBundle,
  ResourceId,
} from '../economy/types.js';
import { CAMPAIGN_RULESETS } from './rules/index.js';
import {
  CampaignError,
  isPlainRecord,
  validateCampaignCheckpoint,
  validateCommandId,
  validateExpectedRevision,
} from './validate.js';
import type {
  ArmyInventory,
  CampaignBattleRecord,
  CampaignCheckpointInput,
  CampaignCommandReceipt,
  CampaignLedgerEntry,
  CampaignRuleset,
  CampaignState,
  CampaignTransition,
  AdvanceTimeCommand,
  NpcBattleCommand,
  RecoveryCommand,
  RecoveryOrder,
  TimeAdvanceRecord,
} from './types.js';

type CampaignStatePayload = Omit<CampaignState, 'hash'>;

const STATE_KEYS = [
  'ruleVersion',
  'economyRuleVersion',
  'combatRuleVersion',
  'originHour',
  'nowHour',
  'revision',
  'originArmy',
  'readyArmy',
  'woundedArmy',
  'recoveringArmy',
  'deadArmy',
  'originResources',
  'resources',
  'buildings',
  'ledger',
  'battleRecords',
  'recoveryOrders',
  'timeAdvanceRecords',
  'receipts',
  'hash',
] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function emptyArmy(): ArmyInventory {
  return Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, 0])) as ArmyInventory;
}

function copyArmy(source: Readonly<ArmyInventory>): ArmyInventory {
  return Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, source[unitId]])) as ArmyInventory;
}

function payloadOf(state: CampaignState): CampaignStatePayload {
  const { hash: _hash, ...payload } = state;
  return payload;
}

function finalizeState(payload: CampaignStatePayload): CampaignState {
  const state: CampaignState = {
    ...payload,
    hash: fnv1a64(stableStringify(payload)),
  };
  return deepFreeze(state);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CampaignError('INVALID_STATE', `${label} 키 집합이 잘못됐다.`);
  }
}

function assertInventory(value: unknown, label: string): asserts value is ArmyInventory {
  if (!isPlainRecord(value)) throw new CampaignError('INVALID_STATE', `${label} 형식이 잘못됐다.`);
  assertExactKeys(value, ECONOMY_UNIT_IDS, label);
  for (const unitId of ECONOMY_UNIT_IDS) {
    const count = value[unitId];
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new CampaignError('INVALID_STATE', `${label}.${unitId}가 0 이상의 정수가 아니다.`);
    }
  }
}

function assertResourceBundle(value: unknown): asserts value is ResourceBundle {
  if (!isPlainRecord(value)) throw new CampaignError('INVALID_STATE', '자원표 형식이 잘못됐다.');
  assertExactKeys(value, RESOURCE_IDS, 'resources');
  for (const resourceId of RESOURCE_IDS) {
    const amount = value[resourceId];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new CampaignError('INVALID_STATE', `${resourceId} 잔액이 유효하지 않다.`);
    }
  }
}

function assertCampaignState(state: unknown): asserts state is CampaignState {
  if (!isPlainRecord(state)) throw new CampaignError('INVALID_STATE', '캠페인 상태는 객체여야 한다.');
  assertExactKeys(state, STATE_KEYS, 'campaignState');
  if (typeof state.ruleVersion !== 'string' || !Object.hasOwn(CAMPAIGN_RULESETS, state.ruleVersion)) {
    throw new CampaignError('INVALID_STATE', '캠페인 규칙 버전이 유효하지 않다.');
  }
  const rules = CAMPAIGN_RULESETS[state.ruleVersion as keyof typeof CAMPAIGN_RULESETS];
  if (!rules
    || state.economyRuleVersion !== rules.economyRuleVersion
    || state.combatRuleVersion !== rules.combatRuleVersion) {
    throw new CampaignError('INVALID_STATE', '연결 규칙 버전이 호환되지 않는다.');
  }
  if (typeof state.hash !== 'string'
    || state.hash !== fnv1a64(stableStringify(payloadOf(state as unknown as CampaignState)))) {
    throw new CampaignError('STATE_HASH_MISMATCH', '캠페인 상태 해시가 일치하지 않는다.');
  }
  if (!Number.isInteger(state.originHour) || (state.originHour as number) < 0
    || !Number.isInteger(state.nowHour) || (state.nowHour as number) < (state.originHour as number)
    || !Number.isInteger(state.revision) || (state.revision as number) < 0) {
    throw new CampaignError('INVALID_STATE', '시간 또는 revision이 유효하지 않다.');
  }
  assertInventory(state.originArmy, 'originArmy');
  assertInventory(state.readyArmy, 'readyArmy');
  assertInventory(state.woundedArmy, 'woundedArmy');
  assertInventory(state.recoveringArmy, 'recoveringArmy');
  assertInventory(state.deadArmy, 'deadArmy');
  for (const unitId of ECONOMY_UNIT_IDS) {
    const accounted = state.readyArmy[unitId]
      + state.woundedArmy[unitId]
      + state.recoveringArmy[unitId]
      + state.deadArmy[unitId];
    if (accounted !== state.originArmy[unitId]) {
      throw new CampaignError('INVALID_STATE', `${unitId} 병력 보존식이 깨졌다.`);
    }
  }
  assertResourceBundle(state.originResources);
  assertResourceBundle(state.resources);
  if (!isPlainRecord(state.buildings)) throw new CampaignError('INVALID_STATE', '건물표 형식이 잘못됐다.');
  const economyRulesForState = ECONOMY_RULESETS[state.economyRuleVersion];
  if (!economyRulesForState) {
    throw new CampaignError('UNKNOWN_RULE_VERSION', `알 수 없는 경제 규칙: ${state.economyRuleVersion}`);
  }
  const stateBuildingIds = cityBuildingIds(economyRulesForState);
  assertExactKeys(state.buildings, stateBuildingIds, 'buildings');
  for (const buildingId of stateBuildingIds) {
    const level = state.buildings[buildingId];
    if (!Number.isInteger(level) || (level as number) < 1) {
      throw new CampaignError('INVALID_STATE', `${buildingId} 레벨이 유효하지 않다.`);
    }
  }
  if (!Array.isArray(state.ledger)
    || !Array.isArray(state.battleRecords)
    || !Array.isArray(state.recoveryOrders)
    || !Array.isArray(state.timeAdvanceRecords)
    || !Array.isArray(state.receipts)) {
    throw new CampaignError('INVALID_STATE', '캠페인 이력 배열 형식이 잘못됐다.');
  }
  const receiptIds = new Set<string>();
  for (const receipt of state.receipts) {
    if (!isPlainRecord(receipt)
      || typeof receipt.commandId !== 'string'
      || typeof receipt.payload !== 'string'
      || typeof receipt.payloadHash !== 'string'
      || !['npc_battle', 'recovery', 'advance_time'].includes(receipt.kind as string)
      || !Number.isInteger(receipt.previousRevision)
      || !Number.isInteger(receipt.appliedRevision)) {
      throw new CampaignError('INVALID_STATE', '명령 영수증 형식이 잘못됐다.');
    }
    if ((receipt.previousRevision as number) + 1 !== receipt.appliedRevision) {
      throw new CampaignError('INVALID_STATE', '명령 영수증 revision 연결이 잘못됐다.');
    }
    if ((receipt.appliedRevision as number) > (state.revision as number)) {
      throw new CampaignError('INVALID_STATE', '명령 영수증 revision이 현재 상태보다 앞선다.');
    }
    if (receiptIds.has(receipt.commandId)) throw new CampaignError('INVALID_STATE', '명령 영수증 ID가 중복됐다.');
    receiptIds.add(receipt.commandId);
  }
  if ((state.revision as number) !== state.receipts.length) {
    throw new CampaignError('INVALID_STATE', 'revision과 명령 영수증 수가 일치하지 않는다.');
  }
  state.receipts.forEach((receipt, index) => {
    if (receipt.previousRevision !== index || receipt.appliedRevision !== index + 1) {
      throw new CampaignError('INVALID_STATE', '명령 영수증 revision 체인이 순차적이지 않다.');
    }
  });
  const pending = emptyArmy();
  for (const order of state.recoveryOrders) {
    if (!isPlainRecord(order)
      || typeof order.commandId !== 'string'
      || typeof order.payloadHash !== 'string'
      || !Number.isInteger(order.startedAtHour)
      || !Number.isInteger(order.completeAtHour)
      || !Number.isInteger(order.supplyCost)
      || (order.supplyCost as number) < 1
      || !['pending', 'completed'].includes(order.status as string)) {
      throw new CampaignError('INVALID_STATE', '회복 대기열 형식이 잘못됐다.');
    }
    assertInventory(order.units, `recoveryOrders.${order.commandId}.units`);
    if (order.status === 'pending') {
      if ((order.completeAtHour as number) <= (state.nowHour as number)
        || order.completedAtHour !== undefined) {
        throw new CampaignError('INVALID_STATE', '완료 시각이 지난 회복 대기열이 pending 상태다.');
      }
      for (const unitId of ECONOMY_UNIT_IDS) pending[unitId] += order.units[unitId];
    } else if (order.completedAtHour !== order.completeAtHour
      || (order.completeAtHour as number) > (state.nowHour as number)) {
      throw new CampaignError('INVALID_STATE', '완료된 회복 대기열의 시각이 잘못됐다.');
    }
  }
  for (const unitId of ECONOMY_UNIT_IDS) {
    if (pending[unitId] !== state.recoveringArmy[unitId]) {
      throw new CampaignError('INVALID_STATE', `${unitId} 회복 대기 병력 합계가 맞지 않는다.`);
    }
  }
  for (const record of state.battleRecords) {
    if (!isPlainRecord(record)
      || typeof record.commandId !== 'string'
      || typeof record.payloadHash !== 'string'
      || !isPlainRecord(record.result)
      || typeof record.result.hash !== 'string') {
      throw new CampaignError('INVALID_STATE', '전투 기록 형식이 잘못됐다.');
    }
    const scenario = rules.scenarios[record.scenarioId as string];
    if (!scenario || !Array.isArray(record.deployment) || typeof record.doctrine !== 'string') {
      throw new CampaignError('INVALID_STATE', '전투 기록의 시나리오 또는 편성이 잘못됐다.');
    }
    const replayed = simulateBattle({
      ruleVersion: rules.combatRuleVersion,
      seed: record.seed as number,
      attacker: {
        stacks: record.deployment as StackOrder[],
        doctrine: record.doctrine as DoctrineId,
        supply: rules.attackerDefaults.supply,
        reconAccuracy: rules.attackerDefaults.reconAccuracy,
        retreatThreshold: rules.attackerDefaults.retreatThreshold,
      },
      defender: scenario.defender,
    });
    if (stableStringify(replayed) !== stableStringify(record.result)) {
      throw new CampaignError('INVALID_STATE', `전투 기록 ${String(record.commandId)}을 재현할 수 없다.`);
    }
  }
  for (const record of state.timeAdvanceRecords) {
    if (!isPlainRecord(record)
      || typeof record.commandId !== 'string'
      || typeof record.payloadHash !== 'string'
      || !Number.isInteger(record.fromHour)
      || !Number.isInteger(record.toHour)
      || !Array.isArray(record.completedRecoveryIds)) {
      throw new CampaignError('INVALID_STATE', '시간 진행 기록 형식이 잘못됐다.');
    }
  }
  const ledgerIds = new Set<string>();
  const lastBalance = new Map<ResourceId, number>();
  for (const entry of state.ledger) {
    if (!isPlainRecord(entry)
      || typeof entry.id !== 'string'
      || typeof entry.commandId !== 'string'
      || !Number.isInteger(entry.hour)
      || typeof entry.delta !== 'number'
      || typeof entry.balanceBefore !== 'number'
      || typeof entry.balanceAfter !== 'number') {
      throw new CampaignError('INVALID_STATE', '캠페인 원장 형식이 잘못됐다.');
    }
    if (!RESOURCE_IDS.includes(entry.resourceId as ResourceId)
      || !['sortie_cost', 'sortie_reward', 'recovery_cost'].includes(entry.reason as string)
      || !receiptIds.has(entry.commandId as string)
      || ledgerIds.has(entry.id as string)) {
      throw new CampaignError('INVALID_STATE', `원장 엔트리 ${String(entry.id)}의 식별자가 잘못됐다.`);
    }
    ledgerIds.add(entry.id as string);
    const priorBalance = lastBalance.get(entry.resourceId as ResourceId);
    if (priorBalance !== undefined && priorBalance !== entry.balanceBefore) {
      throw new CampaignError('INVALID_STATE', `원장 엔트리 ${String(entry.id)}의 잔액 체인이 끊겼다.`);
    }
    if (round3(entry.balanceBefore + entry.delta) !== entry.balanceAfter || entry.balanceAfter < 0) {
      throw new CampaignError('INVALID_STATE', `원장 엔트리 ${entry.id}의 보존식이 깨졌다.`);
    }
    lastBalance.set(entry.resourceId as ResourceId, entry.balanceAfter as number);
  }
  for (const [resourceId, balance] of lastBalance) {
    if (balance !== state.resources[resourceId]) {
      throw new CampaignError('INVALID_STATE', `${resourceId} 최종 잔액이 원장과 일치하지 않는다.`);
    }
  }
  if (state.receipts.length
    !== state.battleRecords.length + state.recoveryOrders.length + state.timeAdvanceRecords.length) {
    throw new CampaignError('INVALID_STATE', '명령 영수증과 결과 기록 수가 일치하지 않는다.');
  }
  for (const receipt of state.receipts) {
    const record = receipt.kind === 'npc_battle'
      ? state.battleRecords.find((candidate) => candidate.commandId === receipt.commandId)
      : receipt.kind === 'recovery'
        ? state.recoveryOrders.find((candidate) => candidate.commandId === receipt.commandId)
        : state.timeAdvanceRecords.find((candidate) => candidate.commandId === receipt.commandId);
    if (!record || record.payloadHash !== receipt.payloadHash) {
      throw new CampaignError('INVALID_STATE', `명령 ${receipt.commandId}의 영수증과 결과가 연결되지 않는다.`);
    }
  }
  validateHistorySemantics(state as unknown as CampaignState, rules);
}

function assertSameValue(actual: unknown, expected: unknown, message: string): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new CampaignError('INVALID_STATE', message);
  }
}

function expectedLedgerEntry(
  commandId: string,
  hour: number,
  resourceId: ResourceId,
  reason: CampaignLedgerEntry['reason'],
  before: number,
  after: number,
): CampaignLedgerEntry {
  return {
    id: `${commandId}:${reason}:${resourceId}`,
    hour,
    commandId,
    resourceId,
    reason,
    delta: round3(after - before),
    balanceBefore: before,
    balanceAfter: after,
  };
}

/** 최초 체크포인트부터 명령을 순서대로 재생해 저장 상태의 제품 의미를 검증한다. */
function validateHistorySemantics(state: CampaignState, rules: CampaignRuleset): void {
  const combatRules = RULESETS[state.combatRuleVersion];
  if (!combatRules) throw new CampaignError('INVALID_STATE', '전투 규칙을 재생할 수 없다.');
  let nowHour = state.originHour;
  const balances: ResourceBundle = { ...state.originResources };
  const ready = copyArmy(state.originArmy);
  const wounded = emptyArmy();
  const recovering = emptyArmy();
  const dead = emptyArmy();
  const pendingRecoveryIds = new Set<string>();
  const expectedLedger: CampaignLedgerEntry[] = [];
  const seenBattleIds = new Set<string>();
  const seenRecoveryIds = new Set<string>();
  const seenTimeIds = new Set<string>();

  const applyCost = (
    commandId: string,
    hour: number,
    bundle: Readonly<PartialBundle>,
    reason: 'sortie_cost' | 'recovery_cost',
  ): void => {
    for (const resourceId of RESOURCE_IDS) {
      const amount = bundle[resourceId] ?? 0;
      if (!(amount > 0)) continue;
      const before = balances[resourceId];
      const after = round3(before - amount);
      if (after < 0) throw new CampaignError('INVALID_STATE', `${commandId} 실행 당시 ${resourceId}가 부족했다.`);
      balances[resourceId] = after;
      expectedLedger.push(expectedLedgerEntry(commandId, hour, resourceId, reason, before, after));
    }
  };

  const applyReward = (
    commandId: string,
    hour: number,
    bundle: Readonly<PartialBundle>,
  ): PartialBundle => {
    const applied: PartialBundle = {};
    for (const resourceId of RESOURCE_IDS) {
      const amount = bundle[resourceId] ?? 0;
      if (!(amount > 0)) continue;
      const before = balances[resourceId];
      const after = round3(Math.min(resourceCap(state, resourceId), before + amount));
      balances[resourceId] = after;
      applied[resourceId] = round3(after - before);
      expectedLedger.push(expectedLedgerEntry(
        commandId,
        hour,
        resourceId,
        'sortie_reward',
        before,
        after,
      ));
    }
    return applied;
  };

  for (const receipt of state.receipts) {
    if (fnv1a64(receipt.payload) !== receipt.payloadHash) {
      throw new CampaignError('INVALID_STATE', `${receipt.commandId} payload 해시가 맞지 않는다.`);
    }
    if (receipt.kind === 'npc_battle') {
      const record = state.battleRecords.find((candidate) => candidate.commandId === receipt.commandId);
      if (!record || seenBattleIds.has(record.commandId)) {
        throw new CampaignError('INVALID_STATE', `${receipt.commandId} 전투 기록이 없거나 중복됐다.`);
      }
      seenBattleIds.add(record.commandId);
      const expectedPayload = stableStringify({
        kind: 'npc_battle',
        scenarioId: record.scenarioId,
        seed: record.seed,
        deployment: record.deployment,
        doctrine: record.doctrine,
      });
      if (receipt.payload !== expectedPayload || record.payloadHash !== receipt.payloadHash
        || record.startedAtHour !== nowHour) {
        throw new CampaignError('INVALID_STATE', `${record.commandId} 전투 payload 또는 시각이 맞지 않는다.`);
      }
      const deployed = deployedInventory(record.deployment);
      for (const unitId of ECONOMY_UNIT_IDS) {
        if (deployed[unitId] > ready[unitId]) {
          throw new CampaignError('INVALID_STATE', `${record.commandId}가 ${unitId} 보유량을 초과했다.`);
        }
      }
      const deployedValue = ECONOMY_UNIT_IDS.reduce(
        (sum, unitId) => sum + deployed[unitId] * (combatRules.units[unitId]?.cost ?? 0),
        0,
      );
      const expectedCost = sortieCost(state, deployedValue);
      assertSameValue(record.sortieCost, expectedCost, `${record.commandId} 출정 비용이 규칙과 다르다.`);
      applyCost(record.commandId, nowHour, expectedCost, 'sortie_cost');
      const scenario = rules.scenarios[record.scenarioId];
      if (!scenario) throw new CampaignError('INVALID_STATE', `${record.scenarioId} 시나리오가 없다.`);
      const reward = applyReward(
        record.commandId,
        nowHour,
        record.result.outcome === 'attacker_win' ? scenario.victoryReward : {},
      );
      assertSameValue(record.reward, reward, `${record.commandId} 승리 보상이 규칙과 다르다.`);
      for (const unitId of ECONOMY_UNIT_IDS) ready[unitId] -= deployed[unitId];
      for (const stack of record.result.attacker.stacks) {
        const unitId = stack.unitId as EconomyUnitId;
        ready[unitId] += stack.survivors;
        wounded[unitId] += stack.wounded;
        dead[unitId] += stack.dead;
      }
      continue;
    }

    if (receipt.kind === 'recovery') {
      const order = state.recoveryOrders.find((candidate) => candidate.commandId === receipt.commandId);
      if (!order || seenRecoveryIds.has(order.commandId)) {
        throw new CampaignError('INVALID_STATE', `${receipt.commandId} 회복 기록이 없거나 중복됐다.`);
      }
      seenRecoveryIds.add(order.commandId);
      const expectedPayload = stableStringify({ kind: 'recovery', units: order.units });
      const recoveryValue = ECONOMY_UNIT_IDS.reduce(
        (sum, unitId) => sum + order.units[unitId] * (combatRules.units[unitId]?.cost ?? 0),
        0,
      );
      const expectedSupplyCost = Math.ceil(recoveryValue * rules.recoverySupplyCostRatio);
      if (receipt.payload !== expectedPayload || order.payloadHash !== receipt.payloadHash
        || order.startedAtHour !== nowHour
        || order.completeAtHour !== nowHour + rules.recoveryHours
        || order.supplyCost !== expectedSupplyCost) {
        throw new CampaignError('INVALID_STATE', `${order.commandId} 회복 규칙 또는 payload가 맞지 않는다.`);
      }
      if (!(recoveryValue > 0)) throw new CampaignError('INVALID_STATE', `${order.commandId} 회복 병력이 비어 있다.`);
      for (const unitId of ECONOMY_UNIT_IDS) {
        if (order.units[unitId] > wounded[unitId]) {
          throw new CampaignError('INVALID_STATE', `${order.commandId}가 ${unitId} 부상병을 초과했다.`);
        }
      }
      applyCost(order.commandId, nowHour, { supplies: order.supplyCost }, 'recovery_cost');
      for (const unitId of ECONOMY_UNIT_IDS) {
        wounded[unitId] -= order.units[unitId];
        recovering[unitId] += order.units[unitId];
      }
      pendingRecoveryIds.add(order.commandId);
      continue;
    }

    const record = state.timeAdvanceRecords.find((candidate) => candidate.commandId === receipt.commandId);
    if (!record || seenTimeIds.has(record.commandId)) {
      throw new CampaignError('INVALID_STATE', `${receipt.commandId} 시간 기록이 없거나 중복됐다.`);
    }
    seenTimeIds.add(record.commandId);
    const expectedPayload = stableStringify({ kind: 'advance_time', targetHour: record.toHour });
    if (receipt.payload !== expectedPayload || record.payloadHash !== receipt.payloadHash
      || record.fromHour !== nowHour || record.toHour <= nowHour) {
      throw new CampaignError('INVALID_STATE', `${record.commandId} 시간 진행 규칙 또는 payload가 맞지 않는다.`);
    }
    const dueIds = state.recoveryOrders
      .filter((order) => pendingRecoveryIds.has(order.commandId) && order.completeAtHour <= record.toHour)
      .map((order) => order.commandId);
    assertSameValue(
      record.completedRecoveryIds,
      dueIds,
      `${record.commandId}가 완료한 회복 대기열 목록이 맞지 않는다.`,
    );
    for (const orderId of dueIds) {
      const order = state.recoveryOrders.find((candidate) => candidate.commandId === orderId);
      if (!order) throw new CampaignError('INVALID_STATE', `${orderId} 회복 기록이 없다.`);
      for (const unitId of ECONOMY_UNIT_IDS) {
        recovering[unitId] -= order.units[unitId];
        ready[unitId] += order.units[unitId];
      }
      pendingRecoveryIds.delete(orderId);
    }
    nowHour = record.toHour;
  }

  if (seenBattleIds.size !== state.battleRecords.length
    || seenRecoveryIds.size !== state.recoveryOrders.length
    || seenTimeIds.size !== state.timeAdvanceRecords.length) {
    throw new CampaignError('INVALID_STATE', '영수증 없이 존재하는 결과 기록이 있다.');
  }
  assertSameValue(state.ledger, expectedLedger, '캠페인 원장을 최초 잔액부터 재현할 수 없다.');
  assertSameValue(state.resources, balances, '최종 자원을 최초 잔액과 원장에서 재현할 수 없다.');
  assertSameValue(state.readyArmy, ready, '최종 가용 병력을 명령 이력에서 재현할 수 없다.');
  assertSameValue(state.woundedArmy, wounded, '최종 부상병을 명령 이력에서 재현할 수 없다.');
  assertSameValue(state.recoveringArmy, recovering, '최종 회복 대기 병력을 명령 이력에서 재현할 수 없다.');
  assertSameValue(state.deadArmy, dead, '최종 전사자를 명령 이력에서 재현할 수 없다.');
  if (state.nowHour !== nowHour) throw new CampaignError('INVALID_STATE', '최종 시간을 명령 이력에서 재현할 수 없다.');
  for (const order of state.recoveryOrders) {
    const expectedStatus = pendingRecoveryIds.has(order.commandId) ? 'pending' : 'completed';
    if (order.status !== expectedStatus
      || (expectedStatus === 'completed' && order.completedAtHour !== order.completeAtHour)) {
      throw new CampaignError('INVALID_STATE', `${order.commandId} 최종 회복 상태가 이력과 다르다.`);
    }
  }
}

function rulesForState(state: CampaignState): CampaignRuleset {
  const rules = CAMPAIGN_RULESETS[state.ruleVersion as keyof typeof CAMPAIGN_RULESETS];
  if (!rules) throw new CampaignError('INVALID_STATE', '캠페인 규칙을 불러올 수 없다.');
  return rules;
}

function normalizeDeployment(value: unknown): StackOrder[] {
  if (!Array.isArray(value)) throw new CampaignError('INVALID_INPUT', 'deployment는 스택 배열이어야 한다.');
  return value.map((raw) => {
    if (!isPlainRecord(raw)) throw new CampaignError('INVALID_INPUT', 'deployment 스택 형식이 잘못됐다.');
    const normalized: StackOrder = {
      unitId: raw.unitId as string,
      count: raw.count as number,
      row: raw.row as StackOrder['row'],
    };
    if (raw.reserveRound !== undefined) normalized.reserveRound = raw.reserveRound as number;
    return normalized;
  });
}

function deployedInventory(stacks: readonly StackOrder[]): ArmyInventory {
  const deployed = emptyArmy();
  for (const stack of stacks) deployed[stack.unitId as EconomyUnitId] += stack.count;
  return deployed;
}

function commandReceipt(
  state: CampaignState,
  commandId: string,
  kind: CampaignCommandReceipt['kind'],
  payload: string,
  payloadHash: string,
): CampaignCommandReceipt | undefined {
  const receipt = state.receipts.find((candidate) => candidate.commandId === commandId);
  if (!receipt) return undefined;
  if (receipt.kind !== kind || receipt.payload !== payload || receipt.payloadHash !== payloadHash) {
    throw new CampaignError('COMMAND_ID_REUSED', '같은 commandId가 다른 명령 또는 payload에 재사용됐다.');
  }
  return receipt;
}

function assertRevision(state: CampaignState, expectedRevision: number): void {
  if (state.revision !== expectedRevision) {
    throw new CampaignError(
      'STALE_REVISION',
      `revision 불일치: expected=${expectedRevision}, actual=${state.revision}`,
    );
  }
}

function resourceCap(state: CampaignState, resourceId: ResourceId): number {
  const economyRules = ECONOMY_RULESETS[state.economyRuleVersion];
  if (!economyRules) throw new CampaignError('INTERNAL_INVARIANT', '경제 규칙을 불러올 수 없다.');
  const { balance } = economyRules;
  if (resourceId === 'manpower') {
    return balance.housingCapBase + balance.housingCapPerLevel * state.buildings.housing;
  }
  if (resourceId === 'scrip') {
    return balance.scripCapBase + balance.scripCapPerHqLevel * state.buildings.hq;
  }
  return balance.warehouseCapBase + balance.warehouseCapPerLevel * state.buildings.warehouse;
}

interface BundleApplication {
  resources: ResourceBundle;
  ledger: CampaignLedgerEntry[];
  applied: PartialBundle;
}

function applyBundle(
  state: CampaignState,
  resourcesBefore: Readonly<ResourceBundle>,
  bundle: Readonly<PartialBundle>,
  sign: -1 | 1,
  reason: CampaignLedgerEntry['reason'],
  commandId: string,
): BundleApplication {
  const resources = { ...resourcesBefore };
  const ledger: CampaignLedgerEntry[] = [];
  const applied: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const amount = bundle[resourceId] ?? 0;
    if (!(amount > 0)) continue;
    const before = resources[resourceId];
    const target = sign < 0
      ? before - amount
      : Math.min(resourceCap(state, resourceId), before + amount);
    if (target < -0.000_001) {
      throw new CampaignError('INSUFFICIENT_RESOURCES', `${resourceId}가 부족하다.`);
    }
    const after = round3(Math.max(0, target));
    const delta = round3(after - before);
    resources[resourceId] = after;
    applied[resourceId] = Math.abs(delta);
    ledger.push({
      id: `${commandId}:${reason}:${resourceId}`,
      hour: state.nowHour,
      commandId,
      resourceId,
      reason,
      delta,
      balanceBefore: before,
      balanceAfter: after,
    });
  }
  return { resources, ledger, applied };
}

function sortieCostForEconomyVersion(
  economyRuleVersion: string,
  deployedValue: number,
): PartialBundle {
  const rules = ECONOMY_RULESETS[economyRuleVersion];
  if (!rules) throw new CampaignError('INTERNAL_INVARIANT', '경제 규칙을 불러올 수 없다.');
  const cost: PartialBundle = {};
  for (const resourceId of RESOURCE_IDS) {
    const base = rules.balance.sortieBaseCost[resourceId] ?? 0;
    const ratio = rules.balance.sortieCostPerArmyValue[resourceId] ?? 0;
    const amount = Math.ceil(base + deployedValue * ratio);
    if (amount > 0) cost[resourceId] = amount;
  }
  return cost;
}

function sortieCost(state: CampaignState, deployedValue: number): PartialBundle {
  return sortieCostForEconomyVersion(state.economyRuleVersion, deployedValue);
}

function applyCasualties(
  state: CampaignState,
  deployment: Readonly<ArmyInventory>,
  result: CampaignBattleRecord['result'],
): Pick<CampaignStatePayload, 'readyArmy' | 'woundedArmy' | 'deadArmy'> {
  const ready = copyArmy(state.readyArmy);
  const wounded = copyArmy(state.woundedArmy);
  const dead = copyArmy(state.deadArmy);
  for (const unitId of ECONOMY_UNIT_IDS) ready[unitId] -= deployment[unitId];
  for (const stack of result.attacker.stacks) {
    const unitId = stack.unitId as EconomyUnitId;
    ready[unitId] += stack.survivors;
    wounded[unitId] += stack.wounded;
    dead[unitId] += stack.dead;
  }
  for (const unitId of ECONOMY_UNIT_IDS) {
    if (ready[unitId] < 0) throw new CampaignError('INTERNAL_INVARIANT', `${unitId} ready 병력이 음수가 됐다.`);
  }
  return { readyArmy: ready, woundedArmy: wounded, deadArmy: dead };
}

export function createCampaignState(input: CampaignCheckpointInput): CampaignState {
  const rules = validateCampaignCheckpoint(input);
  const originArmy = copyArmy(input.season.finalArmy);
  return finalizeState({
    ruleVersion: rules.version,
    economyRuleVersion: rules.economyRuleVersion,
    combatRuleVersion: rules.combatRuleVersion,
    originHour: input.season.days * 24,
    nowHour: input.season.days * 24,
    revision: 0,
    originArmy,
    readyArmy: copyArmy(originArmy),
    woundedArmy: emptyArmy(),
    recoveringArmy: emptyArmy(),
    deadArmy: emptyArmy(),
    originResources: { ...input.season.finalResources },
    resources: { ...input.season.finalResources },
    buildings: { ...input.season.finalBuildings },
    ledger: [],
    battleRecords: [],
    recoveryOrders: [],
    timeAdvanceRecords: [],
    receipts: [],
  });
}

export function executeNpcBattle(
  state: CampaignState,
  command: NpcBattleCommand,
): CampaignTransition<CampaignBattleRecord> {
  assertCampaignState(state);
  if (!isPlainRecord(command)) throw new CampaignError('INVALID_INPUT', 'NPC 전투 명령은 객체여야 한다.');
  const commandId = validateCommandId(command.commandId);
  const expectedRevision = validateExpectedRevision(command.expectedRevision);
  const rules = rulesForState(state);
  if (typeof command.scenarioId !== 'string' || !Object.hasOwn(rules.scenarios, command.scenarioId)) {
    throw new CampaignError('UNKNOWN_SCENARIO', `알 수 없는 NPC 시나리오: ${String(command.scenarioId)}`);
  }
  const scenario = rules.scenarios[command.scenarioId];
  if (!scenario) throw new CampaignError('UNKNOWN_SCENARIO', 'NPC 시나리오를 불러올 수 없다.');
  const deployment = normalizeDeployment(command.deployment);
  const attacker: ArmySnapshot = {
    stacks: deployment,
    doctrine: command.doctrine as DoctrineId,
    supply: rules.attackerDefaults.supply,
    reconAccuracy: rules.attackerDefaults.reconAccuracy,
    retreatThreshold: rules.attackerDefaults.retreatThreshold,
  };
  const battleInput: BattleInput = {
    ruleVersion: state.combatRuleVersion,
    seed: command.seed,
    attacker,
    defender: scenario.defender,
  };
  validateInput(battleInput);
  const payload = stableStringify({
    kind: 'npc_battle',
    scenarioId: scenario.id,
    seed: command.seed,
    deployment,
    doctrine: command.doctrine,
  });
  const payloadHash = fnv1a64(payload);
  const priorReceipt = commandReceipt(state, commandId, 'npc_battle', payload, payloadHash);
  if (priorReceipt) {
    const record = state.battleRecords.find((candidate) => candidate.commandId === commandId);
    if (!record) throw new CampaignError('INVALID_STATE', '전투 영수증에 대응하는 기록이 없다.');
    return { state, record, duplicate: true };
  }
  assertRevision(state, expectedRevision);
  const deployed = deployedInventory(deployment);
  for (const unitId of ECONOMY_UNIT_IDS) {
    if (deployed[unitId] > state.readyArmy[unitId]) {
      throw new CampaignError('INSUFFICIENT_UNITS', `${unitId} 보유 병력이 부족하다.`);
    }
  }
  const combatRules = RULESETS[state.combatRuleVersion];
  if (!combatRules) throw new CampaignError('INTERNAL_INVARIANT', '전투 규칙을 불러올 수 없다.');
  const deployedValue = ECONOMY_UNIT_IDS.reduce(
    (sum, unitId) => sum + deployed[unitId] * (combatRules.units[unitId]?.cost ?? 0),
    0,
  );
  const cost = sortieCost(state, deployedValue);
  const costApplication = applyBundle(state, state.resources, cost, -1, 'sortie_cost', commandId);
  const result = simulateBattle(battleInput);
  if (result.attacker.totalCost !== deployedValue) {
    throw new CampaignError('INTERNAL_INVARIANT', '전투 투입 가치가 캠페인 계산과 일치하지 않는다.');
  }
  const rewardRequest = result.outcome === 'attacker_win' ? scenario.victoryReward : {};
  const rewardApplication = applyBundle(
    state,
    costApplication.resources,
    rewardRequest,
    1,
    'sortie_reward',
    commandId,
  );
  const record: CampaignBattleRecord = {
    commandId,
    payloadHash,
    scenarioId: scenario.id,
    seed: command.seed,
    startedAtHour: state.nowHour,
    deployment,
    doctrine: command.doctrine,
    sortieCost: costApplication.applied,
    reward: rewardApplication.applied,
    result,
  };
  const casualties = applyCasualties(state, deployed, result);
  const nextRevision = state.revision + 1;
  const receipt: CampaignCommandReceipt = {
    commandId,
    kind: 'npc_battle',
    payload,
    payloadHash,
    previousRevision: state.revision,
    appliedRevision: nextRevision,
  };
  const next = finalizeState({
    ...payloadOf(state),
    ...casualties,
    revision: nextRevision,
    resources: rewardApplication.resources,
    ledger: [...state.ledger, ...costApplication.ledger, ...rewardApplication.ledger],
    battleRecords: [...state.battleRecords, record],
    receipts: [...state.receipts, receipt],
  });
  return { state: next, record, duplicate: false };
}

function normalizeRecoveryRequest(value: unknown): ArmyInventory {
  if (!isPlainRecord(value)) throw new CampaignError('INVALID_RECOVERY', '회복 병력 요청은 객체여야 한다.');
  const units = emptyArmy();
  let total = 0;
  for (const [unitId, rawCount] of Object.entries(value)) {
    if (!ECONOMY_UNIT_IDS.includes(unitId as EconomyUnitId)) {
      throw new CampaignError('INVALID_RECOVERY', `알 수 없는 회복 병종: ${unitId}`);
    }
    if (!Number.isInteger(rawCount) || (rawCount as number) < 1) {
      throw new CampaignError('INVALID_RECOVERY', `${unitId} 회복 수량은 1 이상의 정수여야 한다.`);
    }
    units[unitId as EconomyUnitId] = rawCount as number;
    total += rawCount as number;
  }
  if (total === 0) throw new CampaignError('INVALID_RECOVERY', '회복할 부상병이 한 명 이상 필요하다.');
  return units;
}

export function queueRecovery(
  state: CampaignState,
  command: RecoveryCommand,
): CampaignTransition<RecoveryOrder> {
  assertCampaignState(state);
  if (!isPlainRecord(command)) throw new CampaignError('INVALID_INPUT', '회복 명령은 객체여야 한다.');
  const commandId = validateCommandId(command.commandId);
  const expectedRevision = validateExpectedRevision(command.expectedRevision);
  const units = normalizeRecoveryRequest(command.units);
  const payload = stableStringify({ kind: 'recovery', units });
  const payloadHash = fnv1a64(payload);
  const priorReceipt = commandReceipt(state, commandId, 'recovery', payload, payloadHash);
  if (priorReceipt) {
    const order = state.recoveryOrders.find((candidate) => candidate.commandId === commandId);
    if (!order) throw new CampaignError('INVALID_STATE', '회복 영수증에 대응하는 대기열이 없다.');
    return { state, record: order, duplicate: true };
  }
  assertRevision(state, expectedRevision);
  for (const unitId of ECONOMY_UNIT_IDS) {
    if (units[unitId] > state.woundedArmy[unitId]) {
      throw new CampaignError('INVALID_RECOVERY', `${unitId} 부상병이 부족하다.`);
    }
  }
  const rules = rulesForState(state);
  const combatRules = RULESETS[state.combatRuleVersion];
  if (!combatRules) throw new CampaignError('INTERNAL_INVARIANT', '전투 규칙을 불러올 수 없다.');
  const recoveryValue = ECONOMY_UNIT_IDS.reduce((sum, unitId) => {
    const unitCost = combatRules.units[unitId]?.cost;
    if (unitCost === undefined) throw new CampaignError('INTERNAL_INVARIANT', `${unitId} 전투 규칙이 없다.`);
    return sum + unitCost * units[unitId];
  }, 0);
  const supplyCost = Math.ceil(recoveryValue * rules.recoverySupplyCostRatio);
  const costApplication = applyBundle(
    state,
    state.resources,
    { supplies: supplyCost },
    -1,
    'recovery_cost',
    commandId,
  );
  const wounded = copyArmy(state.woundedArmy);
  const recovering = copyArmy(state.recoveringArmy);
  for (const unitId of ECONOMY_UNIT_IDS) {
    wounded[unitId] -= units[unitId];
    recovering[unitId] += units[unitId];
  }
  const order: RecoveryOrder = {
    commandId,
    payloadHash,
    units,
    supplyCost,
    startedAtHour: state.nowHour,
    completeAtHour: state.nowHour + rules.recoveryHours,
    status: 'pending',
  };
  const nextRevision = state.revision + 1;
  const receipt: CampaignCommandReceipt = {
    commandId,
    kind: 'recovery',
    payload,
    payloadHash,
    previousRevision: state.revision,
    appliedRevision: nextRevision,
  };
  const next = finalizeState({
    ...payloadOf(state),
    revision: nextRevision,
    woundedArmy: wounded,
    recoveringArmy: recovering,
    resources: costApplication.resources,
    ledger: [...state.ledger, ...costApplication.ledger],
    recoveryOrders: [...state.recoveryOrders, order],
    receipts: [...state.receipts, receipt],
  });
  return { state: next, record: order, duplicate: false };
}

export function advanceCampaignTime(
  state: CampaignState,
  command: AdvanceTimeCommand,
): CampaignTransition<TimeAdvanceRecord> {
  assertCampaignState(state);
  if (!isPlainRecord(command)) throw new CampaignError('INVALID_INPUT', '시간 진행 명령은 객체여야 한다.');
  const commandId = validateCommandId(command.commandId);
  const expectedRevision = validateExpectedRevision(command.expectedRevision);
  const targetHour = command.targetHour;
  if (!Number.isInteger(targetHour) || targetHour < 0 || targetHour > 10_000_000) {
    throw new CampaignError('INVALID_TIME', 'targetHour는 0..10000000 정수여야 한다.');
  }
  const payload = stableStringify({ kind: 'advance_time', targetHour });
  const payloadHash = fnv1a64(payload);
  const priorReceipt = commandReceipt(state, commandId, 'advance_time', payload, payloadHash);
  if (priorReceipt) {
    const record = state.timeAdvanceRecords.find((candidate) => candidate.commandId === commandId);
    if (!record) throw new CampaignError('INVALID_STATE', '시간 영수증에 대응하는 기록이 없다.');
    return { state, record, duplicate: true };
  }
  assertRevision(state, expectedRevision);
  if (targetHour <= state.nowHour) {
    throw new CampaignError('INVALID_TIME', `targetHour는 현재 시각 ${state.nowHour}보다 커야 한다.`);
  }
  const ready = copyArmy(state.readyArmy);
  const recovering = copyArmy(state.recoveringArmy);
  const completedRecoveryIds: string[] = [];
  const recoveryOrders = state.recoveryOrders.map((order): RecoveryOrder => {
    if (order.status === 'completed' || order.completeAtHour > targetHour) return order;
    for (const unitId of ECONOMY_UNIT_IDS) {
      ready[unitId] += order.units[unitId];
      recovering[unitId] -= order.units[unitId];
    }
    completedRecoveryIds.push(order.commandId);
    return {
      ...order,
      status: 'completed',
      completedAtHour: order.completeAtHour,
    };
  });
  const record: TimeAdvanceRecord = {
    commandId,
    payloadHash,
    fromHour: state.nowHour,
    toHour: targetHour,
    completedRecoveryIds,
  };
  const nextRevision = state.revision + 1;
  const receipt: CampaignCommandReceipt = {
    commandId,
    kind: 'advance_time',
    payload,
    payloadHash,
    previousRevision: state.revision,
    appliedRevision: nextRevision,
  };
  const next = finalizeState({
    ...payloadOf(state),
    nowHour: targetHour,
    revision: nextRevision,
    readyArmy: ready,
    recoveringArmy: recovering,
    recoveryOrders,
    timeAdvanceRecords: [...state.timeAdvanceRecords, record],
    receipts: [...state.receipts, receipt],
  });
  return { state: next, record, duplicate: false };
}

export function serializeCampaignState(state: CampaignState): string {
  assertCampaignState(state);
  return stableStringify(state);
}

export function restoreCampaignState(serialized: string): CampaignState {
  if (typeof serialized !== 'string') throw new CampaignError('INVALID_STATE', '직렬화 상태는 문자열이어야 한다.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CampaignError('INVALID_STATE', '직렬화 상태가 유효한 JSON이 아니다.');
  }
  assertCampaignState(parsed);
  return deepFreeze(parsed);
}

export function armyValue(state: CampaignState, inventory: Readonly<ArmyInventory>): number {
  assertCampaignState(state);
  const rules = RULESETS[state.combatRuleVersion];
  if (!rules) throw new CampaignError('INTERNAL_INVARIANT', '전투 규칙을 불러올 수 없다.');
  return ECONOMY_UNIT_IDS.reduce(
    (sum, unitId) => sum + inventory[unitId] * (rules.units[unitId]?.cost ?? 0),
    0,
  );
}

/**
 * 서버가 캠페인 규칙과 동일한 출정 비용을 사전 산출할 때 쓰는 순수 경계.
 * deployment는 전투 입력과 같은 규칙으로 검증하며 반환 번들은 변경할 수 없게 동결한다.
 */
export function npcSortieCost(
  campaignRuleVersion: string,
  deploymentInput: readonly StackOrder[],
): Readonly<PartialBundle> {
  if (typeof campaignRuleVersion !== 'string'
    || !Object.hasOwn(CAMPAIGN_RULESETS, campaignRuleVersion)) {
    throw new CampaignError(
      'UNKNOWN_RULE_VERSION',
      `지원하지 않는 캠페인 규칙 버전: ${String(campaignRuleVersion)}`,
    );
  }
  const campaignRules =
    CAMPAIGN_RULESETS[campaignRuleVersion as keyof typeof CAMPAIGN_RULESETS];
  if (!campaignRules) {
    throw new CampaignError('UNKNOWN_RULE_VERSION', '캠페인 규칙을 불러올 수 없다.');
  }
  const deployment = normalizeDeployment(deploymentInput);
  const scenarioId = Object.keys(campaignRules.scenarios)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0];
  const scenario = scenarioId === undefined
    ? undefined
    : campaignRules.scenarios[scenarioId];
  if (!scenario) {
    throw new CampaignError('INTERNAL_INVARIANT', '출정 비용 검증에 사용할 NPC 시나리오가 없다.');
  }
  const input: BattleInput = {
    ruleVersion: campaignRules.combatRuleVersion,
    seed: 0,
    attacker: {
      stacks: deployment,
      doctrine: 'none',
      supply: campaignRules.attackerDefaults.supply,
      reconAccuracy: campaignRules.attackerDefaults.reconAccuracy,
      retreatThreshold: campaignRules.attackerDefaults.retreatThreshold,
    },
    defender: scenario.defender,
  };
  const combatRules = validateInput(input);
  const deployedValue = deployment.reduce(
    (sum, stack) => sum + combatRules.units[stack.unitId]!.cost * stack.count,
    0,
  );
  return Object.freeze(
    sortieCostForEconomyVersion(campaignRules.economyRuleVersion, deployedValue),
  );
}

export function inventoryToDeployment(inventory: Readonly<ArmyInventory>): StackOrder[] {
  const front = new Set<EconomyUnitId>(['rifle', 'at_infantry', 'medium_tank', 'heavy_tank', 'engineer']);
  const mid = new Set<EconomyUnitId>(['scout', 'at_gun', 'aa_gun', 'supply_truck']);
  return ECONOMY_UNIT_IDS
    .filter((unitId) => inventory[unitId] > 0)
    .map((unitId) => ({
      unitId,
      count: inventory[unitId],
      row: front.has(unitId) ? 'front' : mid.has(unitId) ? 'mid' : 'back',
    }));
}

import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_RULESETS,
  CampaignError,
  ECONOMY_ARCHETYPES,
  ECONOMY_RULESETS,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
  RULESETS,
  advanceCampaignTime,
  armyValue,
  createCampaignState,
  executeNpcBattle,
  fnv1a64,
  inventoryToDeployment,
  queueRecovery,
  restoreCampaignState,
  serializeCampaignState,
  simulateSeason,
  stableStringify,
} from '../src/index.js';
import type {
  ArmyInventory,
  CampaignErrorCode,
  CampaignState,
  NpcBattleCommand,
  RecoveryCommand,
  ResourceBundle,
  SeasonReport,
} from '../src/index.js';

const RULE_VERSION = '0.1.0';
const SCENARIO_ID = 'fortified_roadblock';
const BATTLE_SEED = 1944;

const seasonCache = new Map<number, SeasonReport>();

function disabledSeason(days: number): SeasonReport {
  const cached = seasonCache.get(days);
  if (cached) return cached;
  const report = simulateSeason({
    ruleVersion: RULE_VERSION,
    archetype: ECONOMY_ARCHETYPES.two,
    days,
    sortieMode: 'disabled',
  });
  seasonCache.set(days, report);
  return report;
}

function initialState(days: number): CampaignState {
  return createCampaignState({ ruleVersion: RULE_VERSION, season: disabledSeason(days) });
}

function battleCommand(
  state: CampaignState,
  commandId: string,
  seed = BATTLE_SEED,
): NpcBattleCommand {
  return {
    commandId,
    expectedRevision: state.revision,
    scenarioId: SCENARIO_ID,
    seed,
    deployment: inventoryToDeployment(state.readyArmy),
    doctrine: 'none',
  };
}

function defeatedBattle(commandId = 'battle:defeat') {
  const initial = initialState(3);
  const transition = executeNpcBattle(initial, battleCommand(initial, commandId));
  expect(transition.record.result.outcome).toBe('defender_win');
  return { initial, transition };
}

function selectedWounded(): RecoveryCommand['units'] {
  return { at_infantry: 1, heavy_tank: 1 };
}

function expectCampaignCode(action: () => unknown, code: CampaignErrorCode): void {
  try {
    action();
    expect.unreachable(`${code} 오류가 발생해야 한다`);
  } catch (error) {
    expect(error).toBeInstanceOf(CampaignError);
    expect((error as CampaignError).code).toBe(code);
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recomputeStateHash(state: CampaignState): void {
  const { hash: _hash, ...payload } = state;
  (state as unknown as { hash: string }).hash = fnv1a64(stableStringify(payload));
}

function countByUnit(stacks: readonly { unitId: string; count: number }[]): ArmyInventory {
  const counts = Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, 0])) as ArmyInventory;
  for (const stack of stacks) counts[stack.unitId as keyof ArmyInventory] += stack.count;
  return counts;
}

function runRecoveryFlow() {
  const { transition: battle } = defeatedBattle('flow:battle:1');
  const recovery = queueRecovery(battle.state, {
    commandId: 'flow:recovery:1',
    expectedRevision: battle.state.revision,
    units: selectedWounded(),
  });
  const timeAdvance = advanceCampaignTime(recovery.state, {
    commandId: 'flow:time:1',
    expectedRevision: recovery.state.revision,
    targetHour: recovery.record.completeAtHour,
  });
  const recovered = timeAdvance.state;
  const secondBattle = executeNpcBattle(
    recovered,
    battleCommand(recovered, 'flow:battle:2', BATTLE_SEED + 1),
  );
  return { battle, recovery, timeAdvance, recovered, secondBattle };
}

describe('성장 체크포인트와 실제 NPC 전투 연결', () => {
  it('3일 성장 부대는 패배하고 7일 성장 부대는 같은 NPC·시드에 승리한다', () => {
    const day3 = initialState(3);
    const day7 = initialState(7);

    const early = executeNpcBattle(day3, battleCommand(day3, 'growth:day3'));
    const later = executeNpcBattle(day7, battleCommand(day7, 'growth:day7'));

    expect(early.record.seed).toBe(BATTLE_SEED);
    expect(later.record.seed).toBe(BATTLE_SEED);
    expect(early.record.scenarioId).toBe(SCENARIO_ID);
    expect(later.record.scenarioId).toBe(SCENARIO_ID);
    expect(early.record.result.outcome).toBe('defender_win');
    expect(later.record.result.outcome).toBe('attacker_win');
    expect(day3.originArmy).toEqual(disabledSeason(3).finalArmy);
    expect(day7.originArmy).toEqual(disabledSeason(7).finalArmy);
    expect(armyValue(day7, day7.readyArmy)).toBeGreaterThan(armyValue(day3, day3.readyArmy));
  });

  it('병종별 전투 손실을 보존하고 미투입 병력과 건물은 변경하지 않는다', () => {
    const initial = initialState(7);
    const deployment: NpcBattleCommand['deployment'] = [
      { unitId: 'rifle', count: 2, row: 'front' },
      { unitId: 'at_infantry', count: 2, row: 'front' },
      { unitId: 'medium_tank', count: 1, row: 'front' },
      { unitId: 'heavy_tank', count: 1, row: 'front' },
      { unitId: 'howitzer', count: 1, row: 'back' },
      { unitId: 'at_gun', count: 1, row: 'mid' },
    ];
    const transition = executeNpcBattle(initial, {
      ...battleCommand(initial, 'conservation:battle'),
      deployment,
    });
    const deployed = countByUnit(deployment);
    const survivors = Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, 0])) as ArmyInventory;
    const wounded = Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, 0])) as ArmyInventory;
    const dead = Object.fromEntries(ECONOMY_UNIT_IDS.map((unitId) => [unitId, 0])) as ArmyInventory;
    for (const stack of transition.record.result.attacker.stacks) {
      const unitId = stack.unitId as keyof ArmyInventory;
      survivors[unitId] += stack.survivors;
      wounded[unitId] += stack.wounded;
      dead[unitId] += stack.dead;
      expect(stack.initial).toBe(deployed[unitId]);
      expect(stack.survivors + stack.wounded + stack.dead).toBe(stack.initial);
    }

    for (const unitId of ECONOMY_UNIT_IDS) {
      expect(transition.state.readyArmy[unitId])
        .toBe(initial.readyArmy[unitId] - deployed[unitId] + survivors[unitId]);
      expect(transition.state.woundedArmy[unitId]).toBe(wounded[unitId]);
      expect(transition.state.deadArmy[unitId]).toBe(dead[unitId]);
      expect(
        transition.state.readyArmy[unitId]
          + transition.state.woundedArmy[unitId]
          + transition.state.recoveringArmy[unitId]
          + transition.state.deadArmy[unitId],
      ).toBe(initial.originArmy[unitId]);
    }
    expect(deployed.fighter).toBe(0);
    expect(transition.state.readyArmy.fighter).toBe(initial.readyArmy.fighter);
    expect(transition.state.buildings).toEqual(initial.buildings);
    expect(transition.state.originArmy).toEqual(initial.originArmy);
  });

  it('출정 비용과 승리 보상의 기록·원장·최종 잔액이 같은 거래를 가리킨다', () => {
    const initial = initialState(7);
    const transition = executeNpcBattle(initial, battleCommand(initial, 'ledger:victory'));
    const { record, state } = transition;
    const economyRules = ECONOMY_RULESETS[state.economyRuleVersion]!;

    expect(record.result.outcome).toBe('attacker_win');
    for (const resourceId of RESOURCE_IDS) {
      const expectedCost = Math.ceil(
        (economyRules.balance.sortieBaseCost[resourceId] ?? 0)
          + record.result.attacker.totalCost
            * (economyRules.balance.sortieCostPerArmyValue[resourceId] ?? 0),
      );
      if (expectedCost > 0) expect(record.sortieCost[resourceId]).toBe(expectedCost);

      let balance = initial.resources[resourceId];
      for (const entry of state.ledger.filter((candidate) => candidate.resourceId === resourceId)) {
        expect(entry.commandId).toBe(record.commandId);
        expect(entry.balanceBefore).toBe(balance);
        expect(entry.balanceAfter).toBeCloseTo(entry.balanceBefore + entry.delta, 8);
        balance = entry.balanceAfter;
      }
      expect(state.resources[resourceId]).toBe(balance);
    }

    for (const [resourceId, amount] of Object.entries(record.sortieCost)) {
      const entry = state.ledger.find(
        (candidate) => candidate.reason === 'sortie_cost' && candidate.resourceId === resourceId,
      );
      expect(entry?.delta).toBe(-(amount ?? 0));
    }
    for (const [resourceId, amount] of Object.entries(record.reward)) {
      const entry = state.ledger.find(
        (candidate) => candidate.reason === 'sortie_reward' && candidate.resourceId === resourceId,
      );
      expect(entry?.delta).toBe(amount);
    }
    expect(state.ledger.map((entry) => entry.reason)).toContain('sortie_cost');
    expect(state.ledger.map((entry) => entry.reason)).toContain('sortie_reward');
  });
});

describe('캠페인 명령 권위 경계', () => {
  it('같은 commandId와 payload 재시도는 상태를 재적용하지 않는다', () => {
    const initial = initialState(7);
    const command = battleCommand(initial, 'idempotency:battle');
    const applied = executeNpcBattle(initial, command);
    const before = {
      hash: applied.state.hash,
      revision: applied.state.revision,
      ledgerLength: applied.state.ledger.length,
      battleLength: applied.state.battleRecords.length,
      receiptLength: applied.state.receipts.length,
    };

    const retried = executeNpcBattle(applied.state, command);

    expect(retried.duplicate).toBe(true);
    expect(retried.state).toBe(applied.state);
    expect(retried.record).toBe(applied.record);
    expect(retried.state.hash).toBe(before.hash);
    expect(retried.state.revision).toBe(before.revision);
    expect(retried.state.ledger).toHaveLength(before.ledgerLength);
    expect(retried.state.battleRecords).toHaveLength(before.battleLength);
    expect(retried.state.receipts).toHaveLength(before.receiptLength);
  });

  it('commandId의 다른 payload 재사용과 stale revision을 구분해 거부한다', () => {
    const initial = initialState(7);
    const command = battleCommand(initial, 'idempotency:reused');
    const applied = executeNpcBattle(initial, command);

    expectCampaignCode(
      () => executeNpcBattle(applied.state, {
        ...command,
        expectedRevision: applied.state.revision,
        seed: command.seed + 1,
      }),
      'COMMAND_ID_REUSED',
    );
    expectCampaignCode(
      () => executeNpcBattle(applied.state, {
        ...battleCommand(applied.state, 'revision:stale'),
        expectedRevision: 0,
      }),
      'STALE_REVISION',
    );
  });

  it('보유량 초과 배치, 추상 출정 체크포인트, 규칙 불일치를 거부한다', () => {
    const state = initialState(7);
    const overDeployment = jsonClone(inventoryToDeployment(state.readyArmy));
    const first = overDeployment[0]!;
    overDeployment[0] = { ...first, count: first.count + 1 };
    expectCampaignCode(
      () => executeNpcBattle(state, {
        ...battleCommand(state, 'authority:over-deploy'),
        deployment: overDeployment,
      }),
      'INSUFFICIENT_UNITS',
    );

    const abstractSeason = simulateSeason({
      ruleVersion: RULE_VERSION,
      archetype: ECONOMY_ARCHETYPES.two,
      days: 3,
    });
    expectCampaignCode(
      () => createCampaignState({ ruleVersion: RULE_VERSION, season: abstractSeason }),
      'ABSTRACT_SORTIES_NOT_ALLOWED',
    );

    const incompatible = jsonClone(disabledSeason(3));
    (incompatible as unknown as { combatRuleVersion: string }).combatRuleVersion = '9.9.9';
    expectCampaignCode(
      () => createCampaignState({ ruleVersion: RULE_VERSION, season: incompatible }),
      'INCOMPATIBLE_RULE_VERSION',
    );
  });
});

describe('부상병 선택 회복과 시간 경계', () => {
  it('선택 병력 가치의 10%를 올림해 보급품으로 차감한다', () => {
    const { transition: battle } = defeatedBattle('recovery:cost:battle');
    const suppliesBefore = battle.state.resources.supplies;
    const transition = queueRecovery(battle.state, {
      commandId: 'recovery:cost',
      expectedRevision: battle.state.revision,
      units: selectedWounded(),
    });
    const combatRules = RULESETS[battle.state.combatRuleVersion]!;
    const selectedValue = combatRules.units.at_infantry!.cost + combatRules.units.heavy_tank!.cost;
    const expectedCost = Math.ceil(
      selectedValue * CAMPAIGN_RULESETS[RULE_VERSION]!.recoverySupplyCostRatio,
    );

    expect(selectedValue * 0.1).not.toBe(Number.parseInt(String(selectedValue * 0.1), 10));
    expect(transition.record.supplyCost).toBe(expectedCost);
    expect(transition.state.resources.supplies).toBe(suppliesBefore - expectedCost);
    expect(transition.record.units.at_infantry).toBe(1);
    expect(transition.record.units.heavy_tank).toBe(1);
    expect(transition.state.woundedArmy.at_infantry).toBe(battle.state.woundedArmy.at_infantry - 1);
    expect(transition.state.woundedArmy.heavy_tank).toBe(battle.state.woundedArmy.heavy_tank - 1);
    expect(transition.state.recoveringArmy.at_infantry).toBe(1);
    expect(transition.state.recoveringArmy.heavy_tank).toBe(1);
    expect(transition.state.ledger.at(-1)).toMatchObject({
      commandId: 'recovery:cost',
      resourceId: 'supplies',
      reason: 'recovery_cost',
      delta: -expectedCost,
      balanceBefore: suppliesBefore,
      balanceAfter: suppliesBefore - expectedCost,
    });
  });

  it('보급품 부족과 부상병 초과·0·소수·미지 병종 회복을 거부한다', () => {
    const base = initialState(3);
    const economyRules = ECONOMY_RULESETS[base.economyRuleVersion]!;
    const deployedValue = armyValue(base, base.readyArmy);
    const battleSupplyCost = Math.ceil(
      (economyRules.balance.sortieBaseCost.supplies ?? 0)
        + deployedValue * (economyRules.balance.sortieCostPerArmyValue.supplies ?? 0),
    );
    const lowSupplySeason = jsonClone(disabledSeason(3));
    (lowSupplySeason.finalResources as ResourceBundle).supplies = battleSupplyCost;
    const lowSupplyState = createCampaignState({ ruleVersion: RULE_VERSION, season: lowSupplySeason });
    const lowSupplyBattle = executeNpcBattle(
      lowSupplyState,
      battleCommand(lowSupplyState, 'recovery:poor:battle'),
    );
    expect(lowSupplyBattle.state.resources.supplies).toBe(0);
    expectCampaignCode(
      () => queueRecovery(lowSupplyBattle.state, {
        commandId: 'recovery:poor',
        expectedRevision: lowSupplyBattle.state.revision,
        units: selectedWounded(),
      }),
      'INSUFFICIENT_RESOURCES',
    );

    const { transition: battle } = defeatedBattle('recovery:invalid:battle');
    const invalidRequests: unknown[] = [
      { heavy_tank: battle.state.woundedArmy.heavy_tank + 1 },
      { heavy_tank: 0 },
      { heavy_tank: 1.5 },
      { battleship: 1 },
      {},
    ];
    for (const [index, units] of invalidRequests.entries()) {
      expectCampaignCode(
        () => queueRecovery(battle.state, {
          commandId: `recovery:invalid:${index}`,
          expectedRevision: battle.state.revision,
          units,
        } as unknown as RecoveryCommand),
        'INVALID_RECOVERY',
      );
    }
  });

  it('12시간 직전에는 미완료이고 경계에서 한 번만 완료된다', () => {
    const { transition: battle } = defeatedBattle('recovery:time:battle');
    const queued = queueRecovery(battle.state, {
      commandId: 'recovery:time',
      expectedRevision: battle.state.revision,
      units: selectedWounded(),
    });
    expect(queued.record.completeAtHour - queued.record.startedAtHour).toBe(12);

    const beforeCommand = {
      commandId: 'time:before-boundary',
      expectedRevision: queued.state.revision,
      targetHour: queued.record.completeAtHour - 1,
    } as const;
    const justBeforeTransition = advanceCampaignTime(queued.state, beforeCommand);
    const justBefore = justBeforeTransition.state;
    expect(justBefore.recoveryOrders[0]?.status).toBe('pending');
    expect(justBefore.readyArmy.heavy_tank).toBe(queued.state.readyArmy.heavy_tank);
    expect(justBefore.recoveringArmy.heavy_tank).toBe(1);

    const boundaryCommand = {
      commandId: 'time:boundary',
      expectedRevision: justBefore.revision,
      targetHour: queued.record.completeAtHour,
    } as const;
    const completedTransition = advanceCampaignTime(justBefore, boundaryCommand);
    const completed = completedTransition.state;
    expect(completed.recoveryOrders[0]).toMatchObject({
      status: 'completed',
      completedAtHour: queued.record.completeAtHour,
    });
    expect(completed.recoveringArmy.heavy_tank).toBe(0);
    expect(completed.readyArmy.heavy_tank).toBe(queued.state.readyArmy.heavy_tank + 1);

    const sameCommandRetry = advanceCampaignTime(completed, boundaryCommand);
    expect(sameCommandRetry.duplicate).toBe(true);
    expect(sameCommandRetry.state).toBe(completed);
    expect(sameCommandRetry.record).toBe(completedTransition.record);
    expect(sameCommandRetry.state.revision).toBe(completed.revision);
    expect(sameCommandRetry.state.timeAdvanceRecords).toHaveLength(2);
    expect(sameCommandRetry.state.receipts).toHaveLength(completed.receipts.length);

    expectCampaignCode(
      () => advanceCampaignTime(completed, {
        commandId: boundaryCommand.commandId,
        expectedRevision: completed.revision,
        targetHour: completed.nowHour + 1,
      }),
      'COMMAND_ID_REUSED',
    );
    expectCampaignCode(
      () => advanceCampaignTime(completed, {
        commandId: 'time:stale',
        expectedRevision: completed.revision - 1,
        targetHour: completed.nowHour + 1,
      }),
      'STALE_REVISION',
    );

    const later = advanceCampaignTime(completed, {
      commandId: 'time:later',
      expectedRevision: completed.revision,
      targetHour: completed.nowHour + 1,
    }).state;
    expect(later.readyArmy).toEqual(completed.readyArmy);
    expect(later.recoveringArmy).toEqual(completed.recoveringArmy);
    expect(later.recoveryOrders[0]?.completedAtHour).toBe(queued.record.completeAtHour);
  });
});

describe('상태 복원과 전체 흐름 결정론', () => {
  it('직렬화·복원은 상태 해시를 보존하고 해시를 갱신하지 않은 변조를 거부한다', () => {
    const { recovered } = runRecoveryFlow();
    const serialized = serializeCampaignState(recovered);
    const restored = restoreCampaignState(serialized);

    expect(restored).toEqual(recovered);
    expect(restored.hash).toBe(recovered.hash);
    expect(serializeCampaignState(restored)).toBe(serialized);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.resources)).toBe(true);

    const tampered = jsonClone(JSON.parse(serialized) as CampaignState);
    (tampered.resources as ResourceBundle).food += 1;
    expectCampaignCode(() => restoreCampaignState(JSON.stringify(tampered)), 'STATE_HASH_MISMATCH');
  });

  it('상위 해시를 다시 계산해도 회복 비용·출정 비용·receipt revision 의미 변조를 거부한다', () => {
    const { recovered } = runRecoveryFlow();
    const semanticTamperers: Array<(state: CampaignState) => void> = [
      (state) => {
        const mutable = state as unknown as { recoveryOrders: Array<{ supplyCost: number }> };
        mutable.recoveryOrders[0]!.supplyCost += 1;
      },
      (state) => {
        const mutable = state as unknown as {
          battleRecords: Array<{ sortieCost: { supplies?: number } }>;
        };
        const sortieCost = mutable.battleRecords[0]!.sortieCost;
        sortieCost.supplies = (sortieCost.supplies ?? 0) + 1;
      },
      (state) => {
        const mutable = state as unknown as { receipts: Array<{ appliedRevision: number }> };
        mutable.receipts[0]!.appliedRevision += 1;
      },
    ];

    for (const tamper of semanticTamperers) {
      const tampered = jsonClone(recovered);
      tamper(tampered);
      recomputeStateHash(tampered);
      expectCampaignCode(
        () => restoreCampaignState(stableStringify(tampered)),
        'INVALID_STATE',
      );
    }
  });

  it('회복 완료 병력을 포함해 두 번째 출정을 합법적으로 처리한다', () => {
    const { recovery, recovered, secondBattle } = runRecoveryFlow();

    expect(recovered.readyArmy.at_infantry)
      .toBe(recovery.state.readyArmy.at_infantry + recovery.record.units.at_infantry);
    expect(recovered.readyArmy.heavy_tank)
      .toBe(recovery.state.readyArmy.heavy_tank + recovery.record.units.heavy_tank);
    expect(secondBattle.duplicate).toBe(false);
    expect(secondBattle.record.commandId).toBe('flow:battle:2');
    expect(secondBattle.state.battleRecords).toHaveLength(2);
    expect(secondBattle.state.receipts.map((receipt) => receipt.commandId)).toEqual([
      'flow:battle:1',
      'flow:recovery:1',
      'flow:time:1',
      'flow:battle:2',
    ]);
  });

  it('성장→패배→회복→재출정 전체 상태 해시가 100회 동일하다', () => {
    const baseline = runRecoveryFlow().secondBattle.state;
    for (let index = 0; index < 100; index += 1) {
      const repeated = runRecoveryFlow().secondBattle.state;
      expect(repeated.hash).toBe(baseline.hash);
      expect(serializeCampaignState(repeated)).toBe(serializeCampaignState(baseline));
    }
  });
});

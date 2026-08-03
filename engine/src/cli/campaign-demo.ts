/**
 * 도시 성장 -> NPC 전투 -> 직렬화/복원 -> 부상 회복 -> 재출정 결합 데모.
 * 실행: npm run demo:campaign
 */
import {
  ECONOMY_ARCHETYPES,
  ECONOMY_UNIT_IDS,
  advanceCampaignTime,
  armyValue,
  createCampaignState,
  executeNpcBattle,
  inventoryToDeployment,
  queueRecovery,
  restoreCampaignState,
  serializeCampaignState,
  simulateSeason,
  type ArmyInventory,
  type CampaignBattleRecord,
  type CampaignState,
  type PartialBundle,
} from '../index.js';

const RULE_VERSION = '0.1.0';
const SCENARIO_ID = 'fortified_roadblock';
const FIRST_SEED = 1944;
const RETRY_SEED = 1945;

const OUTCOME_KO: Record<CampaignBattleRecord['result']['outcome'], string> = {
  attacker_win: '공격 측 승리',
  defender_win: '방어 측 승리',
  draw: '무승부',
};

const REASON_KO: Record<CampaignBattleRecord['result']['reason'], string> = {
  annihilation: '섬멸',
  retreat: '철수',
  mutual_retreat: '상호 철수',
  timeout: '교착',
};

function bundleText(bundle: Readonly<PartialBundle>): string {
  const entries = Object.entries(bundle).filter(([, amount]) => amount !== undefined && amount > 0);
  return entries.length > 0
    ? entries.map(([resourceId, amount]) => `${resourceId} ${amount}`).join(', ')
    : '없음';
}

function nonZeroInventory(inventory: Readonly<ArmyInventory>): Partial<ArmyInventory> {
  return Object.fromEntries(
    ECONOMY_UNIT_IDS
      .filter((unitId) => inventory[unitId] > 0)
      .map((unitId) => [unitId, inventory[unitId]]),
  ) as Partial<ArmyInventory>;
}

function checkpoint(days: number): CampaignState {
  const season = simulateSeason({
    ruleVersion: RULE_VERSION,
    archetype: ECONOMY_ARCHETYPES.two,
    days,
    sortieMode: 'disabled',
  });
  return createCampaignState({ ruleVersion: RULE_VERSION, season });
}

function firstSortie(state: CampaignState, commandId: string) {
  return executeNpcBattle(state, {
    commandId,
    expectedRevision: state.revision,
    scenarioId: SCENARIO_ID,
    seed: FIRST_SEED,
    deployment: inventoryToDeployment(state.readyArmy),
    doctrine: 'artillery_support',
  });
}

const day3Checkpoint = checkpoint(3);
const day7Checkpoint = checkpoint(7);
const day3Battle = firstSortie(day3Checkpoint, 'demo:day3:first');
const day7Battle = firstSortie(day7Checkpoint, 'demo:day7:first');

console.log('\nVictory 1944 캠페인 결합 PoC v0.1.0\n');
console.log('하루 2회 접속, 추상 출정 비활성화, 동일 NPC·시드·교리·배치 원칙');
console.log(`시나리오: ${SCENARIO_ID} | 시드: ${FIRST_SEED} | 교리: artillery_support`);
console.log('배치 원칙: 보병·전차·공병 전열, 정찰·대전차포·대공포·수송대 중열, 포병·항공 후열\n');

console.table([
  {
    체크포인트: '3일',
    초기_병력가치: armyValue(day3Checkpoint, day3Checkpoint.readyArmy),
    결과: OUTCOME_KO[day3Battle.record.result.outcome],
    종료_사유: REASON_KO[day3Battle.record.result.reason],
    출정_비용: bundleText(day3Battle.record.sortieCost),
    보상: bundleText(day3Battle.record.reward),
    전투_해시: day3Battle.record.result.hash,
    상태_해시: day3Battle.state.hash,
  },
  {
    체크포인트: '7일',
    초기_병력가치: armyValue(day7Checkpoint, day7Checkpoint.readyArmy),
    결과: OUTCOME_KO[day7Battle.record.result.outcome],
    종료_사유: REASON_KO[day7Battle.record.result.reason],
    출정_비용: bundleText(day7Battle.record.sortieCost),
    보상: bundleText(day7Battle.record.reward),
    전투_해시: day7Battle.record.result.hash,
    상태_해시: day7Battle.state.hash,
  },
]);

const serializedDefeat = serializeCampaignState(day3Battle.state);
const restoredDefeat = restoreCampaignState(serializedDefeat);
const recovery = queueRecovery(restoredDefeat, {
  commandId: 'demo:day3:recover-all',
  expectedRevision: restoredDefeat.revision,
  units: nonZeroInventory(restoredDefeat.woundedArmy),
});
const recoveryTime = advanceCampaignTime(recovery.state, {
  commandId: 'demo:day3:advance-recovery',
  expectedRevision: recovery.state.revision,
  targetHour: recovery.record.completeAtHour,
});
const recovered = recoveryTime.state;
const completedRecovery = recovered.recoveryOrders.find(
  (order) => order.commandId === recovery.record.commandId,
);

const forceValues = {
  initial: armyValue(restoredDefeat, restoredDefeat.originArmy),
  survivors: armyValue(restoredDefeat, restoredDefeat.readyArmy),
  wounded: armyValue(restoredDefeat, restoredDefeat.woundedArmy),
  dead: armyValue(restoredDefeat, restoredDefeat.deadArmy),
  afterRecovery: armyValue(recovered, recovered.readyArmy),
};

const retry = executeNpcBattle(recovered, {
  commandId: 'demo:day3:retry',
  expectedRevision: recovered.revision,
  scenarioId: SCENARIO_ID,
  seed: RETRY_SEED,
  deployment: inventoryToDeployment(recovered.readyArmy),
  doctrine: 'artillery_support',
});

console.log('\n3일 패배 후 재접속·회복 경로');
console.table([{
  초기: forceValues.initial,
  생존: forceValues.survivors,
  부상: forceValues.wounded,
  전사: forceValues.dead,
  회복후: forceValues.afterRecovery,
  회복_비용: `supplies ${recovery.record.supplyCost}`,
  회복_시작: `${recovery.record.startedAtHour}h`,
  완료_경계: `${recovery.record.completeAtHour}h`,
}]);
console.log(`직렬화 전 상태 해시: ${day3Battle.state.hash}`);
console.log(`복원 후 상태 해시:   ${restoredDefeat.hash}`);
console.log(`12시간 경계 상태 해시: ${recovered.hash}`);
console.log(`시간 진행 명령 ID/중복 방지 영수증: ${recoveryTime.record.commandId} / ${recovered.receipts.some((receipt) => receipt.commandId === recoveryTime.record.commandId) ? '기록됨' : '누락'}`);
console.log(`두 번째 출정: 시드 ${RETRY_SEED}, ${OUTCOME_KO[retry.record.result.outcome]} (${REASON_KO[retry.record.result.reason]})`);
console.log(`두 번째 출정 비용: ${bundleText(retry.record.sortieCost)} | 보상: ${bundleText(retry.record.reward)}`);
console.log(`두 번째 전투 해시: ${retry.record.result.hash} | 최종 상태 해시: ${retry.state.hash}`);

const checks = [
  ['3일 체크포인트 패배', day3Battle.record.result.outcome === 'defender_win'],
  ['7일 체크포인트 승리', day7Battle.record.result.outcome === 'attacker_win'],
  ['패배 상태 해시 보존 복원', restoredDefeat.hash === day3Battle.state.hash
    && serializeCampaignState(restoredDefeat) === serializedDefeat],
  ['부상병 전원 회복 예약', forceValues.wounded > 0
    && armyValue(recovery.state, recovery.state.woundedArmy) === 0],
  ['12시간 완료 경계', recovery.record.completeAtHour - recovery.record.startedAtHour === 12
    && completedRecovery?.status === 'completed'
    && completedRecovery.completedAtHour === recovery.record.completeAtHour
    && recoveryTime.record.completedRecoveryIds.includes(recovery.record.commandId)
    && recoveryTime.duplicate === false
    && recovered.receipts.some((receipt) => receipt.commandId === recoveryTime.record.commandId)],
  ['병력 가치 보존', forceValues.initial
    === forceValues.survivors + forceValues.wounded + forceValues.dead
    && forceValues.afterRecovery === forceValues.initial - forceValues.dead],
  ['두 번째 합법 출정', retry.record.seed === RETRY_SEED
    && retry.state.battleRecords.length === 2
    && retry.duplicate === false],
] as const;
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);

console.log(`\n고정 fixture 검증: ${failed.length === 0 ? '통과' : `실패 (${failed.join(', ')})`}`);
console.log('한계: 이 데모는 사용자 재접속 의향 또는 로드맵 전체 통과 증거가 아닙니다.\n');
if (failed.length > 0) process.exitCode = 1;

import type {
  ArmySnapshot,
  BattleResult,
  DoctrineId,
  StackOrder,
} from '../types.js';
import type {
  BuildingId,
  EconomyUnitId,
  PartialBundle,
  ResourceBundle,
  ResourceId,
  SeasonReport,
} from '../economy/types.js';

export type ArmyInventory = Record<EconomyUnitId, number>;

export interface CampaignBattleDefaults {
  readonly supply: number;
  readonly reconAccuracy: number;
  readonly retreatThreshold: number;
}

export interface NpcScenario {
  readonly id: string;
  readonly nameKo: string;
  readonly defender: ArmySnapshot;
  readonly victoryReward: Readonly<PartialBundle>;
  /**
   * 아래 세 값은 화면 표시와 진행 순서를 위한 것이며 전투 판정에 쓰이지 않는다.
   * 0.2.0 이전 규칙에는 없으므로 선택 항목이다.
   */
  readonly briefKo?: string;
  /** 표시 순서. 작을수록 먼저 보인다. 없으면 id 순으로 놓는다. */
  readonly tier?: number;
  /** 이 시나리오를 이겨야 해금된다. 같은 규칙집합 안의 id여야 한다. */
  readonly unlockAfter?: string;
}

export interface CampaignRuleset {
  readonly version: string;
  readonly economyRuleVersion: string;
  readonly combatRuleVersion: string;
  readonly attackerDefaults: CampaignBattleDefaults;
  readonly recoveryHours: number;
  readonly recoverySupplyCostRatio: number;
  readonly scenarios: Readonly<Record<string, NpcScenario>>;
}

export type CampaignLedgerReason = 'sortie_cost' | 'sortie_reward' | 'recovery_cost';

export interface CampaignLedgerEntry {
  readonly id: string;
  readonly hour: number;
  readonly commandId: string;
  readonly resourceId: ResourceId;
  readonly reason: CampaignLedgerReason;
  readonly delta: number;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
}

export interface CampaignCommandReceipt {
  readonly commandId: string;
  readonly kind: 'npc_battle' | 'recovery' | 'advance_time';
  /** 충돌 가능한 짧은 해시가 아니라 정규화된 payload 자체로 중복 요청을 결속한다. */
  readonly payload: string;
  readonly payloadHash: string;
  readonly previousRevision: number;
  readonly appliedRevision: number;
}

export interface CampaignBattleRecord {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly startedAtHour: number;
  readonly deployment: readonly StackOrder[];
  readonly doctrine: DoctrineId;
  readonly sortieCost: Readonly<PartialBundle>;
  readonly reward: Readonly<PartialBundle>;
  readonly result: BattleResult;
}

export interface RecoveryOrder {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly units: Readonly<ArmyInventory>;
  readonly supplyCost: number;
  readonly startedAtHour: number;
  readonly completeAtHour: number;
  readonly status: 'pending' | 'completed';
  readonly completedAtHour?: number;
}

export interface TimeAdvanceRecord {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly fromHour: number;
  readonly toHour: number;
  readonly completedRecoveryIds: readonly string[];
}

export interface CampaignState {
  readonly ruleVersion: string;
  readonly economyRuleVersion: string;
  readonly combatRuleVersion: string;
  readonly originHour: number;
  readonly nowHour: number;
  readonly revision: number;
  readonly originArmy: Readonly<ArmyInventory>;
  readonly readyArmy: Readonly<ArmyInventory>;
  readonly woundedArmy: Readonly<ArmyInventory>;
  readonly recoveringArmy: Readonly<ArmyInventory>;
  readonly deadArmy: Readonly<ArmyInventory>;
  readonly originResources: Readonly<ResourceBundle>;
  readonly resources: Readonly<ResourceBundle>;
  readonly buildings: Readonly<Record<BuildingId, number>>;
  readonly ledger: readonly CampaignLedgerEntry[];
  readonly battleRecords: readonly CampaignBattleRecord[];
  readonly recoveryOrders: readonly RecoveryOrder[];
  readonly timeAdvanceRecords: readonly TimeAdvanceRecord[];
  readonly receipts: readonly CampaignCommandReceipt[];
  /** 재현·우발 손상 검출용 FNV-1a 해시이며 보안 서명은 아니다. */
  readonly hash: string;
}

export interface NpcBattleCommand {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly scenarioId: string;
  readonly seed: number;
  readonly deployment: readonly StackOrder[];
  readonly doctrine: DoctrineId;
}

export interface RecoveryCommand {
  readonly commandId: string;
  readonly expectedRevision: number;
  /** 0인 항목은 생략한다. 서버는 요청한 병종만 부분 회복 대기열에 넣는다. */
  readonly units: Readonly<Partial<ArmyInventory>>;
}

export interface AdvanceTimeCommand {
  readonly commandId: string;
  readonly expectedRevision: number;
  /** 실제 서버 어댑터에서는 클라이언트 시간이 아니라 권위 서버 시간이 이 값을 제공해야 한다. */
  readonly targetHour: number;
}

export interface CampaignTransition<TRecord> {
  readonly state: CampaignState;
  readonly record: TRecord;
  readonly duplicate: boolean;
}

export interface CampaignCheckpointInput {
  readonly ruleVersion: string;
  readonly season: SeasonReport;
}

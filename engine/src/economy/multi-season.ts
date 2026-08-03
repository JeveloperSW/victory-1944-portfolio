import { ECONOMY_RULESETS } from './rules/index.js';
import { simulateSeason } from './simulate.js';
import { BUILDING_IDS, ECONOMY_UNIT_IDS, buildingDef, cityBuildingIds } from './types.js';
import type {
  ArchetypeInput,
  BuildingId,
  EconomyUnitId,
  SeasonCarryOver,
  SeasonReport,
  SortieMode,
} from './types.js';

/**
 * 다중 시즌 비교(D-027 승인 조건 1).
 *
 * 세 가지 초기화 모델을 같은 아키타입·규칙으로 연속 시즌 실행하고,
 * "시즌 N을 처음 시작하는 신규"와 "시즌 1부터 누적한 기존"의 군사 가치 비를 측정한다.
 *
 * 이 모듈은 어떤 정책도 확정하지 않는다. D-001과 D-027 중 무엇을 채택할지 판단할
 * 근거 수치를 만들 뿐이며, 경제 축만 다루므로 실제 승률·영토 점유율이 아니다.
 */

export type ResetModel = 'full_reset' | 'hybrid' | 'army_persist' | 'fully_persistent';

export const RESET_MODEL_LABELS: Readonly<Record<ResetModel, string>> = {
  full_reset: '전체 초기화 (D-001 현행)',
  hybrid: '혼합형 (D-027 제안: 도시 유지, 시즌 전력 초기화)',
  army_persist: '자원·영토만 초기화 (도시·병력 유지)',
  fully_persistent: '완전 영구형 (모두 유지)',
};

/**
 * 모델별 인계 규칙.
 * - full_reset: 아무것도 넘기지 않는다.
 * - hybrid: 건물만 넘긴다. 원정군·자원은 시즌 전력이므로 초기화한다.
 * - army_persist: 건물과 병력을 넘기고 자원만 초기화한다(자원·영토만 초기화 안).
 * - fully_persistent: 건물·병력·자원을 모두 넘긴다.
 */
export function carryOverFor(model: ResetModel, previous: SeasonReport | null): SeasonCarryOver | undefined {
  if (previous === null) return undefined;
  if (model === 'full_reset') return undefined;

  const buildings: Partial<Record<BuildingId, number>> = {};
  for (const buildingId of BUILDING_IDS) {
    const level = previous.finalBuildings[buildingId];
    if (level !== undefined) buildings[buildingId] = level;
  }
  if (model === 'hybrid') return { buildings };

  const army: Partial<Record<EconomyUnitId, number>> = {};
  for (const unitId of ECONOMY_UNIT_IDS) {
    army[unitId] = previous.finalArmy[unitId];
  }
  if (model === 'army_persist') return { buildings, army };
  return { buildings, army, resources: { ...previous.finalResources } };
}

export interface MultiSeasonInput {
  readonly ruleVersion: string;
  readonly archetype: ArchetypeInput;
  readonly seasons: number;
  readonly days: number;
  readonly sortieMode?: SortieMode;
}

export interface SeasonOutcome {
  readonly season: number;
  /** 시즌 종료 시점 군사 가치 */
  readonly armyValue: number;
  /** 시즌 종료 시점 건물 레벨 합 */
  readonly buildingLevels: number;
  /** 사령부 레벨(콘텐츠 개방 기준의 대리 지표) */
  readonly hqLevel: number;
}

export interface ModelComparison {
  readonly model: ResetModel;
  readonly seasons: readonly SeasonOutcome[];
  /**
   * 마지막 시즌에서 기존(누적) 대비 신규(그 시즌 첫 시작) 군사 가치 비.
   * 1에 가까울수록 신규가 불리하지 않다. 0에 가까울수록 격차가 크다.
   */
  readonly newcomerRatio: number;
  readonly veteranFinalArmyValue: number;
  readonly newcomerFinalArmyValue: number;
}

/** 한 모델로 연속 시즌을 실행한다. 각 시즌 보고서를 순서대로 돌려준다. */
export function runSeasonChain(input: MultiSeasonInput, model: ResetModel): SeasonReport[] {
  if (!Number.isInteger(input.seasons) || input.seasons < 1 || input.seasons > 20) {
    throw new RangeError('seasons는 1..20 정수여야 합니다.');
  }
  const reports: SeasonReport[] = [];
  let previous: SeasonReport | null = null;
  for (let season = 1; season <= input.seasons; season += 1) {
    const carryOver = carryOverFor(model, previous);
    const report = simulateSeason({
      ruleVersion: input.ruleVersion,
      archetype: input.archetype,
      days: input.days,
      ...(input.sortieMode === undefined ? {} : { sortieMode: input.sortieMode }),
      ...(carryOver === undefined ? {} : { carryOver }),
    });
    reports.push(report);
    previous = report;
  }
  return reports;
}

function outcomeOf(report: SeasonReport, season: number): SeasonOutcome {
  let buildingLevels = 0;
  for (const buildingId of BUILDING_IDS) buildingLevels += report.finalBuildings[buildingId] ?? 0;
  return {
    season,
    armyValue: report.armyValue,
    buildingLevels,
    hqLevel: report.finalBuildings.hq,
  };
}

/**
 * 한 모델을 비교한다.
 * 기존 = 시즌 1부터 연속 플레이한 계정의 마지막 시즌 결과.
 * 신규 = 마지막 시즌에 처음 시작한 계정(인계 없음)의 결과.
 */
export function compareModel(input: MultiSeasonInput, model: ResetModel): ModelComparison {
  const chain = runSeasonChain(input, model);
  const veteran = chain[chain.length - 1]!;
  // 신규는 어떤 모델에서도 인계가 없다 — 첫 시즌을 처음 뛰는 것과 같다.
  const newcomer = chain[0]!;
  const veteranValue = veteran.armyValue;
  const newcomerValue = newcomer.armyValue;
  return {
    model,
    seasons: chain.map((report, index) => outcomeOf(report, index + 1)),
    newcomerRatio: veteranValue === 0 ? 1 : newcomerValue / veteranValue,
    veteranFinalArmyValue: veteranValue,
    newcomerFinalArmyValue: newcomerValue,
  };
}

export function compareAllModels(input: MultiSeasonInput): ModelComparison[] {
  return (['full_reset', 'hybrid', 'army_persist', 'fully_persistent'] as const)
    .map((model) => compareModel(input, model));
}

/**
 * 상한 도달까지 걸린 시즌 수 — 영구 도시(D-027) 방향에서 곡선 깊이를 재는 지표.
 * 혼합형 인계(건물만 계승)로 연속 시즌을 돌려 모든 건물이 최대 레벨에 도달한 시즌을 찾는다.
 * 주어진 시즌 수 안에 도달하지 못하면 null이며, 그만큼 곡선이 깊다는 뜻이다.
 */
export function seasonsToBuildingCap(
  input: MultiSeasonInput,
  model: ResetModel = 'hybrid',
): { readonly season: number | null; readonly finalLevels: number; readonly maxLevels: number } {
  const rules = ECONOMY_RULESETS[input.ruleVersion];
  if (!rules) throw new Error(`알 수 없는 경제 규칙 버전: ${input.ruleVersion}`);
  const maxLevels = cityBuildingIds(rules)
    .reduce((sum, id) => sum + buildingDef(rules, id).maxLevel, 0);
  const chain = runSeasonChain(input, model);
  let finalLevels = 0;
  let reached: number | null = null;
  chain.forEach((report, index) => {
    const total = cityBuildingIds(rules)
      .reduce((sum, id) => sum + (report.finalBuildings[id] ?? 0), 0);
    finalLevels = total;
    if (reached === null && total >= maxLevels) reached = index + 1;
  });
  return { season: reached, finalLevels, maxLevels };
}

/**
 * 도시 상한 도달일 — "42일 시즌이 성장 곡선에 맞는가"를 판단하는 근거.
 * 모든 건물이 최대 레벨에 도달한 첫 날을 돌려주고, 도달하지 못하면 null이다.
 */
export function daysToBuildingCap(report: SeasonReport, ruleVersion: string): number | null {
  const rules = ECONOMY_RULESETS[ruleVersion];
  if (!rules) throw new Error(`알 수 없는 경제 규칙 버전: ${ruleVersion}`);
  const maxTotal = cityBuildingIds(rules)
    .reduce((sum, id) => sum + buildingDef(rules, id).maxLevel, 0);
  const ids = cityBuildingIds(rules);
  const levels = {} as Record<BuildingId, number>;
  for (const id of ids) levels[id] = rules.balance.startingBuildings[id] ?? 1;
  for (const event of [...report.constructions].sort((a, b) => a.completeAtHour - b.completeAtHour)) {
    levels[event.buildingId] = event.targetLevel;
    const total = ids.reduce((sum, id) => sum + levels[id], 0);
    if (total >= maxTotal) return Math.floor(event.completeAtHour / 24) + 1;
  }
  return null;
}

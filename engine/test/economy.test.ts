import { describe, expect, it } from 'vitest';
import {
  ECONOMY_ARCHETYPES,
  ECONOMY_RULESETS,
  EconomyError,
  RULESETS,
  simulateSeason,
  validateSeasonInput,
} from '../src/index.js';
import {
  BUILDING_IDS,
  ECONOMY_UNIT_IDS,
  RESOURCE_IDS,
  buildingDef,
  cityBuildingIds,
} from '../src/economy/types.js';
import { settleMicroDelta } from '../src/economy/ledger.js';
import type {
  ArchetypeInput,
  BuildingId,
  EconomyErrorCode,
  EconomyLedgerEntry,
  EconomyUnitId,
  ResourceId,
  SeasonInput,
  SeasonReport,
} from '../src/index.js';

const RULE_VERSION = '0.1.0';
const SCALE = 1000;

type ArchetypeKey = keyof typeof ECONOMY_ARCHETYPES;

function inputFor(
  archetype: ArchetypeInput = ECONOMY_ARCHETYPES.two,
  days = 42,
): SeasonInput {
  return { ruleVersion: RULE_VERSION, archetype, days };
}

function expectCode(input: unknown, code: EconomyErrorCode): void {
  try {
    simulateSeason(input as SeasonInput);
    expect.unreachable(`${code} 오류가 발생해야 한다`);
  } catch (error) {
    expect(error).toBeInstanceOf(EconomyError);
    expect((error as EconomyError).code).toBe(code);
  }
}

function asMicro(value: number): number {
  return Math.round(value * SCALE);
}

function expectMicroEqual(actual: number, expected: number): void {
  expect(asMicro(actual)).toBe(asMicro(expected));
}

const reportCache = new Map<ArchetypeKey, SeasonReport>();

function fullSeason(key: ArchetypeKey): SeasonReport {
  const cached = reportCache.get(key);
  if (cached) return cached;
  const report = simulateSeason(inputFor(ECONOMY_ARCHETYPES[key]));
  reportCache.set(key, report);
  return report;
}

interface ConstructionAction {
  causeId: string;
  buildingId: BuildingId;
  targetLevel: number;
  startHour: number;
  completeAtHour: number;
  entries: EconomyLedgerEntry[];
}

function constructionActions(report: SeasonReport): ConstructionAction[] {
  const rules = ECONOMY_RULESETS[RULE_VERSION]!;
  const grouped = new Map<string, EconomyLedgerEntry[]>();
  for (const entry of report.daily.flatMap((day) => day.entries)) {
    if (entry.reason !== 'construction') continue;
    const entries = grouped.get(entry.causeId) ?? [];
    entries.push(entry);
    grouped.set(entry.causeId, entries);
  }

  return [...grouped.entries()].map(([causeId, entries]) => {
    const match = /:construction:([^:]+):(\d+)$/.exec(causeId);
    if (!match) throw new Error(`건설 원인 ID 형식이 잘못됐다: ${causeId}`);
    const buildingId = match[1] as BuildingId;
    const targetLevel = Number(match[2]);
    const first = entries[0];
    if (!first) throw new Error(`건설 원장 엔트리가 비어 있다: ${causeId}`);
    const definition = buildingDef(rules, buildingId);
    const duration = Math.max(
      1,
      Math.ceil(definition.baseHours * definition.hourGrowth ** (targetLevel - 2)),
    );
    return {
      causeId,
      buildingId,
      targetLevel,
      startHour: first.hour,
      completeAtHour: first.hour + duration,
      entries,
    };
  }).sort((left, right) => left.startHour - right.startHour
    || BUILDING_IDS.indexOf(left.buildingId) - BUILDING_IDS.indexOf(right.buildingId));
}

describe('경제 시즌 정상 경로', () => {
  it('세 접속 코호트가 42일을 완주하고 공개 보고서가 자기 일관적이다', () => {
    for (const key of ['four', 'two', 'one'] as const) {
      const archetype = ECONOMY_ARCHETYPES[key];
      const report = fullSeason(key);

      expect(report.ruleVersion).toBe(RULE_VERSION);
      expect(report.combatRuleVersion).toBe(ECONOMY_RULESETS[RULE_VERSION]!.combatRuleVersion);
      expect(report.sortieMode).toBe('abstract');
      expect(report.archetypeId).toBe(archetype.id);
      expect(report.days).toBe(42);
      expect(report.sessionsPerDay).toBe(archetype.sessionsPerDay);
      expect(report.totalSessions).toBe(42 * archetype.sessionsPerDay);
      expect(report.daily).toHaveLength(42);
      expect(report.armyValue).toBeGreaterThan(0);
      expect(report.trainedUnits).toBeGreaterThan(0);
      expect(report.researchCount).toBeGreaterThan(0);
      expect(report.sortieCount).toBeGreaterThan(0);
      expect(report.starvationHours).toBe(0);
      expect(report.unmetUpkeepFood).toBe(0);

      const armyCount = ECONOMY_UNIT_IDS.reduce(
        (sum, unitId) => sum + report.finalArmy[unitId],
        0,
      );
      expect(armyCount).toBe(report.trainedUnits);

      for (const resourceId of RESOURCE_IDS) {
        expect(Number.isFinite(report.finalResources[resourceId])).toBe(true);
        expect(report.finalResources[resourceId]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('허용된 최대 경계 입력도 정상 검증된다', () => {
    const archetype: ArchetypeInput = {
      id: 'boundary',
      nameKo: '경계 입력',
      sessionsPerDay: 6,
      trainRatio: Object.fromEntries(
        ECONOMY_UNIT_IDS.slice(0, 10).map((unitId) => [unitId, 100]),
      ) as Partial<Record<EconomyUnitId, number>>,
    };
    expect(() => validateSeasonInput(inputFor(archetype, 42))).not.toThrow();
  });

  it('기본 출정 모드는 기존 추상 출정과 호환되고 disabled는 출정 거래를 만들지 않는다', () => {
    const base = inputFor(ECONOMY_ARCHETYPES.two, 3);
    const implicit = simulateSeason(base);
    const explicit = simulateSeason({ ...base, sortieMode: 'abstract' });
    const disabled = simulateSeason({ ...base, sortieMode: 'disabled' });

    expect(implicit).toEqual(explicit);
    expect(implicit.sortieMode).toBe('abstract');
    expect(implicit.sortieCount).toBeGreaterThan(0);
    expect(disabled.sortieMode).toBe('disabled');
    expect(disabled.sortieCount).toBe(0);
    expect(disabled.daily.flatMap((day) => day.entries).some(
      (entry) => entry.reason === 'sortie_cost' || entry.reason === 'sortie_reward',
    )).toBe(false);
    expect(disabled.researchCount).toBeGreaterThan(0);
    expect(disabled.trainedUnits).toBeGreaterThan(0);
  });
});

describe('경제 입력 거부 경로', () => {
  const valid = inputFor(ECONOMY_ARCHETYPES.two, 1);

  it('객체가 아닌 입력과 지원하지 않는 규칙 버전을 코드화해 거부한다', () => {
    for (const malformed of [null, [], '0.1.0', 1]) {
      expectCode(malformed, 'INVALID_INPUT');
    }
    for (const ruleVersion of ['9.9.9', 'toString', 'constructor', '__proto__']) {
      expectCode({ ...valid, ruleVersion }, 'UNKNOWN_RULE_VERSION');
    }
  });

  it('1..42 정수가 아닌 시즌 일수를 거부한다', () => {
    for (const days of [0, -1, 1.5, 43, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode({ ...valid, days }, 'INVALID_DAYS');
    }
  });

  it('지원하지 않는 출정 모드를 거부한다', () => {
    for (const sortieMode of [null, '', 'manual', 0, false, {}, []]) {
      expectCode({ ...valid, sortieMode }, 'INVALID_SORTIE_MODE');
    }
  });

  it('코호트 식별자와 이름이 없거나 형식이 깨진 입력을 거부한다', () => {
    for (const archetype of [
      null,
      [],
      { ...valid.archetype, id: '' },
      { ...valid.archetype, id: '   ' },
      { ...valid.archetype, nameKo: '' },
      { ...valid.archetype, nameKo: '   ' },
    ]) {
      expectCode({ ...valid, archetype }, 'INVALID_ARCHETYPE');
    }
  });

  it('1..6 정수가 아닌 일일 접속 횟수를 거부한다', () => {
    for (const sessionsPerDay of [0, -1, 1.5, 7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode(
        { ...valid, archetype: { ...valid.archetype, sessionsPerDay } },
        'INVALID_SESSIONS_PER_DAY',
      );
    }
  });

  it('훈련 비율은 비어 있지 않은 plain object여야 한다', () => {
    for (const trainRatio of [null, [], 'rifle', 1]) {
      expectCode(
        { ...valid, archetype: { ...valid.archetype, trainRatio } },
        'INVALID_TRAIN_RATIO',
      );
    }
    expectCode(
      { ...valid, archetype: { ...valid.archetype, trainRatio: {} } },
      'EMPTY_TRAIN_RATIO',
    );
  });

  it('미지 병종과 프로토타입 체인 이름을 훈련 병종으로 인정하지 않는다', () => {
    const prototypeKey = JSON.parse('{"__proto__":1}') as Record<string, number>;
    for (const trainRatio of [
      { battleship: 1 },
      { constructor: 1 },
      { toString: 1 },
      prototypeKey,
    ]) {
      expectCode(
        { ...valid, archetype: { ...valid.archetype, trainRatio } },
        'UNKNOWN_TRAIN_UNIT',
      );
    }
  });

  it('훈련 가중치의 개별 범위와 총합 상한을 검증한다', () => {
    for (const weight of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode(
        { ...valid, archetype: { ...valid.archetype, trainRatio: { rifle: weight } } },
        'INVALID_TRAIN_RATIO',
      );
    }
    const excessiveTotal = Object.fromEntries(
      ECONOMY_UNIT_IDS.map((unitId) => [unitId, 100]),
    );
    expectCode(
      { ...valid, archetype: { ...valid.archetype, trainRatio: excessiveTotal } },
      'INVALID_TRAIN_RATIO',
    );
  });
});

describe('경제 감사 원장과 자원 불변식', () => {
  it('상한 초과 생산과 잔액 초과 유지비를 실제 반영량과 분리한다', () => {
    expect(settleMicroDelta(9_000, 10_000, 5_000)).toEqual({
      appliedDelta: 1_000,
      overflow: 4_000,
      shortfall: 0,
      balanceAfter: 10_000,
    });
    expect(settleMicroDelta(5_000, 10_000, -8_000)).toEqual({
      appliedDelta: -5_000,
      overflow: 0,
      shortfall: 3_000,
      balanceAfter: 0,
    });
    expect(() => settleMicroDelta(-1, 10_000, 1)).toThrow(RangeError);
    expect(() => settleMicroDelta(10_001, 10_000, 1)).toThrow(RangeError);
  });

  it('모든 엔트리가 원인·변경 전후를 가지며 일별 보존식과 체인을 만족한다', () => {
    const report = fullSeason('two');
    const validReasons = new Set([
      'passive_production',
      'unit_upkeep',
      'research',
      'sortie_cost',
      'sortie_reward',
      'construction',
      'training',
    ]);
    const entryIds = new Set<string>();

    for (const [dayIndex, day] of report.daily.entries()) {
      expect(day.day).toBe(dayIndex + 1);
      const chainedBalance = Object.fromEntries(
        RESOURCE_IDS.map((resourceId) => [resourceId, asMicro(day.resources[resourceId].startBalance)]),
      ) as Record<ResourceId, number>;
      const produced = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<ResourceId, number>;
      const consumed = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<ResourceId, number>;
      const overflow = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<ResourceId, number>;

      if (dayIndex === 0) {
        for (const resourceId of RESOURCE_IDS) {
          expectMicroEqual(
            day.resources[resourceId].startBalance,
            ECONOMY_RULESETS[RULE_VERSION]!.balance.startingResources[resourceId],
          );
        }
      } else {
        const previous = report.daily[dayIndex - 1]!;
        for (const resourceId of RESOURCE_IDS) {
          expectMicroEqual(
            day.resources[resourceId].startBalance,
            previous.resources[resourceId].endBalance,
          );
        }
      }

      for (const entry of day.entries) {
        expect(entryIds.has(entry.id)).toBe(false);
        entryIds.add(entry.id);
        expect(entry.id).toMatch(/^ledger-\d{7}$/);
        expect(entry.causeId.trim().length).toBeGreaterThan(0);
        expect(validReasons.has(entry.reason)).toBe(true);
        expect(entry.day).toBe(day.day);
        expect(Number.isInteger(entry.hour)).toBe(true);
        expect(entry.hour).toBeGreaterThanOrEqual(dayIndex * 24);
        expect(entry.hour).toBeLessThan((dayIndex + 1) * 24);
        expect(entry.requestedDelta).not.toBe(0);
        expect(asMicro(entry.balanceBefore)).toBe(chainedBalance[entry.resourceId]);
        expect(asMicro(entry.balanceBefore) + asMicro(entry.appliedDelta))
          .toBe(asMicro(entry.balanceAfter));
        expect(entry.balanceAfter).toBeGreaterThanOrEqual(0);

        if (entry.requestedDelta > 0) {
          expect(entry.appliedDelta).toBeGreaterThanOrEqual(0);
          expect(entry.shortfall).toBe(0);
          expect(asMicro(entry.requestedDelta))
            .toBe(asMicro(entry.appliedDelta) + asMicro(entry.overflow));
          produced[entry.resourceId] += asMicro(entry.requestedDelta);
          overflow[entry.resourceId] += asMicro(entry.overflow);
        } else {
          expect(entry.appliedDelta).toBeLessThanOrEqual(0);
          expect(entry.overflow).toBe(0);
          expect(-asMicro(entry.requestedDelta))
            .toBe(-asMicro(entry.appliedDelta) + asMicro(entry.shortfall));
          consumed[entry.resourceId] += -asMicro(entry.appliedDelta);
        }
        chainedBalance[entry.resourceId] = asMicro(entry.balanceAfter);
      }

      for (const resourceId of RESOURCE_IDS) {
        const resource = day.resources[resourceId];
        expect(chainedBalance[resourceId]).toBe(asMicro(resource.endBalance));
        expect(produced[resourceId]).toBe(asMicro(resource.produced));
        expect(consumed[resourceId]).toBe(asMicro(resource.consumed));
        expect(overflow[resourceId]).toBe(asMicro(resource.overflow));
        expect(asMicro(resource.startBalance) + asMicro(resource.produced)
          - asMicro(resource.consumed) - asMicro(resource.overflow))
          .toBe(asMicro(resource.endBalance));
        expect(resource.endBalance).toBeGreaterThanOrEqual(0);
        expect(resource.endBalance).toBeLessThanOrEqual(resource.cap);
      }
    }

    expect(entryIds.size).toBe(report.daily.reduce((sum, day) => sum + day.entries.length, 0));
  });

  it('일별 합계가 시즌 합계·overflow 비율·최종 잔액과 일치한다', () => {
    const report = fullSeason('two');
    const lastDay = report.daily.at(-1)!;

    for (const resourceId of RESOURCE_IDS) {
      const produced = report.daily.reduce(
        (sum, day) => sum + asMicro(day.resources[resourceId].produced),
        0,
      );
      const consumed = report.daily.reduce(
        (sum, day) => sum + asMicro(day.resources[resourceId].consumed),
        0,
      );
      const overflow = report.daily.reduce(
        (sum, day) => sum + asMicro(day.resources[resourceId].overflow),
        0,
      );
      expect(produced).toBe(asMicro(report.totals[resourceId].produced));
      expect(consumed).toBe(asMicro(report.totals[resourceId].consumed));
      expect(overflow).toBe(asMicro(report.totals[resourceId].overflow));
      expectMicroEqual(report.finalResources[resourceId], lastDay.resources[resourceId].endBalance);

      const expectedRatio = Number(
        (report.totals[resourceId].overflow
          / Math.max(1, report.totals[resourceId].produced)).toFixed(6),
      );
      expect(report.totals[resourceId].overflowRatio).toBe(expectedRatio);
    }
  });
});

describe('경제 결정론과 규칙 불변성', () => {
  it('같은 입력을 반복 실행하면 원장까지 완전히 동일하다', () => {
    const input = inputFor(ECONOMY_ARCHETYPES.two);
    const baseline = simulateSeason(input);
    for (let index = 0; index < 5; index += 1) {
      expect(simulateSeason(input)).toEqual(baseline);
    }
  });

  it('훈련 비율 객체의 키 삽입 순서는 결과 의미를 바꾸지 않는다', () => {
    const originalEntries = Object.entries(ECONOMY_ARCHETYPES.two.trainRatio);
    const reversedRatio = Object.fromEntries(originalEntries.reverse()) as Partial<
      Record<EconomyUnitId, number>
    >;
    const reversed: ArchetypeInput = {
      ...ECONOMY_ARCHETYPES.two,
      trainRatio: reversedRatio,
    };
    expect(simulateSeason(inputFor(reversed))).toEqual(simulateSeason(inputFor(ECONOMY_ARCHETYPES.two)));
  });

  it('경제 규칙·중첩 상수·기본 코호트는 런타임에서 깊게 동결된다', () => {
    const rules = ECONOMY_RULESETS[RULE_VERSION]!;
    const before = simulateSeason(inputFor(ECONOMY_ARCHETYPES.two, 2));

    expect(Object.isFrozen(ECONOMY_RULESETS)).toBe(true);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.balance)).toBe(true);
    expect(Object.isFrozen(rules.balance.startingResources)).toBe(true);
    expect(Object.isFrozen(rules.balance.startingBuildings)).toBe(true);
    expect(Object.isFrozen(rules.balance.buildPriority)).toBe(true);
    expect(Object.isFrozen(rules.buildings)).toBe(true);
    expect(Object.isFrozen(rules.buildings.farm!)).toBe(true);
    expect(Object.isFrozen(rules.buildings.farm!.baseCost)).toBe(true);
    expect(Object.isFrozen(rules.units)).toBe(true);
    expect(Object.isFrozen(rules.units.rifle)).toBe(true);
    expect(Object.isFrozen(rules.units.rifle.trainCost)).toBe(true);
    expect(Object.isFrozen(ECONOMY_ARCHETYPES)).toBe(true);
    expect(Object.isFrozen(ECONOMY_ARCHETYPES.two)).toBe(true);
    expect(Object.isFrozen(ECONOMY_ARCHETYPES.two.trainRatio)).toBe(true);

    expect(() => {
      (rules.balance as unknown as { seasonDays: number }).seasonDays = 99;
    }).toThrow(TypeError);
    expect(() => {
      (rules.buildings.farm!.baseCost as unknown as { food: number }).food = 999;
    }).toThrow(TypeError);
    expect(() => {
      (rules.units.rifle.trainCost as unknown as { food: number }).food = 999;
    }).toThrow(TypeError);
    expect(simulateSeason(inputFor(ECONOMY_ARCHETYPES.two, 2))).toEqual(before);
  });
});

describe('42일 경계와 건설·사령부 게이트', () => {
  it('정확히 0..1007시만 원장에 기록하고 시즌 경계 이후 작업하지 않는다', () => {
    const report = fullSeason('two');
    const entries = report.daily.flatMap((day) => day.entries);

    expect(report.daily.map((day) => day.day)).toEqual(
      Array.from({ length: 42 }, (_, index) => index + 1),
    );
    expect(Math.min(...entries.map((entry) => entry.hour))).toBe(0);
    expect(Math.max(...entries.map((entry) => entry.hour))).toBe(42 * 24 - 1);
    expect(entries.every((entry) => entry.day >= 1 && entry.day <= 42)).toBe(true);
    for (const pending of report.pendingConstructions) {
      expect(pending.completeAtHour).toBeGreaterThan(42 * 24);
      expect(pending.remainingHours).toBe(pending.completeAtHour - 42 * 24);
      expect(pending.remainingHours).toBeGreaterThan(0);
    }
  });

  it('건설 비용·완료 시각·슬롯·동일 건물 중복·HQ 레벨 게이트를 지킨다', () => {
    const report = fullSeason('two');
    const rules = ECONOMY_RULESETS[RULE_VERSION]!;
    const actions = constructionActions(report);
    const totalHours = report.days * 24;

    expect(actions).toHaveLength(report.constructionStarted);
    expect(new Set(actions.map((action) => action.causeId)).size).toBe(actions.length);
    expect(report.constructions).toEqual(actions.map((action) => ({
      causeId: action.causeId,
      buildingId: action.buildingId,
      targetLevel: action.targetLevel,
      startedAtHour: action.startHour,
      completeAtHour: action.completeAtHour,
    })));

    for (const action of actions) {
      expect(BUILDING_IDS).toContain(action.buildingId);
      expect(action.entries.every((entry) => entry.hour === action.startHour)).toBe(true);
      expect(action.entries.every((entry) => entry.shortfall === 0)).toBe(true);
      const definition = buildingDef(rules, action.buildingId);
      const expectedResources = RESOURCE_IDS.filter(
        (resourceId) => definition.baseCost[resourceId] !== undefined,
      );
      expect(action.entries.map((entry) => entry.resourceId).sort())
        .toEqual(expectedResources.slice().sort());
      for (const resourceId of expectedResources) {
        const entry = action.entries.find((candidate) => candidate.resourceId === resourceId)!;
        const expectedCost = Math.ceil(
          definition.baseCost[resourceId]! * definition.costGrowth ** (action.targetLevel - 2),
        );
        expectMicroEqual(-entry.requestedDelta, expectedCost);
        expectMicroEqual(entry.appliedDelta, entry.requestedDelta);
      }

      const activeAtStart = actions.filter(
        (candidate) => candidate.startHour <= action.startHour
          && candidate.completeAtHour > action.startHour,
      );
      expect(activeAtStart.length).toBeLessThanOrEqual(rules.balance.buildSlots);

      if (action.buildingId !== 'hq') {
        const completedHqLevel = Math.max(
          rules.balance.startingBuildings.hq!,
          ...actions
            .filter((candidate) => candidate.buildingId === 'hq'
              && candidate.completeAtHour <= action.startHour)
            .map((candidate) => candidate.targetLevel),
        );
        expect(action.targetLevel)
          .toBeLessThanOrEqual(completedHqLevel + rules.balance.nonHqLevelOffset);
      }
    }

    // 도시의 건물 집합은 규칙이 정한다 — 전역 목록을 돌면 없는 건물까지 검사한다(D-043).
    for (const buildingId of cityBuildingIds(rules)) {
      const buildingActions = actions
        .filter((action) => action.buildingId === buildingId)
        .sort((left, right) => left.targetLevel - right.targetLevel);
      expect(buildingActions.map((action) => action.targetLevel)).toEqual(
        Array.from(
          { length: buildingActions.length },
          (_, index) => rules.balance.startingBuildings[buildingId]! + index + 1,
        ),
      );
      for (let index = 1; index < buildingActions.length; index += 1) {
        expect(buildingActions[index]!.startHour)
          .toBeGreaterThanOrEqual(buildingActions[index - 1]!.completeAtHour);
      }
      const completedLevels = buildingActions
        .filter((action) => action.completeAtHour <= totalHours)
        .map((action) => action.targetLevel);
      const expectedFinal = Math.max(
        rules.balance.startingBuildings[buildingId]!,
        ...completedLevels,
      );
      expect(report.finalBuildings[buildingId]).toBe(expectedFinal);
      expect(report.finalBuildings[buildingId]).toBeLessThanOrEqual(buildingDef(rules, buildingId).maxLevel);
    }

    const completed = actions.filter((action) => action.completeAtHour <= totalHours);
    expect(report.constructionCompleted).toBe(completed.length);
    expect(report.constructionStarted)
      .toBe(report.constructionCompleted + report.pendingConstructions.length);
    expect(new Set(report.pendingConstructions.map((item) => item.buildingId)).size)
      .toBe(report.pendingConstructions.length);
  });
});

describe('병종 집합과 군사 가치 결합', () => {
  it('경제·전투 규칙과 최종 부대가 동일한 12종 병종 집합을 사용한다', () => {
    const economyRules = ECONOMY_RULESETS[RULE_VERSION]!;
    const combatRules = RULESETS[economyRules.combatRuleVersion]!;
    const expected = [...ECONOMY_UNIT_IDS].sort();

    expect(expected).toHaveLength(12);
    expect(Object.keys(economyRules.units).sort()).toEqual(expected);
    expect(Object.keys(combatRules.units).sort()).toEqual(expected);
    expect(Object.keys(fullSeason('two').finalArmy).sort()).toEqual(expected);

    for (const unitId of ECONOMY_UNIT_IDS) {
      expect(economyRules.units[unitId].unitId).toBe(unitId);
      expect(economyRules.units[unitId].upkeepFoodPerHour).toBeGreaterThan(0);
      expect(Number.isFinite(economyRules.units[unitId].upkeepFoodPerHour)).toBe(true);
      for (const amount of Object.values(economyRules.units[unitId].trainCost)) {
        expect(Number.isFinite(amount)).toBe(true);
        expect(amount).toBeGreaterThan(0);
      }
    }
  });

  it('보고서 군사 가치는 연결된 전투 규칙의 병종 비용 합이다', () => {
    const report = fullSeason('two');
    const economyRules = ECONOMY_RULESETS[RULE_VERSION]!;
    const combatRules = RULESETS[economyRules.combatRuleVersion]!;
    const expectedValue = ECONOMY_UNIT_IDS.reduce(
      (sum, unitId) => sum + report.finalArmy[unitId] * combatRules.units[unitId]!.cost,
      0,
    );
    expect(report.combatRuleVersion).toBe(economyRules.combatRuleVersion);
    expect(report.armyValue).toBe(expectedValue);
  });
});

describe('접속 격차·overflow·소모처 회귀 게이트', () => {
  it('접속 증가의 군사 가치 격차가 탐색 상한 안에 머문다', () => {
    const four = fullSeason('four');
    const two = fullSeason('two');
    const one = fullSeason('one');

    expect(four.armyValue).toBeGreaterThan(two.armyValue);
    expect(two.armyValue).toBeGreaterThan(one.armyValue);
    expect(four.armyValue / two.armyValue).toBeLessThanOrEqual(1.35);
    expect(two.armyValue / one.armyValue).toBeLessThanOrEqual(1.75);

    for (const report of [four, two, one]) {
      expect(report.researchCount).toBeLessThanOrEqual(42);
      expect(report.sortieCount).toBeLessThanOrEqual(42 * 2);
      for (const day of report.daily) {
        const researchCauses = new Set(
          day.entries.filter((entry) => entry.reason === 'research').map((entry) => entry.causeId),
        );
        const sortieCauses = new Set(
          day.entries.filter((entry) => entry.reason === 'sortie_cost').map((entry) => entry.causeId),
        );
        expect(researchCauses.size).toBeLessThanOrEqual(1);
        expect(sortieCauses.size).toBeLessThanOrEqual(2);
      }
    }
  });

  it('2회 코호트의 생산 자원 overflow가 40% 이하이고 6종 소모처가 모두 작동한다', () => {
    const report = fullSeason('two');

    for (const resourceId of RESOURCE_IDS) {
      expect(report.totals[resourceId].overflowRatio).toBeLessThanOrEqual(0.4);
      expect(report.totals[resourceId].consumed).toBeGreaterThan(0);
      expect(report.totals[resourceId].overflowRatio).toBeGreaterThanOrEqual(0);
      expect(report.totals[resourceId].overflowRatio).toBeLessThanOrEqual(1);
    }
  });
});

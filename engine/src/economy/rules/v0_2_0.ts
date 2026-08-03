import { ECONOMY_RULESET_V0_1_0 } from './v0_1_0.js';
import type { EconomyRuleset } from '../types.js';

/**
 * 경제 규칙 v0.2.0 — 사양의 핵심 건물 14종(D-043).
 *
 * `GAME_DESIGN.md`가 명시한 건물을 모두 정의한다. 0.1.0의 7종은 값을 그대로 두고
 * 7종을 더한다 — 0.1.0으로 만든 도시는 계속 7종 도시로 동작한다.
 *
 * 새 건물의 역할은 두 가지로 갈린다.
 * - 병영·군수공장·비행장: **병종을 해금한다.** 도시 성장이 편성 선택으로 이어지는 고리다.
 * - 레이더: 정찰 정확도를 올린다.
 * - 연구소·방어사령부·연맹 통신소: 지을 수는 있으나 **효과가 없다.**
 *   연구·PvP 방어·연맹 시스템 자체가 미구현이므로 없는 시스템에 임의 효과를 붙이지 않고
 *   `inertReasonKo`로 그 사실을 그대로 노출한다.
 *
 * 수치는 상대적 위치만 맞춘 초안이며 조정 대상이다(밸런스는 별도 작업).
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BASE = ECONOMY_RULESET_V0_1_0;

export const ECONOMY_RULESET_V0_2_0: EconomyRuleset = deepFreeze({
  ...BASE,
  version: '0.2.0',
  buildings: {
    ...BASE.buildings,

    barracks: {
      id: 'barracks', nameKo: '병영', maxLevel: 10,
      baseCost: { steel: 80, food: 60 }, costGrowth: 1.5,
      baseHours: 1, hourGrowth: 1.4,
    },
    arsenal: {
      id: 'arsenal', nameKo: '군수공장', maxLevel: 10,
      baseCost: { steel: 140, food: 50, oil: 20 }, costGrowth: 1.55,
      baseHours: 2, hourGrowth: 1.45,
    },
    airfield: {
      id: 'airfield', nameKo: '비행장', maxLevel: 10,
      baseCost: { steel: 180, oil: 80, food: 40 }, costGrowth: 1.6,
      baseHours: 3, hourGrowth: 1.45,
    },
    radar: {
      id: 'radar', nameKo: '레이더', maxLevel: 10,
      baseCost: { steel: 120, oil: 40 }, costGrowth: 1.55,
      baseHours: 2, hourGrowth: 1.4,
    },

    research_lab: {
      id: 'research_lab', nameKo: '연구소', maxLevel: 10,
      baseCost: { steel: 160, food: 60, scrip: 20 }, costGrowth: 1.6,
      baseHours: 3, hourGrowth: 1.5,
      inertReasonKo: '연구 시스템이 아직 없어 효과가 없습니다.',
    },
    defense_hq: {
      id: 'defense_hq', nameKo: '방어사령부', maxLevel: 10,
      baseCost: { steel: 150, food: 70 }, costGrowth: 1.55,
      baseHours: 2, hourGrowth: 1.45,
      inertReasonKo: '플레이어 간 전투가 아직 없어 효과가 없습니다.',
    },
    alliance_comms: {
      id: 'alliance_comms', nameKo: '연맹 통신소', maxLevel: 10,
      baseCost: { steel: 110, oil: 30, scrip: 10 }, costGrowth: 1.5,
      baseHours: 2, hourGrowth: 1.4,
      inertReasonKo: '연맹 시스템이 아직 없어 효과가 없습니다.',
    },
  },

  /**
   * 병종 해금(D-043).
   *
   * 시작 도시가 첫 루프를 돌 수 있어야 하므로 소총병·정찰차량·야포는 1레벨에서 열린다.
   * 그 위는 시나리오 사다리가 요구하는 대응 수단과 짝을 맞춘다 —
   * 기갑 정찰대(4단계)에는 대전차, 전진 비행장(5단계)에는 항공·대공이 필요하다.
   */
  unitUnlocks: {
    rifle: { buildingId: 'barracks', level: 1 },
    scout: { buildingId: 'barracks', level: 1 },
    engineer: { buildingId: 'barracks', level: 2 },
    at_infantry: { buildingId: 'barracks', level: 3 },

    howitzer: { buildingId: 'arsenal', level: 1 },
    supply_truck: { buildingId: 'arsenal', level: 2 },
    at_gun: { buildingId: 'arsenal', level: 3 },
    medium_tank: { buildingId: 'arsenal', level: 4 },
    aa_gun: { buildingId: 'arsenal', level: 5 },
    heavy_tank: { buildingId: 'arsenal', level: 6 },

    fighter: { buildingId: 'airfield', level: 1 },
    bomber: { buildingId: 'airfield', level: 3 },
  },

  balance: {
    ...BASE.balance,
    /** 레이더 레벨당 정찰 정확도 가산(0..1 척도). 상한은 서버가 적용한다. */
    radarReconAccuracyPerLevel: 0.03,
    buildPriority: [
      'farm', 'steel_mill', 'refinery', 'supply_depot', 'housing', 'warehouse',
      'barracks', 'arsenal', 'radar', 'airfield',
      'research_lab', 'defense_hq', 'alliance_comms', 'hq',
    ],
    startingBuildings: {
      ...BASE.balance.startingBuildings,
      // 새 건물은 1레벨로 시작한다. 사령부는 첫 목표(농장 증설)가 게이트에 막히지 않게 2다.
      hq: 2,
      barracks: 1,
      arsenal: 1,
      airfield: 1,
      research_lab: 1,
      radar: 1,
      defense_hq: 1,
      alliance_comms: 1,
    },
  },
} satisfies EconomyRuleset);

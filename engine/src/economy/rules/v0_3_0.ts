import { ECONOMY_RULESET_V0_2_0 } from './v0_2_0.js';
import type { EconomyRuleset, ResearchDef } from '../types.js';

/**
 * 경제 규칙 v0.3.0 — 연구 시스템(D-044).
 *
 * 0.2.0에서 연구소·방어사령부·연맹 통신소는 지을 수는 있으나 효과가 없었다.
 * 자원만 먹는 건물은 함정이므로 셋을 서로 다르게 처리한다.
 *
 * - **연구소**: 실제 연구 시스템을 붙였다. `inertReasonKo`를 지워 건설을 연다.
 * - **방어사령부·연맹 통신소**: PvP 방어와 연맹은 여러 플레이어가 필요해 지금 만들 수 없다.
 *   `inertReasonKo`를 유지하고 서버가 건설을 거부한다 — 효과 없는 건물에 자원을 못 쓰게 한다.
 *   해당 시스템이 생기면 이 값을 지워 건설을 연다.
 *
 * 연구 효과는 **이미 존재하는 계산에만 들어간다**(공격 배수·정찰 정확도·건설 비용·출정 비용).
 * 새 전투 규칙이나 새 자원을 만들지 않는다.
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BASE = ECONOMY_RULESET_V0_2_0;

/**
 * 연구 항목. **효과가 실제로 동작하는 것만 둔다.**
 *
 * 지휘(장교)·방어(PvP)·연맹은 그 시스템이 없어 넣지 않는다.
 * 산업(건설 비용)·보급(출정 비용)은 효과 종류는 정의해 뒀지만, 비용 할인은
 * 저장된 건설·출정 기록의 재검증 경로를 함께 확장해야 하므로 다음 작업으로 미룬다 —
 * 목록에 있는데 아무 일도 없는 항목을 만들지 않는다.
 */
const RESEARCH = {
  infantry_doctrine: {
    id: 'infantry_doctrine', nameKo: '보병 전술', categoryKo: '보병',
    descriptionKo: '보병 계열의 공격력을 올린다.',
    maxLevel: 5, baseScripCost: 40, scripCostStep: 30, requiresLabLevel: 1,
    effect: { kind: 'attack', tag: 'infantry', perLevel: 0.04 },
  },
  at_doctrine: {
    id: 'at_doctrine', nameKo: '대전차 화기', categoryKo: '보병',
    descriptionKo: '대전차 계열의 공격력을 올린다. 기갑 상대에 쓴다.',
    maxLevel: 5, baseScripCost: 60, scripCostStep: 40, requiresLabLevel: 2,
    requires: 'infantry_doctrine',
    effect: { kind: 'attack', tag: 'at', perLevel: 0.05 },
  },
  armor_doctrine: {
    id: 'armor_doctrine', nameKo: '기갑 운용', categoryKo: '기갑',
    descriptionKo: '중형전차의 공격력을 올린다.',
    maxLevel: 5, baseScripCost: 80, scripCostStep: 50, requiresLabLevel: 3,
    effect: { kind: 'attack', tag: 'armor_medium', perLevel: 0.05 },
  },
  artillery_doctrine: {
    id: 'artillery_doctrine', nameKo: '포격 관측', categoryKo: '포병',
    descriptionKo: '포병의 공격력을 올린다.',
    maxLevel: 5, baseScripCost: 70, scripCostStep: 45, requiresLabLevel: 2,
    effect: { kind: 'attack', tag: 'artillery', perLevel: 0.05 },
  },
  recon_doctrine: {
    id: 'recon_doctrine', nameKo: '정찰 기법', categoryKo: '정찰',
    descriptionKo: '정찰 보고서의 정확도를 올린다.',
    maxLevel: 5, baseScripCost: 50, scripCostStep: 35, requiresLabLevel: 1,
    effect: { kind: 'recon', perLevelPermille: 20 },
  },
} satisfies Record<string, ResearchDef>;

export const ECONOMY_RULESET_V0_3_0: EconomyRuleset = deepFreeze({
  ...BASE,
  version: '0.3.0',
  buildings: {
    ...BASE.buildings,
    // 연구 시스템이 생겼으므로 연구소는 건설할 수 있다.
    research_lab: {
      ...BASE.buildings.research_lab!,
      inertReasonKo: undefined,
    },
    // 이 둘은 그대로 막아 둔다. 자원을 쓰게 하고 아무 일도 없으면 함정이다.
  },
  research: RESEARCH,
} satisfies EconomyRuleset);

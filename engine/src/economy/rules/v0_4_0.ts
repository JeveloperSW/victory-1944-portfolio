import { ECONOMY_RULESET_V0_3_0 } from './v0_3_0.js';
import type { EconomyRuleset } from '../types.js';

/**
 * 경제 규칙 v0.4.0 — 출정 비용을 전력 비례로 옮긴다(D-046).
 *
 * 측정 결과 0.3.0까지의 출정 비용은 **사실상 고정비**였다.
 * `base { supplies 30, oil 10 }`에 비해 전력 비례분(`0.005`, `0.002`)이 너무 작아,
 * 1단계에서 200어치 부대를 보내나 6단계에서 1200어치를 보내나 값이 거의 같았다.
 *
 * 고정비는 저단계에 가장 아프다. 1단계 승리 보상보다 출정 비용이 커서
 * **첫 전투는 이겨도 손해**였다(보상 40 vs 출정 63). 베타 참가자가 처음 겪는 전투가 그것이다.
 *
 * 기본값을 낮추고 비례분을 올려 "많이 데려가면 많이 든다"로 바꿨다.
 * 총액은 6단계에서 오히려 커진다 — 싸게 만든 것이 아니라 **누진으로 바꾼 것**이다.
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BASE = ECONOMY_RULESET_V0_3_0;

export const ECONOMY_RULESET_V0_4_0: EconomyRuleset = deepFreeze({
  ...BASE,
  version: '0.4.0',
  balance: {
    ...BASE.balance,
    sortieBaseCost: { supplies: 8, oil: 3 },
    sortieCostPerArmyValue: { supplies: 0.03, oil: 0.012 },
    /**
     * 시작 농장·제철소를 2레벨로 올린다(D-046).
     * 1레벨 생산(식량 20·강철 12)으로는 첫 부대를 다시 뽑는 데 28시간이 걸려,
     * **한 번 지면 하루 넘게 할 게 없는** 상태였다. 생산을 두 배로 만들어 재도전 간격을 줄인다.
     * 곡선 자체(`perHourPerLevel`)는 건드리지 않았다 — 초반만 당기고 후반은 그대로 둔다.
     *
     * 사령부도 3레벨로 올린다. `nonHqLevelOffset`이 0이라 다른 건물의 목표 레벨은
     * 사령부 레벨을 넘을 수 없는데, 농장이 2에서 시작하면 사령부 2로는 **증설이 아예 막힌다** —
     * 튜토리얼이 첫 지시로 시키는 농장 증설이 첫 화면에서 거부된다.
     */
    startingBuildings: {
      ...BASE.balance.startingBuildings,
      hq: 3,
      farm: 2,
      steel_mill: 2,
    },
  },
} satisfies EconomyRuleset);

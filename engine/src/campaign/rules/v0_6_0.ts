import type { CampaignRuleset } from '../types.js';
import { CAMPAIGN_RULESET_V0_5_0 } from './v0_5_0.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 캠페인 규칙 v0.6.0 — 사다리 밸런스 조정(D-046). 경제 0.4.0에 결속한다.
 *
 * `ladder-report`로 잰 0.5.0의 문제는 셋이었다.
 *
 * 1. **난이도가 단조롭지 않다.** 통과에 필요한 생산 시간이
 *    28.3h → 7.5h → 25.0h → 13.1h → 18.3h → 27.1h 로 오르내렸다.
 *    첫 단계가 두 번째로 어려웠고, 3단계가 4단계보다 어려웠다.
 * 2. **1·3단계는 이겨도 손해였다**(−36, −21). 이길수록 가난해지는 구간이 사다리 안에 있었다.
 * 3. **보상이 단계와 무관했다.** 6단계 보상이 1단계의 6배인데 요구 전력은 3배가 넘었다.
 *
 * 고친 방향
 * - 1단계는 첫 전투답게 낮춘다: 방어 교리를 없애고 대전차보병을 뺀다.
 *   처음 싸우는 사람에게 피해 감소 교리와 상성 병종을 함께 물리지 않는다.
 * - 3단계 야포를 4→3문으로 줄인다. 사거리 3 야포 4문은 4단계 기갑보다 아팠다.
 * - 보상을 단계에 따라 올린다. 기준은 "그 단계 통과 편성으로 이겼을 때 남는 것이 있고,
 *   그 크기가 단계마다 커진다"이다. 값은 측정으로 맞췄다(D-046 표).
 *
 * 방어 편성의 **성격**은 바꾸지 않았다. 각 단계가 내는 문제(포병·기갑·항공·복합)는 그대로다.
 */
const BASE = CAMPAIGN_RULESET_V0_5_0;

export const CAMPAIGN_RULESET_V0_6_0: CampaignRuleset = deepFreeze({
  ...BASE,
  version: '0.6.0',
  economyRuleVersion: '0.4.0',
  scenarios: {
    training_outpost: {
      ...BASE.scenarios.training_outpost!,
      briefKo: '보병 소대가 지키는 훈련장이다. 첫 출격에 알맞다.',
      defender: {
        ...BASE.scenarios.training_outpost!.defender,
        /**
         * 첫 전투에서 뺀 것: 피해 감소 교리, 대전차보병, **야포**.
         * 사거리 3에 광역인 야포는 작은 부대를 첫 라운드에 갈아 버려서, 1단계가 2단계보다
         * 어려운 원인이었다. 야포는 3단계 "포병 진지"가 가르칠 몫이다.
         * 이제 1단계는 보병 소대 그 자체이며 브리핑 문구와도 맞는다.
         */
        stacks: [
          { unitId: 'rifle', count: 5, row: 'front' },
          { unitId: 'scout', count: 1, row: 'mid' },
        ],
        doctrine: 'none',
      },
      victoryReward: { scrip: 15, food: 40, steel: 30 },
    },

    supply_column: {
      ...BASE.scenarios.supply_column!,
      victoryReward: { scrip: 20, supplies: 40, food: 30, steel: 10 },
    },

    artillery_position: {
      ...BASE.scenarios.artillery_position!,
      defender: {
        ...BASE.scenarios.artillery_position!.defender,
        // 야포 4문은 4단계 기갑보다 아팠다. 3문으로 줄여 순서를 되돌린다.
        stacks: [
          { unitId: 'rifle', count: 6, row: 'front' },
          { unitId: 'engineer', count: 2, row: 'front' },
          { unitId: 'howitzer', count: 3, row: 'back' },
        ],
      },
      victoryReward: { scrip: 40, steel: 120, food: 120, supplies: 50 },
    },

    armored_patrol: {
      ...BASE.scenarios.armored_patrol!,
      victoryReward: { scrip: 50, steel: 180, oil: 60, food: 180 },
    },

    forward_airfield: {
      ...BASE.scenarios.forward_airfield!,
      victoryReward: { scrip: 70, oil: 160, supplies: 90, steel: 120, food: 130 },
    },

    fortified_roadblock: {
      ...BASE.scenarios.fortified_roadblock!,
      victoryReward: { scrip: 120, food: 400, steel: 400, supplies: 200, oil: 160 },
    },
  },
} satisfies CampaignRuleset);

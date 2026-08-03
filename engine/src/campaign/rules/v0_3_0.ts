import type { CampaignRuleset } from '../types.js';
import { CAMPAIGN_RULESET_V0_2_0 } from './v0_2_0.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * D-040 콘텐츠 확장용 캠페인 규칙.
 * 경제·전투 규칙은 그대로 두고 NPC 시나리오 사다리만 채운다.
 *
 * 설계 의도: 각 단계가 서로 다른 편성 문제를 낸다. 같은 부대로 계속 밀 수 없게 해서
 * 정찰 → 편성 → 재도전이 반복되도록 한다(기획안의 전투 전략성 가설).
 * 수치는 이 단계에서 조정 대상이 아니며(밸런스는 나중) 상대적 난이도만 맞춘다.
 */
export const CAMPAIGN_RULESET_V0_3_0: CampaignRuleset = deepFreeze({
  ...CAMPAIGN_RULESET_V0_2_0,
  version: '0.3.0',
  scenarios: {
    training_outpost: {
      ...CAMPAIGN_RULESET_V0_2_0.scenarios.training_outpost!,
      briefKo: '보병 소대가 지키는 훈련장이다. 첫 출격에 알맞다.',
      tier: 1,
    },

    supply_column: {
      id: 'supply_column',
      nameKo: '보급 종대',
      briefKo: '호위가 얇은 수송대다. 빠르게 몰아붙이면 손실 없이 끝난다.',
      tier: 2,
      unlockAfter: 'training_outpost',
      defender: {
        stacks: [
          { unitId: 'supply_truck', count: 6, row: 'mid' },
          { unitId: 'rifle', count: 4, row: 'front' },
          { unitId: 'scout', count: 2, row: 'mid' },
        ],
        doctrine: 'none',
        supply: 0.6,
        reconAccuracy: 0.3,
        retreatThreshold: 0.55,
      },
      victoryReward: { scrip: 15, supplies: 40, food: 20 },
    },

    artillery_position: {
      id: 'artillery_position',
      nameKo: '포병 진지',
      briefKo: '후열의 야포가 아프다. 전열을 두껍게 세우거나 포병으로 맞대응해야 한다.',
      tier: 3,
      unlockAfter: 'supply_column',
      defender: {
        stacks: [
          { unitId: 'rifle', count: 6, row: 'front' },
          { unitId: 'engineer', count: 2, row: 'front' },
          { unitId: 'howitzer', count: 4, row: 'back' },
        ],
        doctrine: 'artillery_support',
        supply: 0.9,
        reconAccuracy: 0.45,
        retreatThreshold: 0.35,
      },
      victoryReward: { scrip: 20, steel: 30, food: 25 },
    },

    armored_patrol: {
      id: 'armored_patrol',
      nameKo: '기갑 정찰대',
      briefKo: '전차가 주력이다. 대전차 수단 없이 보병만 보내면 그대로 갈린다.',
      tier: 4,
      unlockAfter: 'artillery_position',
      defender: {
        stacks: [
          { unitId: 'medium_tank', count: 4, row: 'front' },
          { unitId: 'heavy_tank', count: 1, row: 'front' },
          { unitId: 'scout', count: 2, row: 'mid' },
        ],
        doctrine: 'armor_breakthrough',
        supply: 1,
        reconAccuracy: 0.5,
        retreatThreshold: 0.3,
      },
      victoryReward: { scrip: 25, steel: 45, oil: 25 },
    },

    forward_airfield: {
      id: 'forward_airfield',
      nameKo: '전진 비행장',
      briefKo: '항공 전력과 대공포가 함께 있다. 제공권을 뺏지 못하면 후열이 무너진다.',
      tier: 5,
      unlockAfter: 'armored_patrol',
      defender: {
        stacks: [
          { unitId: 'rifle', count: 5, row: 'front' },
          { unitId: 'aa_gun', count: 3, row: 'mid' },
          { unitId: 'fighter', count: 3, row: 'back' },
          { unitId: 'bomber', count: 2, row: 'back' },
        ],
        doctrine: 'defense',
        supply: 1,
        reconAccuracy: 0.6,
        retreatThreshold: 0.3,
      },
      victoryReward: { scrip: 30, oil: 50, supplies: 30 },
    },

    fortified_roadblock: {
      ...CAMPAIGN_RULESET_V0_2_0.scenarios.fortified_roadblock!,
      briefKo: '모든 병종이 섞인 거점이다. 앞 단계에서 배운 것을 전부 써야 한다.',
      tier: 6,
      unlockAfter: 'forward_airfield',
      // 0.2.0의 보상(군표 25)은 새 사다리에서 5단계보다 낮아 역전이 생긴다. 최종 단계로 올린다.
      victoryReward: { scrip: 40, food: 60, steel: 40, supplies: 40 },
    },
  },
} satisfies CampaignRuleset);

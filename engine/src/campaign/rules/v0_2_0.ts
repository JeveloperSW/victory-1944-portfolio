import type { CampaignRuleset } from '../types.js';
import { CAMPAIGN_RULESET_V0_1_0 } from './v0_1_0.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * D-023 플레이어블 첫 루프용 캠페인 규칙.
 * 경제·전투 규칙은 각각 0.1.0을 그대로 참조하고 새 NPC 시나리오만 추가한다.
 */
export const CAMPAIGN_RULESET_V0_2_0: CampaignRuleset = deepFreeze({
  ...CAMPAIGN_RULESET_V0_1_0,
  version: '0.2.0',
  scenarios: {
    training_outpost: {
      id: 'training_outpost',
      nameKo: '훈련 전초기지',
      defender: {
        stacks: [
          { unitId: 'rifle', count: 5, row: 'front' },
          { unitId: 'at_infantry', count: 1, row: 'front' },
          { unitId: 'scout', count: 1, row: 'mid' },
          { unitId: 'howitzer', count: 1, row: 'back' },
        ],
        doctrine: 'defense',
        supply: 0.85,
        reconAccuracy: 0.35,
        retreatThreshold: 0.4,
      },
      victoryReward: { scrip: 10, food: 20 },
    },
    ...CAMPAIGN_RULESET_V0_1_0.scenarios,
  },
} satisfies CampaignRuleset);

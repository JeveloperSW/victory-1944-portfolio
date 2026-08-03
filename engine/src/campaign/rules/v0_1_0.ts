import type { CampaignRuleset } from '../types.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CAMPAIGN_RULESET_V0_1_0: CampaignRuleset = deepFreeze({
  version: '0.1.0',
  economyRuleVersion: '0.1.0',
  combatRuleVersion: '0.1.0',
  attackerDefaults: {
    supply: 1,
    reconAccuracy: 0.65,
    retreatThreshold: 0.35,
  },
  recoveryHours: 12,
  recoverySupplyCostRatio: 0.1,
  scenarios: {
    fortified_roadblock: {
      id: 'fortified_roadblock',
      nameKo: '요새화된 교차로',
      defender: {
        stacks: [
          { unitId: 'rifle', count: 8, row: 'front' },
          { unitId: 'at_infantry', count: 3, row: 'front' },
          { unitId: 'medium_tank', count: 2, row: 'front' },
          { unitId: 'heavy_tank', count: 1, row: 'front' },
          { unitId: 'at_gun', count: 2, row: 'mid' },
          { unitId: 'aa_gun', count: 1, row: 'mid' },
          { unitId: 'howitzer', count: 2, row: 'back' },
          { unitId: 'fighter', count: 1, row: 'back' },
        ],
        doctrine: 'defense',
        supply: 1,
        reconAccuracy: 0.55,
        retreatThreshold: 0.25,
      },
      victoryReward: { scrip: 25, food: 40 },
    },
  },
} satisfies CampaignRuleset);

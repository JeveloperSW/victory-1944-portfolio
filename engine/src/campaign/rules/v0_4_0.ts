import type { CampaignRuleset } from '../types.js';
import { CAMPAIGN_RULESET_V0_3_0 } from './v0_3_0.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 캠페인 규칙 v0.4.0 — 경제 규칙 0.2.0(건물 14종·병종 해금)에 결속한다(D-043).
 *
 * 시나리오는 0.3.0과 같다. **경제 규칙 버전만 올린다** —
 * 0.3.0의 economyRuleVersion을 고치면 그 버전으로 만들어진 기존 도시가
 * 규칙 호환 검사(campaignForCity)에서 전부 DATA_INTEGRITY로 죽는다.
 */
export const CAMPAIGN_RULESET_V0_4_0: CampaignRuleset = deepFreeze({
  ...CAMPAIGN_RULESET_V0_3_0,
  version: '0.4.0',
  economyRuleVersion: '0.2.0',
} satisfies CampaignRuleset);

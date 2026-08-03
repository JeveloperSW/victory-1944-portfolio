import type { CampaignRuleset } from '../types.js';
import { CAMPAIGN_RULESET_V0_4_0 } from './v0_4_0.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 캠페인 규칙 v0.5.0 — 경제 규칙 0.3.0(연구 시스템)에 결속한다(D-044).
 * 시나리오는 0.4.0과 같다. 0.4.0의 economyRuleVersion을 고치면 그 버전으로 만든
 * 기존 도시가 규칙 호환 검사에서 죽으므로 새 버전을 만든다.
 */
export const CAMPAIGN_RULESET_V0_5_0: CampaignRuleset = deepFreeze({
  ...CAMPAIGN_RULESET_V0_4_0,
  version: '0.5.0',
  economyRuleVersion: '0.3.0',
} satisfies CampaignRuleset);

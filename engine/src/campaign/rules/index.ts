import { CAMPAIGN_RULESET_V0_1_0 } from './v0_1_0.js';
import { CAMPAIGN_RULESET_V0_2_0 } from './v0_2_0.js';
import { CAMPAIGN_RULESET_V0_3_0 } from './v0_3_0.js';
import { CAMPAIGN_RULESET_V0_4_0 } from './v0_4_0.js';
import { CAMPAIGN_RULESET_V0_5_0 } from './v0_5_0.js';
import { CAMPAIGN_RULESET_V0_6_0 } from './v0_6_0.js';

export const CAMPAIGN_RULESETS = Object.freeze({
  '0.1.0': CAMPAIGN_RULESET_V0_1_0,
  '0.2.0': CAMPAIGN_RULESET_V0_2_0,
  '0.3.0': CAMPAIGN_RULESET_V0_3_0,
  '0.4.0': CAMPAIGN_RULESET_V0_4_0,
  '0.5.0': CAMPAIGN_RULESET_V0_5_0,
  '0.6.0': CAMPAIGN_RULESET_V0_6_0,
});

/** 새 도시가 받는 캠페인 규칙. 콘텐츠를 추가하면 이 값을 올린다. */
export const CURRENT_CAMPAIGN_RULE_VERSION = '0.6.0';

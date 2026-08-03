import type { EconomyRuleset } from '../types.js';
import { CURVE_DRAFTS } from './curve-drafts.js';
import { ECONOMY_RULESET_V0_1_0 } from './v0_1_0.js';
import { ECONOMY_RULESET_V0_2_0 } from './v0_2_0.js';
import { ECONOMY_RULESET_V0_3_0 } from './v0_3_0.js';
import { ECONOMY_RULESET_V0_4_0 } from './v0_4_0.js';

/**
 * 경제 규칙 레지스트리.
 * `0.1.0`이 유일한 정식 버전이며 배포 후 변경하지 않는다.
 * `*-draft-*`는 D-027 곡선 심화 검토용 초안이고 어떤 도시에도 결속되지 않는다.
 * 채택 시 하나를 정식 버전으로 다시 고정하고 초안은 제거한다.
 */
export const ECONOMY_RULESETS: Readonly<Record<string, EconomyRuleset>> = Object.freeze({
  '0.1.0': ECONOMY_RULESET_V0_1_0,
  '0.2.0': ECONOMY_RULESET_V0_2_0,
  '0.3.0': ECONOMY_RULESET_V0_3_0,
  '0.4.0': ECONOMY_RULESET_V0_4_0,
  ...CURVE_DRAFTS,
});

/** 새 도시가 받는 경제 규칙. 건물·병종 해금을 추가하면 이 값을 올린다(D-043). */
export const CURRENT_ECONOMY_RULE_VERSION = '0.4.0';

export { CURVE_DRAFTS, deepenCurve, type CurveDraftOptions } from './curve-drafts.js';

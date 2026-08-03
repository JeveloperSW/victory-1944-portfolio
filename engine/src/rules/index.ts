import type { Ruleset } from '../types.js';
import { RULESET_V0_1_0 } from './v0_1_0.js';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * 규칙 버전 레지스트리.
 * 과거 전투 재현을 위해 배포된 규칙 버전은 삭제·변경하지 않고 새 버전을 추가한다(QUALITY_GATES 전투 게이트).
 */
export const RULESETS: Readonly<Record<string, Ruleset>> = deepFreeze({
  [RULESET_V0_1_0.version]: RULESET_V0_1_0,
});

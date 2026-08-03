export interface MicroDeltaSettlement {
  readonly appliedDelta: number;
  readonly overflow: number;
  readonly shortfall: number;
  readonly balanceAfter: number;
}

/** 고정소수점 정수 잔액에 상한·비음수 규칙을 적용한다. */
export function settleMicroDelta(
  balance: number,
  cap: number,
  requestedDelta: number,
): MicroDeltaSettlement {
  if (![balance, cap, requestedDelta].every(Number.isSafeInteger)
    || balance < 0
    || cap < 0
    || balance > cap) {
    throw new RangeError('잔액·상한·변경량은 유효한 고정소수점 정수여야 합니다.');
  }
  if (requestedDelta >= 0) {
    const appliedDelta = Math.min(requestedDelta, cap - balance);
    return {
      appliedDelta,
      overflow: requestedDelta - appliedDelta,
      shortfall: 0,
      balanceAfter: balance + appliedDelta,
    };
  }
  const requestedCost = -requestedDelta;
  const paid = Math.min(balance, requestedCost);
  return {
    appliedDelta: -paid,
    overflow: 0,
    shortfall: requestedCost - paid,
    balanceAfter: balance - paid,
  };
}

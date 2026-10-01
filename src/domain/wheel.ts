import { addMoney4, type Money4, mulMoney4, subMoney4, sumMoney4 } from "./money.ts";

/** Per-share basis of shares put to you: strike less the put premium (D3 credits that premium). */
export const assignedShareBasis = (strike: Money4, putPremiumPerShare: Money4): Money4 =>
  subMoney4(strike, putPremiumPerShare);

export const adjustedBasis = (basis: Money4, callPremiumsPerShare: readonly Money4[]): Money4 =>
  subMoney4(basis, sumMoney4(callPremiumsPerShare));

export function calledAwayGain(input: {
  strike: Money4;
  basis: Money4;
  shares: number;
  /** Total call premium in dollars, not per share. */
  callPremium: Money4;
}): Money4 {
  return addMoney4(
    mulMoney4(subMoney4(input.strike, input.basis), input.shares),
    input.callPremium,
  );
}

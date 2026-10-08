import { formatMoney4, negMoney4, parseMoney4 } from "../domain/money.ts";
import { defaultFee } from "../shared/tradeForm.ts";

/** Forms take fees as a positive charge; close, assign and roll requests take them as zero or negative. */
export function feeToApi(charge: string): string {
  const money = parseMoney4(charge);
  if (money < 0) throw new RangeError("Enter fees as a positive charge or zero");
  return formatMoney4(negMoney4(money));
}

export const defaultFeeInput = (contracts: number): string =>
  formatMoney4(defaultFee(contracts), 2);

import type { IsoDate } from "../domain/dates.ts";
import { formatMoney4, type Money4 } from "../domain/money.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whole dollars or cents, grouped, with a true minus sign; never goes through a float. */
export function usd(amount: Money4, decimals: 0 | 2 = 0): string {
  const plain = formatMoney4(amount, decimals);
  const negative = plain.startsWith("-");
  const [whole = "", fraction] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}$${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** A strike prints whole when it is whole (`$50`) and in cents otherwise (`$26.67`). */
export const strikeNumber = (strike: Money4): string =>
  formatMoney4(strike, strike % 10_000 === 0 ? 0 : 2);

/** A dimensionless ratio as a percentage. */
export const percent = (ratio: number, decimals = 0): string =>
  `${(ratio * 100).toFixed(decimals)}%`;

export function shortDate(date: IsoDate): string {
  const month = MONTHS[Number(date.slice(5, 7)) - 1];
  return `${month} ${Number(date.slice(8, 10))}`;
}

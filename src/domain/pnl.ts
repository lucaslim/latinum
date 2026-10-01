import type { IsoDate } from "./dates.ts";
import { addMoney4, type Money4, sumMoney4 } from "./money.ts";

export type TradeAction = "open" | "close" | "expire" | "assign" | "exercise";

export interface Trade<A extends TradeAction = TradeAction> {
  action: A;
  date: IsoDate;
  /** Signed proceeds, positive when received; excludes fees. */
  cash: Money4;
  /** Zero or negative. */
  fees: Money4;
}

export interface RealizedLeg {
  pnl: Money4;
  /** `YYYY-MM`. D3 and D4: the month of the closing trade, whether close, expiry or assignment. */
  bookedMonth: string;
}

/** Realized P/L of a closed leg: the sum of cash and fees across its trades. */
export function realizedLeg(
  opening: readonly Trade<"open">[],
  closing: Trade<Exclude<TradeAction, "open">>,
): RealizedLeg {
  const trades = [...opening, closing];
  return {
    pnl: addMoney4(sumMoney4(trades.map((t) => t.cash)), sumMoney4(trades.map((t) => t.fees))),
    bookedMonth: closing.date.slice(0, 7),
  };
}

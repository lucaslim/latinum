import type { Money4 } from "./money.ts";
import type { Trade } from "./pnl.ts";

/** Input order breaks same-date ties; callers supply tradeDate, createdAt, id order. */
export interface QuantityTrade extends Trade {
  id: string;
  quantity: number;
}
export interface RealizedAllocation {
  tradeId: string;
  quantity: number;
  openingCash: Money4;
  openingFees: Money4;
  pnl: Money4;
  bookedMonth: string;
}

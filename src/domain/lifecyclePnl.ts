import type { QuantityTrade, RealizedAllocation } from "./lifecycleTypes.ts";
import { type Money4, prorateMoney4 } from "./money.ts";

/** Return a safe integer or throw RangeError before lifecycle arithmetic can lose precision. */
function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("Unsafe lifecycle integer");
  return value;
}

/**
 * Allocates one leg's signed cash/fees to each close, expiry, assignment or exercise.
 * Sorts by NY trading date without mutating input; input order breaks same-date ties
 * (repository callers must supply tradeDate, createdAt, id order).
 * Only preceding opens enter the remaining weighted-average pool. Cash and fees
 * truncate separately toward zero; a full close consumes both remainders exactly.
 * Reopening a fully closed leg starts a fresh pool. Closing cash/fees belong only
 * to that event. Each result carries the closing trade ID and YYYY-MM booking month
 * for T10/T11b; this function neither aggregates months nor exports recorded trades.
 * Throws RangeError for nonpositive/unsafe quantities, noninteger/unsafe money,
 * positive fees, over-closes, or unsafe pool/result sums. An open pool emits no row.
 */
export function allocateRealizedTrades(events: readonly QuantityTrade[]): RealizedAllocation[] {
  let quantity = 0;
  let cash = 0 as Money4;
  let fees = 0 as Money4;
  const allocations: RealizedAllocation[] = [];
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    if (safeInteger(event.quantity) <= 0) throw new RangeError("Quantity must be positive");
    safeInteger(event.cash);
    if (safeInteger(event.fees) > 0) throw new RangeError("Fees cannot be positive");
    if (event.action === "open") {
      quantity = safeInteger(quantity + event.quantity);
      cash = safeInteger(cash + event.cash) as Money4;
      fees = safeInteger(fees + event.fees) as Money4;
      continue;
    }
    if (event.quantity > quantity) throw new RangeError("Close exceeds preceding open quantity");
    const openingCash = prorateMoney4(cash, event.quantity, quantity);
    const openingFees = prorateMoney4(fees, event.quantity, quantity);
    const pnl = safeInteger(
      safeInteger(safeInteger(openingCash + openingFees) + event.cash) + event.fees,
    ) as Money4;
    allocations.push({
      tradeId: event.id,
      quantity: event.quantity,
      openingCash,
      openingFees,
      pnl,
      bookedMonth: event.date.slice(0, 7),
    });
    quantity -= event.quantity;
    cash = safeInteger(cash - openingCash) as Money4;
    fees = safeInteger(fees - openingFees) as Money4;
  }
  return allocations;
}

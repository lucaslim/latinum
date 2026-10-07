import { createHash } from "node:crypto";
import type * as s from "./schema.ts";

export function positionRevision(
  position: typeof s.positions.$inferSelect,
  legs: readonly (typeof s.legs.$inferSelect)[],
  trades: readonly (typeof s.trades.$inferSelect)[],
): string {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const payload = [
    [
      position.id,
      position.campaignId,
      position.underlying,
      position.strategy,
      position.role,
      position.openedOn,
      position.closedOn,
      position.rollChainId,
    ],
    [...legs]
      .sort(byId)
      .map((leg) => [
        leg.id,
        leg.kind,
        leg.side,
        leg.underlying,
        leg.strike,
        leg.expiry,
        leg.multiplier,
        leg.adjusted,
        leg.coveredLegId,
      ]),
    [...trades]
      .sort(byId)
      .map((trade) => [
        trade.id,
        trade.legId,
        trade.action,
        trade.tradeDate,
        trade.quantity,
        trade.price,
        trade.cash,
        trade.fees,
        trade.rollId,
      ]),
  ];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

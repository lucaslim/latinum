import { eq } from "drizzle-orm";
import { parseIsoDate } from "../domain/dates.ts";
import { aggregateMonthlyPnl } from "../domain/monthlyPnl.ts";
import type {
  MonthlyPnlLeg,
  MonthlyPnlResponse,
  MonthlyPnlTrade,
} from "../domain/monthlyPnlTypes.ts";
import type { Database } from "./database.ts";
import * as s from "./schema.ts";

export function readMonthlyPnl(db: Database): Promise<MonthlyPnlResponse> {
  return db.transaction(
    async (tx) => {
      const accounts = await tx.select({ id: s.accounts.id }).from(s.accounts);
      if (accounts.length > 1)
        throw new Error("More than one account: monthly P/L reads a single book");
      const [account] = accounts;
      if (!account) return { months: [] };
      const rows = await tx
        .select({
          legId: s.legs.id,
          positionId: s.positions.id,
          campaignId: s.positions.campaignId,
          underlying: s.positions.underlying,
          strategy: s.positions.strategy,
          trade: s.trades,
        })
        .from(s.campaigns)
        .innerJoin(s.positions, eq(s.positions.campaignId, s.campaigns.id))
        .innerJoin(s.legs, eq(s.legs.positionId, s.positions.id))
        .innerJoin(s.trades, eq(s.trades.legId, s.legs.id))
        .where(eq(s.campaigns.accountId, account.id))
        .orderBy(s.legs.id, s.trades.tradeDate, s.trades.createdAt, s.trades.id);
      // closedOn cannot filter this read: partial closes realize cash on still-open positions.
      const legs = new Map<string, MonthlyPnlLeg & { trades: MonthlyPnlTrade[] }>();
      for (const { trade, ...fields } of rows) {
        const leg = legs.get(fields.legId) ?? { ...fields, trades: [] };
        leg.trades.push({
          id: trade.id,
          action: trade.action,
          date: parseIsoDate(trade.tradeDate),
          quantity: trade.quantity,
          cash: trade.cash,
          fees: trade.fees,
          rollId: trade.rollId,
        });
        legs.set(fields.legId, leg);
      }
      return aggregateMonthlyPnl([...legs.values()]);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

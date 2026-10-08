import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { divMoney4, mulMoney4, sumMoney4 } from "../domain/money.ts";
import { assignedShareBasis } from "../domain/wheel.ts";
import * as s from "./schema.ts";

export type NewTrade = Omit<typeof s.trades.$inferInsert, "legId">;
export type NewLeg = Omit<typeof s.legs.$inferInsert, "positionId"> & { trades: NewTrade[] };
export type NewPosition = Omit<typeof s.positions.$inferInsert, "closedOn"> & { legs: NewLeg[] };

export class CoveredStockConflictError extends Error {
  constructor() {
    super("Covered calls exceed stock balance");
  }
}

export function repository<HKT extends PgQueryResultHKT>(db: PgDatabase<HKT>) {
  async function appendTrades(positionId: string, events: (typeof s.trades.$inferInsert)[]) {
    return db.transaction(async (tx) => {
      // Assigned CC saves lock this same stock parent before reserving coverage.
      const [position] = await tx
        .select()
        .from(s.positions)
        .where(eq(s.positions.id, positionId))
        .for("update");
      if (!position) throw new Error("Position not found");
      const legs = await tx.select().from(s.legs).where(eq(s.legs.positionId, positionId));
      const ids = legs.map((leg) => leg.id);
      if (events.some((event) => !ids.includes(event.legId)))
        throw new Error("Trade leg is not in position");
      if (events.length) await tx.insert(s.trades).values(events);
      const trades = await tx
        .select()
        .from(s.trades)
        .where(inArray(s.trades.legId, ids))
        .orderBy(s.trades.tradeDate, s.trades.createdAt, s.trades.id);
      const balances = new Map(ids.map((id) => [id, 0]));
      let lastDate: string | null = null;
      for (const event of trades) {
        const balance =
          (balances.get(event.legId) ?? 0) +
          (event.action === "open" ? event.quantity : -event.quantity);
        if (balance < 0) throw new Error("Trade exceeds open leg quantity");
        balances.set(event.legId, balance);
        lastDate = event.tradeDate;
      }
      const closedOn =
        legs.length > 0 && [...balances.values()].every((balance) => balance === 0)
          ? lastDate
          : null;
      await tx.update(s.positions).set({ closedOn }).where(eq(s.positions.id, positionId));
      const stocks = legs.filter((leg) => leg.kind === "stock" && leg.side === "long");
      if (stocks.length) {
        const calls = await tx
          .select({ leg: s.legs })
          .from(s.legs)
          .innerJoin(s.positions, eq(s.legs.positionId, s.positions.id))
          .where(
            and(
              inArray(
                s.legs.coveredLegId,
                stocks.map((stock) => stock.id),
              ),
              eq(s.legs.kind, "call"),
              eq(s.legs.side, "short"),
              isNull(s.positions.closedOn),
            ),
          );
        const callTrades = calls.length
          ? await tx
              .select()
              .from(s.trades)
              .where(
                inArray(
                  s.trades.legId,
                  calls.map(({ leg }) => leg.id),
                ),
              )
          : [];
        for (const stock of stocks) {
          const covered = calls
            .filter(({ leg }) => leg.coveredLegId === stock.id)
            .reduce((shares, { leg }) => {
              const quantity = callTrades
                .filter((event) => event.legId === leg.id)
                .reduce(
                  (qty, event) =>
                    qty + (event.action === "open" ? event.quantity : -event.quantity),
                  0,
                );
              return shares + quantity * leg.multiplier;
            }, 0);
          if ((balances.get(stock.id) ?? 0) < covered) throw new CoveredStockConflictError();
        }
      }
      return closedOn;
    });
  }
  async function createPosition(input: NewPosition) {
    return db.transaction(async (tx) => {
      const { legs, ...fields } = input;
      const [position] = await tx.insert(s.positions).values(fields).returning();
      if (!position) throw new Error("Position insert returned no row");
      const events: (typeof s.trades.$inferInsert)[] = [];
      for (const { trades, ...fields } of legs) {
        const [leg] = await tx
          .insert(s.legs)
          .values({ ...fields, positionId: position.id })
          .returning();
        if (!leg) throw new Error("Leg insert returned no row");
        events.push(...trades.map((event) => ({ ...event, legId: leg.id })));
      }
      await repository(tx).appendTrades(position.id, events);
      return position.id;
    });
  }
  async function readOpenPositions(accountId: string) {
    const positions = await db
      .select({ position: s.positions })
      .from(s.positions)
      .innerJoin(s.campaigns, eq(s.positions.campaignId, s.campaigns.id))
      .where(and(eq(s.campaigns.accountId, accountId), isNull(s.positions.closedOn)))
      .orderBy(s.positions.id);
    return Promise.all(
      positions.map(async ({ position }) => {
        const legs = await db.select().from(s.legs).where(eq(s.legs.positionId, position.id));
        const trades = await db
          .select()
          .from(s.trades)
          .where(
            inArray(
              s.trades.legId,
              legs.map((leg) => leg.id),
            ),
          );
        const coveredLegId = legs.find((leg) => leg.coveredLegId !== null)?.coveredLegId;
        const stockFills = coveredLegId
          ? await db
              .select({
                price: s.trades.price,
                quantity: s.trades.quantity,
                premium: s.assignments.premiumPerShare,
              })
              .from(s.trades)
              .leftJoin(s.assignments, eq(s.assignments.stockTradeId, s.trades.id))
              .where(and(eq(s.trades.legId, coveredLegId), eq(s.trades.action, "open")))
          : [];
        if (coveredLegId && stockFills.length === 0)
          throw new Error("Covered stock leg has no opening fills");
        const coveredStock = coveredLegId
          ? {
              legId: coveredLegId,
              basis: divMoney4(
                sumMoney4(
                  stockFills.map((fill) =>
                    mulMoney4(
                      fill.premium === null
                        ? fill.price
                        : assignedShareBasis(fill.price, fill.premium),
                      fill.quantity,
                    ),
                  ),
                ),
                stockFills.reduce((sum, fill) => sum + fill.quantity, 0),
              ),
            }
          : null;
        return {
          ...position,
          coveredStock,
          legs: legs.map((leg) => ({
            ...leg,
            trades: trades.filter((event) => event.legId === leg.id),
          })),
        };
      }),
    );
  }
  async function recordHeartbeat(heartbeat: typeof s.platformHeartbeat.$inferInsert) {
    await db.insert(s.platformHeartbeat).values(heartbeat);
  }
  // Phase 1 is one book: a second account must be a deliberate decision, not a silent merge.
  async function readOpenBook() {
    const accounts = await db.select({ id: s.accounts.id }).from(s.accounts);
    if (accounts.length > 1)
      throw new Error("More than one account: the Sheet reads a single book");
    const [account] = accounts;
    return account ? readOpenPositions(account.id) : [];
  }
  return { createPosition, appendTrades, readOpenPositions, recordHeartbeat, readOpenBook };
}

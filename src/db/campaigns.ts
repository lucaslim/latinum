import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { CampaignMark, CampaignResponse, ManualMarkResponse } from "../domain/campaign.ts";
import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import type { Database } from "./database.ts";
import * as s from "./schema.ts";

export class ManualMarkConflictError extends Error {
  constructor() {
    super("Manual marks require an open swing leg");
  }
}

export class ManualMarkDateError extends Error {
  constructor() {
    super("Leg was not open on mark date");
  }
}

export function campaignRepository(db: Database) {
  async function readCampaign(id: string, asOf: IsoDate): Promise<CampaignResponse | null> {
    return db.transaction(
      async (tx) => {
        const accounts = await tx.select({ id: s.accounts.id }).from(s.accounts);
        if (accounts.length > 1)
          throw new Error("More than one account: campaigns read a single book");
        const [account] = accounts;
        if (!account) return null;
        const [campaign] = await tx
          .select()
          .from(s.campaigns)
          .where(and(eq(s.campaigns.id, id), eq(s.campaigns.accountId, account.id)));
        if (!campaign) return null;
        const positions = await tx
          .select()
          .from(s.positions)
          .where(eq(s.positions.campaignId, id))
          .orderBy(s.positions.openedOn, s.positions.id);
        const legs = await tx
          .select()
          .from(s.legs)
          .where(
            inArray(
              s.legs.positionId,
              positions.map((p) => p.id),
            ),
          )
          .orderBy(s.legs.id);
        const legIds = legs.map((l) => l.id);
        const trades = await tx
          .select()
          .from(s.trades)
          .where(inArray(s.trades.legId, legIds))
          .orderBy(s.trades.tradeDate, s.trades.createdAt, s.trades.id);
        const tradeIds = trades.map((t) => t.id);
        const assignments = await tx
          .select()
          .from(s.assignments)
          .where(
            or(
              inArray(s.assignments.optionTradeId, tradeIds),
              inArray(s.assignments.stockTradeId, tradeIds),
            ),
          )
          .orderBy(s.assignments.id);
        const marks = await tx
          .select()
          .from(s.marks)
          .where(and(inArray(s.marks.legId, legIds), lte(s.marks.asOf, asOf)))
          .orderBy(desc(s.marks.asOf), desc(sql`${s.marks.source} = 'manual'`), s.marks.legId);
        return {
          id: campaign.id,
          title: campaign.title,
          openedOn: parseIsoDate(campaign.openedOn),
          closedOn: campaign.closedOn === null ? null : parseIsoDate(campaign.closedOn),
          notes: campaign.notes,
          asOf,
          assignments,
          positions: positions.map((position) => ({
            id: position.id,
            underlying: position.underlying,
            strategy: position.strategy,
            role: position.role,
            openedOn: parseIsoDate(position.openedOn),
            closedOn: position.closedOn === null ? null : parseIsoDate(position.closedOn),
            notes: position.notes,
            tags: position.tags,
            legs: legs
              .filter((leg) => leg.positionId === position.id)
              .map((leg) => {
                const mark = marks.find((mark) => mark.legId === leg.id);
                return {
                  id: leg.id,
                  kind: leg.kind,
                  side: leg.side,
                  underlying: leg.underlying,
                  strike: leg.strike,
                  expiry: leg.expiry === null ? null : parseIsoDate(leg.expiry),
                  multiplier: leg.multiplier,
                  adjusted: leg.adjusted,
                  trades: trades
                    .filter((t) => t.legId === leg.id)
                    .map((t) => ({
                      id: t.id,
                      action: t.action,
                      tradeDate: parseIsoDate(t.tradeDate),
                      quantity: t.quantity,
                      price: t.price,
                      cash: t.cash,
                      fees: t.fees,
                    })),
                  mark: mark
                    ? {
                        asOf: parseIsoDate(mark.asOf),
                        price: mark.price,
                        source: mark.source === "manual" ? "manual" : "feed",
                      }
                    : null,
                };
              }),
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async function saveManualMark(
    legId: string,
    mark: CampaignMark & { source: "manual" },
  ): Promise<ManualMarkResponse | null> {
    return db.transaction(async (tx) => {
      // Lifecycle writes lock the position too, so a close cannot race this balance check.
      const [row] = await tx
        .select({ leg: s.legs, position: s.positions })
        .from(s.positions)
        .innerJoin(s.legs, eq(s.legs.positionId, s.positions.id))
        .where(eq(s.legs.id, legId))
        .for("update");
      if (!row) return null;
      if (row.position.closedOn !== null) throw new ManualMarkConflictError();
      if (row.position.role !== "swing") {
        // Held-cover history stays a CC; only its surviving, uncovered stock becomes a swing.
        if (row.position.strategy !== "cc" || row.leg.kind !== "stock" || row.leg.side !== "long")
          throw new ManualMarkConflictError();
        const options = await tx
          .select()
          .from(s.legs)
          .where(
            and(
              eq(s.legs.positionId, row.position.id),
              or(eq(s.legs.kind, "put"), eq(s.legs.kind, "call")),
            ),
          );
        const optionTrades = await tx
          .select()
          .from(s.trades)
          .where(
            inArray(
              s.trades.legId,
              options.map((leg) => leg.id),
            ),
          );
        if (
          options.some(
            (leg) =>
              optionTrades
                .filter((t) => t.legId === leg.id)
                .reduce((n, t) => n + (t.action === "open" ? t.quantity : -t.quantity), 0) !== 0,
          )
        )
          throw new ManualMarkConflictError();
      }
      const trades = await tx.select().from(s.trades).where(eq(s.trades.legId, legId));
      const balance = trades.reduce(
        (n, t) => n + (t.action === "open" ? t.quantity : -t.quantity),
        0,
      );
      if (balance <= 0) throw new ManualMarkConflictError();
      const historicalBalance = trades
        .filter((t) => t.tradeDate <= mark.asOf)
        .reduce((n, t) => n + (t.action === "open" ? t.quantity : -t.quantity), 0);
      if (historicalBalance <= 0) throw new ManualMarkDateError();
      await tx
        .insert(s.marks)
        .values({ legId, asOf: mark.asOf, price: mark.price, source: "manual" })
        .onConflictDoUpdate({
          target: [s.marks.legId, s.marks.asOf, s.marks.source],
          set: { price: mark.price },
        });
      return { legId, asOf: mark.asOf, price: mark.price, source: "manual" };
    });
  }
  return { readCampaign, saveManualMark };
}

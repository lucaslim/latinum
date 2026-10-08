import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { RollInput, RollResponse } from "../contracts/roll.ts";
import { formatMoney4, mulMoney4, negMoney4 } from "../domain/money.ts";
import { rollMetrics } from "../domain/roll.ts";
import { createPositionSchema } from "../shared/trade.ts";
import type { Database } from "./database.ts";
import {
  LifecycleConflictError,
  LifecycleValidationError,
  lifecycleRepository,
  StalePositionRevisionError,
} from "./lifecycle.ts";
import { positionRevision } from "./positionRevision.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";

type Leg = typeof s.legs.$inferSelect;
type Trade = typeof s.trades.$inferSelect;
const balance = (events: Trade[]) =>
  events.reduce((qty, t) => qty + (t.action === "open" ? t.quantity : -t.quantity), 0);
function invalid(message: string): never {
  throw new LifecycleValidationError(message);
}

export function rollRepository(db: Database) {
  async function rollPosition(input: RollInput): Promise<RollResponse | null> {
    return db.transaction(async (tx) => {
      // T6 creates and edits acquire the book lock before any position lock.
      const accounts = await tx.select().from(s.accounts).for("update");
      if (accounts.length > 1) throw new LifecycleConflictError("Roll requires a single account");
      const [account] = accounts;
      if (!account) return null;
      const [position] = await tx
        .select()
        .from(s.positions)
        .where(eq(s.positions.id, input.positionId))
        .for("update");
      if (!position) return null;
      const [campaign] = await tx
        .select()
        .from(s.campaigns)
        .where(eq(s.campaigns.id, position.campaignId));
      if (!campaign || campaign.accountId !== account.id)
        throw new LifecycleConflictError("Position campaign is outside the single account");
      const legs = await tx.select().from(s.legs).where(eq(s.legs.positionId, position.id));
      const trades = legs.length
        ? await tx
            .select()
            .from(s.trades)
            .where(
              inArray(
                s.trades.legId,
                legs.map((l) => l.id),
              ),
            )
        : [];
      if (positionRevision(position, legs, trades) !== input.expectedRevision)
        throw new StalePositionRevisionError();
      if (position.strategy === "stock" || position.strategy === "day_trade")
        invalid("Stock and day trade positions cannot roll");
      const options = legs.filter(
        (l) => l.kind !== "stock" && balance(trades.filter((t) => t.legId === l.id)) > 0,
      );
      if (position.closedOn !== null || options.length === 0)
        throw new LifecycleConflictError("Position has no open option quantity to roll");
      if (
        input.fills.length !== options.length ||
        new Set(input.fills.map((f) => f.legId)).size !== options.length ||
        input.fills.some((f) => !options.some((l) => l.id === f.legId))
      )
        invalid("Every open option leg requires exactly one roll fill and no other legs");
      const kind =
        position.strategy === "csp" ||
        position.strategy === "long_put" ||
        position.strategy.startsWith("put_")
          ? "put"
          : "call";
      const spread = position.strategy.endsWith("_spread");
      const side = position.strategy.startsWith("long_") ? "long" : "short";
      if (
        options.length !== (spread ? 2 : 1) ||
        options.some((l) => l.kind !== kind || l.underlying !== position.underlying) ||
        (spread ? new Set(options.map((l) => l.side)).size !== 2 : options[0]?.side !== side)
      )
        invalid("Source option legs do not match position strategy and underlying");
      const qty = (leg: Leg) => balance(trades.filter((t) => t.legId === leg.id));
      const first = options[0];
      if (!first) throw new Error("Roll options missing");
      if (
        options.some(
          (l) =>
            qty(l) !== qty(first) || l.multiplier !== first.multiplier || l.expiry !== first.expiry,
        )
      )
        invalid("Spread roll requires balanced quantities, multipliers and expiries");
      if (
        options.some((l) => l.expiry === null || input.expiry <= l.expiry) ||
        input.expiry <= input.tradeDate
      )
        invalid("Roll expiry must be after current option expiry and trade date");
      const replacements = input.fills.map((fill) => {
        const leg = options.find((l) => l.id === fill.legId);
        if (!leg) throw new Error("Roll leg mapping missing");
        const quantity = qty(leg);
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2147483647)
          invalid("Open quantity exceeds database integer bounds");
        const units = quantity * leg.multiplier;
        if (
          !Number.isSafeInteger(units) ||
          BigInt(fill.openPrice) * BigInt(units) > 99999999999999n
        )
          invalid("Opening cash exceeds storage precision");
        const cash = mulMoney4(fill.openPrice, units * (leg.side === "short" ? 1 : -1));
        return { leg, fill, quantity, cash };
      });
      const base = {
        strategy: position.strategy,
        underlying: position.underlying,
        openedOn: input.tradeDate,
        expiry: input.expiry,
        quantity: qty(first),
        adjusted: options.some((l) => l.adjusted),
        tags: [],
      };
      const candidateFill = (side: Leg["side"]) => {
        const r = replacements.find((r) => r.leg.side === side);
        if (!r) throw new Error("Replacement side missing");
        return {
          strike: formatMoney4(r.fill.strike),
          price: formatMoney4(r.fill.openPrice),
          fees: formatMoney4(negMoney4(r.fill.openFees)),
        };
      };
      let coveredLegId: string | null = null;
      if (position.strategy === "cc") {
        coveredLegId =
          first.coveredLegId ??
          legs.find((l) => l.kind === "stock" && l.side === "long")?.id ??
          null;
        if (!coveredLegId) invalid("Covered call has no backing stock");
        const [stock] = await tx.select().from(s.legs).where(eq(s.legs.id, coveredLegId));
        if (
          stock?.kind !== "stock" ||
          stock.side !== "long" ||
          stock.underlying !== position.underlying
        )
          invalid("Covered stock does not match rolled call");
        await tx
          .select()
          .from(s.positions)
          .where(eq(s.positions.id, stock.positionId))
          .for("update");
        const [stockPosition] = await tx
          .select()
          .from(s.positions)
          .where(eq(s.positions.id, stock.positionId));
        if (!stockPosition || stockPosition.campaignId !== position.campaignId)
          invalid("Covered stock must belong to the same campaign");
        const stockTrades = await tx.select().from(s.trades).where(eq(s.trades.legId, stock.id));
        const calls = await tx
          .select()
          .from(s.legs)
          .where(and(eq(s.legs.coveredLegId, stock.id), ne(s.legs.id, first.id)));
        const callEvents = calls.length
          ? await tx
              .select()
              .from(s.trades)
              .where(
                inArray(
                  s.trades.legId,
                  calls.map((l) => l.id),
                ),
              )
          : [];
        const required = calls.reduce(
          (n, l) =>
            n + BigInt(balance(callEvents.filter((t) => t.legId === l.id))) * BigInt(l.multiplier),
          BigInt(qty(first)) * BigInt(first.multiplier),
        );
        if (BigInt(balance(stockTrades)) < required)
          throw new LifecycleConflictError("Covered calls exceed stock balance");
      }
      const candidate = spread
        ? {
            ...base,
            short: candidateFill("short"),
            long: candidateFill("long"),
            ...(position.role === "income" ? {} : { role: position.role }),
          }
        : {
            ...base,
            ...candidateFill(first.side),
            ...(position.strategy === "cc"
              ? { cover: { kind: "assigned", stockLegId: coveredLegId } }
              : position.role === "income"
                ? {}
                : { role: position.role }),
          };
      const parsed = createPositionSchema.safeParse(candidate);
      if (!parsed.success) invalid(parsed.error.issues.map((i) => i.message).join("; "));
      // Closing must compare the original revision before the source gains its chain link.
      const closed = await lifecycleRepository(tx).closePosition(position.id, {
        expectedRevision: input.expectedRevision,
        tradeDate: input.tradeDate,
        fills: replacements.map((r) => ({
          legId: r.leg.id,
          quantity: r.quantity,
          price: r.fill.closePrice,
          fees: r.fill.closeFees,
        })),
      });
      if (!closed) throw new Error("Locked roll source disappeared");
      const rollChainId = position.rollChainId ?? randomUUID();
      if (position.rollChainId === null)
        await tx.insert(s.rollChains).values({ id: rollChainId, campaignId: position.campaignId });
      else {
        const [chain] = await tx
          .select()
          .from(s.rollChains)
          .where(eq(s.rollChains.id, rollChainId));
        if (!chain || chain.campaignId !== position.campaignId)
          invalid("Roll chain belongs to another campaign");
      }
      const rollId = randomUUID();
      await tx.insert(s.rolls).values({ id: rollId, rollChainId, rolledOn: input.tradeDate });
      await tx.update(s.positions).set({ rollChainId }).where(eq(s.positions.id, position.id));
      // Only new closes are tagged: source openings may belong to the previous roll.
      await tx.update(s.trades).set({ rollId }).where(inArray(s.trades.id, closed.tradeIds));
      const newPositionId = randomUUID();
      const openingIds = replacements.map(() => randomUUID());
      await repository(tx).createPosition({
        id: newPositionId,
        campaignId: position.campaignId,
        rollChainId,
        underlying: position.underlying,
        strategy: position.strategy,
        role: position.role,
        openedOn: input.tradeDate,
        tags: position.tags,
        notes: position.notes,
        legs: replacements.map((r, i) => ({
          id: randomUUID(),
          kind: r.leg.kind,
          side: r.leg.side,
          underlying: r.leg.underlying,
          strike: r.fill.strike,
          expiry: input.expiry,
          multiplier: r.leg.multiplier,
          adjusted: r.leg.adjusted,
          coveredLegId: position.strategy === "cc" ? coveredLegId : r.leg.coveredLegId,
          trades: [
            {
              id: openingIds[i],
              action: "open",
              tradeDate: input.tradeDate,
              quantity: r.quantity,
              price: r.fill.openPrice,
              cash: r.cash,
              fees: r.fill.openFees,
              rollId,
              source: "manual",
            },
          ],
        })),
      });
      const closing = await tx.select().from(s.trades).where(inArray(s.trades.id, closed.tradeIds));
      // Stock is coverage, not option roll cash; never count its purchase in a chain.
      const chain = await tx
        .select({ cash: s.trades.cash, fees: s.trades.fees })
        .from(s.trades)
        .innerJoin(s.legs, eq(s.trades.legId, s.legs.id))
        .innerJoin(s.positions, eq(s.legs.positionId, s.positions.id))
        .where(and(eq(s.positions.rollChainId, rollChainId), ne(s.legs.kind, "stock")));
      return {
        ...closed,
        tradeIds: [...closed.tradeIds, ...openingIds],
        newPositionId,
        rollId,
        rollChainId,
        metrics: rollMetrics(
          closed.realized,
          closing,
          replacements.map((r) => ({ cash: r.cash, fees: r.fill.openFees })),
          chain,
        ),
      };
    });
  }
  return { rollPosition };
}

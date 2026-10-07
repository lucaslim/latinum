import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { parseIsoDate } from "../domain/dates.ts";
import {
  divMoney4,
  formatMoney4,
  mulMoney4,
  negMoney4,
  parseMoney4,
  sumMoney4,
} from "../domain/money.ts";
import { bookTotals } from "../domain/totals.ts";
import { assignedShareBasis } from "../domain/wheel.ts";
import {
  type AssignedStockOption,
  type CreatePositionRequest,
  type CreatePositionResponse,
  createPositionSchema,
  type ManualTradesResponse,
  type PatchTradeRequest,
  type PatchTradeResponse,
  type TradeFormOptions,
} from "../shared/trade.ts";
import { toBookPositions } from "./book.ts";
import type { Database } from "./database.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";

export class TradeWriteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const MANUAL_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
type Leg = typeof s.legs.$inferSelect;
type Trade = typeof s.trades.$inferSelect;
type StoredPosition = typeof s.positions.$inferSelect;

function balance(trades: Trade[]) {
  return trades.reduce((qty, t) => qty + (t.action === "open" ? t.quantity : -t.quantity), 0);
}

async function accountId(db: Database) {
  let accounts = await db.select().from(s.accounts);
  if (accounts.length === 0) {
    // A stable ID makes simultaneous first saves converge on the same manual book.
    await db
      .insert(s.accounts)
      .values({
        id: MANUAL_ACCOUNT_ID,
        label: "Manual",
        broker: "manual",
      })
      .onConflictDoNothing();
    accounts = await db.select().from(s.accounts);
  }
  if (accounts.length !== 1) throw new Error("Trade entry requires exactly one account");
  const [account] = accounts;
  if (!account) throw new Error("Manual account insert returned no account");
  // Serializes book-range checks as well as creates against edits, before any position lock.
  await db
    .select({ id: s.accounts.id })
    .from(s.accounts)
    .where(eq(s.accounts.id, account.id))
    .for("update");
  return account.id;
}

async function coverage(db: Database, stockLegId: string) {
  const [stock] = await db
    .select({ leg: s.legs, position: s.positions })
    .from(s.legs)
    .innerJoin(s.positions, eq(s.legs.positionId, s.positions.id))
    .where(and(eq(s.legs.id, stockLegId), eq(s.legs.kind, "stock"), eq(s.legs.side, "long")));
  if (!stock) return null;
  const events = await db.select().from(s.trades).where(eq(s.trades.legId, stockLegId));
  const assigned = await db
    .select({ assignment: s.assignments, trade: s.trades })
    .from(s.assignments)
    .innerJoin(s.trades, eq(s.assignments.stockTradeId, s.trades.id))
    .where(eq(s.trades.legId, stockLegId));
  if (
    assigned.length === 0 ||
    events.some((t) => t.action === "open" && !assigned.some((a) => a.trade.id === t.id))
  )
    return null;
  const calls = await db.select().from(s.legs).where(eq(s.legs.coveredLegId, stockLegId));
  const callEvents = calls.length
    ? await db
        .select()
        .from(s.trades)
        .where(
          inArray(
            s.trades.legId,
            calls.map((l) => l.id),
          ),
        )
    : [];
  const covered = calls.reduce(
    (shares, leg) =>
      shares + balance(callEvents.filter((t) => t.legId === leg.id)) * leg.multiplier,
    0,
  );
  const shares = assigned.reduce((qty, a) => qty + a.assignment.shares, 0);
  const basis = divMoney4(
    sumMoney4(
      assigned.map((a) =>
        mulMoney4(
          assignedShareBasis(a.trade.price, a.assignment.premiumPerShare),
          a.assignment.shares,
        ),
      ),
    ),
    shares,
  );
  const assignedOn = assigned
    .map((a) => a.trade.tradeDate)
    .sort()
    .at(-1);
  if (!assignedOn) throw new Error("Assignment has no trading date");
  return {
    campaignId: stock.position.campaignId,
    positionId: stock.position.id,
    option: {
      legId: stockLegId,
      underlying: stock.leg.underlying,
      uncoveredShares: balance(events) - covered,
      basis,
      assignedOn: parseIsoDate(assignedOn),
    } satisfies AssignedStockOption,
  };
}

function opening(
  leg: Leg,
  input: CreatePositionRequest,
  price: string,
  fees: string,
  quantity: number,
): typeof s.trades.$inferInsert {
  const amount = parseMoney4(price);
  const cash = mulMoney4(amount, quantity * leg.multiplier * (leg.side === "long" ? -1 : 1));
  return {
    id: randomUUID(),
    legId: leg.id,
    action: "open",
    tradeDate: input.openedOn,
    quantity,
    price: amount,
    cash,
    fees: negMoney4(parseMoney4(fees)),
    source: "manual",
  };
}

function candidate(position: StoredPosition, legs: Leg[], trades: Trade[]): CreatePositionRequest {
  const base = {
    underlying: position.underlying,
    openedOn: position.openedOn,
    tags: position.tags,
    notes: position.notes ?? undefined,
  };
  function fill(kind: Leg["kind"], side: Leg["side"]) {
    const leg = legs.find((l) => l.kind === kind && l.side === side);
    if (!leg) throw new Error(`Missing ${side} ${kind} leg`);
    const trade = trades.find((t) => t.legId === leg.id);
    if (!trade) throw new Error("Missing opening fill");
    return {
      leg,
      trade,
      price: formatMoney4(trade.price),
      fees: formatMoney4(negMoney4(trade.fees)),
    };
  }
  if (position.strategy === "stock" || position.strategy === "day_trade") {
    const stock = fill("stock", "long");
    return createPositionSchema.parse({
      ...base,
      strategy: position.strategy,
      shares: stock.trade.quantity,
      price: stock.price,
      fees: stock.fees,
    });
  }
  const kind =
    position.strategy.startsWith("put_") ||
    position.strategy === "csp" ||
    position.strategy === "long_put"
      ? "put"
      : "call";
  if (position.strategy.endsWith("spread")) {
    const short = fill(kind, "short");
    const long = fill(kind, "long");
    const legInput = (f: ReturnType<typeof fill>) => {
      if (f.leg.strike === null) throw new Error("Option has no strike");
      return { strike: formatMoney4(f.leg.strike), price: f.price, fees: f.fees };
    };
    return createPositionSchema.parse({
      ...base,
      strategy: position.strategy,
      expiry: short.leg.expiry,
      quantity: short.trade.quantity,
      adjusted: short.leg.adjusted,
      short: legInput(short),
      long: legInput(long),
      ...(position.role === "income" ? {} : { role: position.role }),
    });
  }
  const option = fill(kind, position.strategy.startsWith("long_") ? "long" : "short");
  if (option.leg.strike === null) throw new Error("Option has no strike");
  const common = {
    ...base,
    strategy: position.strategy,
    expiry: option.leg.expiry,
    quantity: option.trade.quantity,
    adjusted: option.leg.adjusted,
    strike: formatMoney4(option.leg.strike),
    price: option.price,
    fees: option.fees,
  };
  if (position.strategy === "cc") {
    const cover = option.leg.coveredLegId
      ? { kind: "assigned", stockLegId: option.leg.coveredLegId }
      : { kind: "held", basis: fill("stock", "long").price };
    return createPositionSchema.parse({ ...common, cover });
  }
  return createPositionSchema.parse({
    ...common,
    ...(position.role === "income" ? {} : { role: position.role }),
  });
}

async function editState(db: Database, position: StoredPosition, legs: Leg[], trades: Trade[]) {
  const ids = trades.map((t) => t.id);
  const linked = ids.length
    ? await db
        .select({ id: s.assignments.id })
        .from(s.assignments)
        .where(
          or(inArray(s.assignments.optionTradeId, ids), inArray(s.assignments.stockTradeId, ids)),
        )
    : [];
  // Economic changes to lifecycle-linked fills would invalidate recorded wheel/roll accounting.
  return (
    position.closedOn === null &&
    position.rollChainId === null &&
    linked.length === 0 &&
    trades.every((t) => t.action === "open" && t.rollId === null && t.source === "manual") &&
    legs.every((l) => trades.filter((t) => t.legId === l.id).length === 1)
  );
}

export function tradeRepository(db: Database) {
  async function create(input: CreatePositionRequest): Promise<CreatePositionResponse> {
    return db.transaction(async (tx) => {
      const account = await accountId(tx);
      let campaignId: string = randomUUID();
      let coveredLegId: string | null = null;
      if (input.strategy === "cc" && input.cover.kind === "assigned") {
        const [stock] = await tx.select().from(s.legs).where(eq(s.legs.id, input.cover.stockLegId));
        if (!stock) throw new TradeWriteError("Assigned stock not found", 409);
        // Every covering save serializes on the stock's parent before reading live balances.
        await tx
          .select()
          .from(s.positions)
          .where(eq(s.positions.id, stock.positionId))
          .for("update");
        const available = await coverage(tx, stock.id);
        if (
          !available ||
          available.option.underlying !== input.underlying ||
          input.openedOn < available.option.assignedOn ||
          available.option.uncoveredShares < input.quantity * 100
        ) {
          throw new TradeWriteError("Assigned stock is unavailable for this covered call", 409);
        }
        const [campaign] = await tx
          .select()
          .from(s.campaigns)
          .where(eq(s.campaigns.id, available.campaignId));
        if (!campaign) throw new Error("Stock campaign not found");
        if (campaign.accountId !== account)
          throw new TradeWriteError("Assigned stock belongs to another account", 409);
        campaignId = available.campaignId;
        coveredLegId = stock.id;
      } else {
        await tx.insert(s.campaigns).values({
          id: campaignId,
          accountId: account,
          title: input.underlying,
          openedOn: input.openedOn,
          notes: input.notes,
        });
      }
      const positionId = randomUUID();
      const role =
        "role" in input
          ? input.role
          : input.strategy === "stock" || input.strategy === "day_trade"
            ? "swing"
            : "income";
      await tx.insert(s.positions).values({
        id: positionId,
        campaignId,
        underlying: input.underlying,
        strategy: input.strategy,
        role,
        openedOn: input.openedOn,
        tags: input.tags,
        notes: input.notes,
      });
      async function add(
        kind: Leg["kind"],
        side: Leg["side"],
        price: string,
        fees: string,
        quantity: number,
        strike: string | null,
        cover: string | null = null,
      ) {
        const leg: Leg = {
          id: randomUUID(),
          positionId,
          underlying: input.underlying,
          kind,
          side,
          strike: strike === null ? null : parseMoney4(strike),
          expiry: kind === "stock" ? null : "expiry" in input ? input.expiry : null,
          multiplier: kind === "stock" ? 1 : 100,
          adjusted: "adjusted" in input && input.adjusted,
          coveredLegId: cover,
        };
        await tx.insert(s.legs).values(leg);
        await tx.insert(s.trades).values(opening(leg, input, price, fees, quantity));
      }
      if ("shares" in input) {
        await add("stock", "long", input.price, input.fees, input.shares, null);
      } else if ("short" in input) {
        const kind = input.strategy.startsWith("put_") ? "put" : "call";
        await add(
          kind,
          "short",
          input.short.price,
          input.short.fees,
          input.quantity,
          input.short.strike,
        );
        await add(
          kind,
          "long",
          input.long.price,
          input.long.fees,
          input.quantity,
          input.long.strike,
        );
      } else {
        if (input.strategy === "cc" && input.cover.kind === "held")
          await add("stock", "long", input.cover.basis, "0", input.quantity * 100, null);
        const kind = input.strategy === "csp" || input.strategy === "long_put" ? "put" : "call";
        await add(
          kind,
          input.strategy.startsWith("long_") ? "long" : "short",
          input.price,
          input.fees,
          input.quantity,
          input.strike,
          coveredLegId,
        );
      }
      bookTotals(toBookPositions(await repository(tx).readOpenBook()));
      return { positionId, campaignId };
    });
  }

  async function patch(id: string, input: PatchTradeRequest): Promise<PatchTradeResponse> {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({ trade: s.trades, leg: s.legs })
        .from(s.trades)
        .innerJoin(s.legs, eq(s.trades.legId, s.legs.id))
        .where(eq(s.trades.id, id));
      if (!target) throw new TradeWriteError("Trade not found", 404);
      await accountId(tx);
      const [position] = await tx
        .select()
        .from(s.positions)
        .where(eq(s.positions.id, target.leg.positionId))
        .for("update");
      if (!position) throw new TradeWriteError("Position not found", 404);
      const legs = await tx.select().from(s.legs).where(eq(s.legs.positionId, position.id));
      const trades = await tx
        .select()
        .from(s.trades)
        .where(
          inArray(
            s.trades.legId,
            legs.map((l) => l.id),
          ),
        );
      if (!(await editState(tx, position, legs, trades)))
        throw new TradeWriteError("Trade is read-only", 409);
      const trade = trades.find((t) => t.id === id);
      if (!trade) throw new TradeWriteError("Trade not found", 404);
      const price = input.price === undefined ? trade.price : parseMoney4(input.price);
      const fees = input.fees === undefined ? trade.fees : negMoney4(parseMoney4(input.fees));
      const updated = { ...trade, price, fees };
      // Reuse the create contract rather than relaxing spread, positivity or storage bounds on edit.
      const current = candidate(position, legs, trades);
      const next = candidateInput(current, target.leg, updated);
      const parsed = createPositionSchema.safeParse(next);
      if (!parsed.success)
        throw new TradeWriteError(parsed.error.issues.map((i) => i.message).join("; "), 400);
      const cash = mulMoney4(
        price,
        trade.quantity * target.leg.multiplier * (target.leg.side === "long" ? -1 : 1),
      );
      await tx.update(s.trades).set({ price, fees, cash }).where(eq(s.trades.id, id));
      bookTotals(toBookPositions(await repository(tx).readOpenBook()));
      return { id };
    });
  }

  async function options(): Promise<TradeFormOptions> {
    const positions = await db.select().from(s.positions);
    const stocks = await db
      .select({ id: s.legs.id })
      .from(s.legs)
      .where(and(eq(s.legs.kind, "stock"), eq(s.legs.side, "long")));
    const assigned = await Promise.all(stocks.map((stock) => coverage(db, stock.id)));
    return {
      tickers: [...new Set(positions.map((p) => p.underlying))].sort(),
      tags: [...new Set(positions.flatMap((p) => p.tags))].sort(),
      assignedStock: assigned.flatMap((stock) =>
        stock && stock.option.uncoveredShares > 0 ? [stock.option] : [],
      ),
    };
  }

  async function manualTrades(positionId: string): Promise<ManualTradesResponse> {
    const [position] = await db.select().from(s.positions).where(eq(s.positions.id, positionId));
    if (!position) throw new TradeWriteError("Position not found", 404);
    const legs = await db.select().from(s.legs).where(eq(s.legs.positionId, positionId));
    const trades = legs.length
      ? await db
          .select()
          .from(s.trades)
          .where(
            inArray(
              s.trades.legId,
              legs.map((l) => l.id),
            ),
          )
          .orderBy(s.trades.tradeDate, s.trades.id)
      : [];
    const editable = await editState(db, position, legs, trades);
    return {
      positionId,
      trades: trades.map((trade) => {
        const leg = legs.find((l) => l.id === trade.legId);
        if (!leg) throw new Error("Trade leg not found");
        return {
          id: trade.id,
          legId: leg.id,
          kind: leg.kind,
          side: leg.side,
          strike: leg.strike,
          expiry: leg.expiry === null ? null : parseIsoDate(leg.expiry),
          tradeDate: parseIsoDate(trade.tradeDate),
          quantity: trade.quantity,
          price: trade.price,
          fees: trade.fees,
          editable,
        };
      }),
    };
  }
  return { create, patch, options, manualTrades };
}

function candidateInput(current: CreatePositionRequest, leg: Leg, trade: Trade) {
  const fill = { price: formatMoney4(trade.price), fees: formatMoney4(negMoney4(trade.fees)) };
  if ("short" in current) {
    const side = leg.side;
    return { ...current, [side]: { ...current[side], ...fill } };
  }
  if (current.strategy === "cc" && leg.kind === "stock")
    return { ...current, cover: { kind: "held", basis: fill.price } };
  return { ...current, ...fill };
}

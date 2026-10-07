import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type {
  AssignInput,
  CloseInput,
  ExpireInput,
  LifecycleResponse,
  LinkHedgeRequest,
  LinkHedgeResponse,
} from "../contracts/lifecycle.ts";
import { type IsoDate, parseIsoDate } from "../domain/dates.ts";
import { allocateRealizedTrades } from "../domain/lifecyclePnl.ts";
import type { RealizedAllocation } from "../domain/lifecycleTypes.ts";
import { divMoney4, type Money4, subMoney4 } from "../domain/money.ts";
import type { Database } from "./database.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";

export class LifecycleValidationError extends Error {
  readonly status = 400;
}
export class LifecycleConflictError extends Error {
  readonly status = 409;
}

type StoredTrade = typeof s.trades.$inferSelect;
type Event = typeof s.trades.$inferInsert &
  Pick<StoredTrade, "id" | "fees" | "source" | "createdAt">;
const ZERO = 0 as Money4;
const MAX_PRICE = 999999999999;
const MAX_CASH = 99999999999999;
const MAX_QUANTITY = 2147483647;

function quantity(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_QUANTITY)
    throw new LifecycleValidationError("Quantity must be a positive Postgres integer");
  return value;
}
function money(value: Money4, maximum: number, minimum: number, name: string) {
  if (!Number.isSafeInteger(value) || value > maximum || value < minimum)
    throw new LifecycleValidationError(`${name} exceeds numeric storage precision or sign bounds`);
  return value;
}
function cashFor(price: Money4, qty: number, multiplier: number, sign: 1 | -1) {
  quantity(qty);
  quantity(multiplier);
  const units = qty * multiplier;
  if (!Number.isSafeInteger(units))
    throw new LifecycleValidationError("Quantity times multiplier exceeds safe integer range");
  const cash = BigInt(price) * BigInt(units) * BigInt(sign);
  if (cash > BigInt(MAX_CASH) || cash < -BigInt(MAX_CASH))
    throw new LifecycleValidationError("Cash exceeds numeric storage precision");
  return Number(cash) as Money4;
}
function allocations(trades: readonly (StoredTrade | Event)[]): RealizedAllocation[] {
  return allocateRealizedTrades(
    trades.map((t) => ({
      id: t.id,
      action: t.action,
      date: parseIsoDate(t.tradeDate),
      quantity: t.quantity,
      cash: t.cash,
      fees: t.fees,
    })),
  );
}

async function snapshot(db: Database, id: string) {
  const accounts = await db.select({ id: s.accounts.id }).from(s.accounts);
  if (accounts.length > 1) throw new LifecycleConflictError("Lifecycle requires a single account");
  const [account] = accounts;
  if (!account) return null;
  // Matches manual-mark and append-trade locking: eligibility and balances cannot race a close.
  const [position] = await db
    .select()
    .from(s.positions)
    .where(eq(s.positions.id, id))
    .for("update");
  if (!position) return null;
  const [campaign] = await db
    .select()
    .from(s.campaigns)
    .where(eq(s.campaigns.id, position.campaignId));
  if (!campaign || campaign.accountId !== account.id)
    throw new LifecycleConflictError("Position campaign is outside the single account");
  const legs = await db.select().from(s.legs).where(eq(s.legs.positionId, id));
  const trades = await db
    .select()
    .from(s.trades)
    .where(
      inArray(
        s.trades.legId,
        legs.map((leg) => leg.id),
      ),
    )
    .orderBy(s.trades.tradeDate, s.trades.createdAt, s.trades.id);
  const balances = new Map<string, number>();
  for (const leg of legs) {
    const events = trades.filter((t) => t.legId === leg.id);
    allocations(events);
    const balance = events.reduce(
      (n, t) => n + (t.action === "open" ? t.quantity : -t.quantity),
      0,
    );
    if (!Number.isSafeInteger(balance))
      throw new LifecycleConflictError("Existing leg quantity exceeds safe integer range");
    balances.set(leg.id, balance);
  }
  // A savepoint shares its transaction timestamp with an earlier open. Force append ordering
  // even then, rather than allowing random UUID order to put the close before its opening.
  const createdAt = new Date(Math.max(Date.now(), ...trades.map((t) => t.createdAt.getTime())) + 1);
  return { position, campaign, legs, trades, balances, createdAt };
}
type Snapshot = NonNullable<Awaited<ReturnType<typeof snapshot>>>;

function checkDate(state: Snapshot, date: IsoDate) {
  if (date < state.position.openedOn || state.trades.some((t) => date < t.tradeDate))
    throw new LifecycleValidationError(
      "Trade date cannot precede opening or the latest position trade",
    );
}
function requireOpen(state: Snapshot) {
  if (state.position.closedOn !== null || ![...state.balances.values()].some((n) => n > 0))
    throw new LifecycleConflictError("Position has no open quantity");
}
function event(
  state: Snapshot,
  legId: string,
  action: Event["action"],
  date: IsoDate,
  qty: number,
  price: Money4,
  cash: Money4,
  fees: Money4,
): Event {
  return {
    id: randomUUID(),
    legId,
    action,
    tradeDate: date,
    quantity: quantity(qty),
    price: money(price, MAX_PRICE, 0, "Price"),
    cash: money(cash, MAX_CASH, -MAX_CASH, "Cash"),
    fees: money(fees, 0, -MAX_CASH, "Fees"),
    source: "manual",
    createdAt: state.createdAt,
  };
}
function closingAllocations(state: Snapshot, events: Event[]) {
  const ids = new Set(events.map((t) => t.id));
  return state.legs.flatMap((leg) =>
    allocations([
      ...state.trades.filter((t) => t.legId === leg.id),
      ...events.filter((t) => t.legId === leg.id),
    ]).filter((a) => ids.has(a.tradeId)),
  );
}
async function append(db: Database, state: Snapshot, events: Event[]): Promise<LifecycleResponse> {
  const realized = closingAllocations(state, events);
  const closedOn = await repository(db).appendTrades(state.position.id, events);
  return {
    positionId: state.position.id,
    campaignId: state.campaign.id,
    closedOn: closedOn === null ? null : parseIsoDate(closedOn),
    tradeIds: events.map((t) => t.id),
    realized,
  };
}

export function lifecycleRepository(db: Database) {
  async function closePosition(id: string, input: CloseInput): Promise<LifecycleResponse | null> {
    return db.transaction(async (tx) => {
      const state = await snapshot(tx, id);
      if (!state) return null;
      requireOpen(state);
      checkDate(state, input.tradeDate);
      if (input.fills.length === 0)
        throw new LifecycleValidationError("Close requires at least one leg fill");
      const seen = new Set<string>();
      const events = input.fills.map((fill) => {
        if (seen.has(fill.legId))
          throw new LifecycleValidationError("Duplicate leg in close fills");
        seen.add(fill.legId);
        const leg = state.legs.find((l) => l.id === fill.legId);
        if (!leg) throw new LifecycleValidationError("Close leg does not belong to position");
        quantity(fill.quantity);
        if (fill.quantity > (state.balances.get(leg.id) ?? 0))
          throw new LifecycleConflictError("Close quantity exceeds open leg quantity");
        money(fill.price, MAX_PRICE, 0, "Price");
        return event(
          state,
          leg.id,
          "close",
          input.tradeDate,
          fill.quantity,
          fill.price,
          cashFor(fill.price, fill.quantity, leg.multiplier, leg.side === "short" ? -1 : 1),
          fill.fees,
        );
      });
      const remaining = new Map(state.balances);
      for (const fill of events)
        remaining.set(fill.legId, (remaining.get(fill.legId) ?? 0) - fill.quantity);
      // The book represents a spread with one quantity, not independent residual legs.
      if (state.position.strategy.endsWith("_spread")) {
        const long = state.legs.find((leg) => leg.side === "long");
        const short = state.legs.find((leg) => leg.side === "short");
        if (!long || !short || remaining.get(long.id) !== remaining.get(short.id))
          throw new LifecycleValidationError(
            "Spread close must leave equal open quantities on both legs",
          );
      }
      if (state.position.strategy === "cc") {
        const shares = state.legs
          .filter((leg) => leg.kind === "stock" && leg.side === "long")
          .reduce((n, leg) => n + BigInt(remaining.get(leg.id) ?? 0), 0n);
        const requiredShares = state.legs
          .filter((leg) => leg.kind === "call" && leg.side === "short")
          .reduce((n, leg) => n + BigInt(remaining.get(leg.id) ?? 0) * BigInt(leg.multiplier), 0n);
        if (shares < requiredShares)
          throw new LifecycleValidationError(
            "Covered call close must retain enough held shares for remaining calls",
          );
      }
      return append(tx, state, events);
    });
  }

  async function expirePosition(id: string, input: ExpireInput): Promise<LifecycleResponse | null> {
    return db.transaction(async (tx) => {
      const state = await snapshot(tx, id);
      if (!state) return null;
      requireOpen(state);
      checkDate(state, input.tradeDate);
      const options = state.legs.filter(
        (leg) => leg.kind !== "stock" && (state.balances.get(leg.id) ?? 0) > 0,
      );
      if (options.length === 0)
        throw new LifecycleConflictError("Position has no open option quantity to expire");
      const events = options.map((leg) => {
        if (leg.expiry === null || input.tradeDate < leg.expiry)
          throw new LifecycleValidationError("Expiration date cannot precede option expiry");
        return event(
          state,
          leg.id,
          "expire",
          input.tradeDate,
          state.balances.get(leg.id) ?? 0,
          ZERO,
          ZERO,
          ZERO,
        );
      });
      return append(tx, state, events);
    });
  }

  async function assignPosition(id: string, input: AssignInput): Promise<LifecycleResponse | null> {
    return db.transaction(async (tx) => {
      const state = await snapshot(tx, id);
      if (!state) return null;
      const leg = state.legs.find((l) => l.id === input.legId);
      if (!leg) throw new LifecycleValidationError("Assignment leg does not belong to position");
      if (
        state.position.strategy !== "csp" ||
        state.legs.length !== 1 ||
        leg.kind !== "put" ||
        leg.side !== "short" ||
        leg.adjusted ||
        leg.multiplier !== 100 ||
        leg.strike === null
      )
        throw new LifecycleValidationError(
          "Assignment supports only a single short unadjusted CSP put with multiplier 100",
        );
      requireOpen(state);
      checkDate(state, input.tradeDate);
      const qty = quantity(state.balances.get(leg.id) ?? 0);
      const shares = quantity(qty * leg.multiplier);
      const stockCash = cashFor(leg.strike, shares, 1, -1);
      const optionEvent = event(
        state,
        leg.id,
        "assign",
        input.tradeDate,
        qty,
        ZERO,
        ZERO,
        input.fees,
      );
      const realized = closingAllocations(state, [optionEvent]);
      const allocation = realized.find((a) => a.tradeId === optionEvent.id);
      if (!allocation) throw new Error("Assignment allocation missing");
      const premiumPerShare = money(
        divMoney4(allocation.openingCash, shares),
        MAX_PRICE,
        -MAX_PRICE,
        "Premium per share",
      );
      const basis = subMoney4(leg.strike, premiumPerShare);
      const stockPositionId = randomUUID();
      const stockLegId = randomUUID();
      const stockTradeId = randomUUID();
      const response = await append(tx, state, [optionEvent]);
      await repository(tx).createPosition({
        id: stockPositionId,
        campaignId: state.campaign.id,
        underlying: leg.underlying,
        strategy: "stock",
        role: "swing",
        openedOn: input.tradeDate,
        legs: [
          {
            id: stockLegId,
            kind: "stock",
            side: "long",
            underlying: leg.underlying,
            multiplier: 1,
            trades: [
              {
                id: stockTradeId,
                action: "open",
                tradeDate: input.tradeDate,
                quantity: shares,
                price: leg.strike,
                cash: stockCash,
                fees: ZERO,
                source: "manual",
                createdAt: state.createdAt,
              },
            ],
          },
        ],
      });
      await tx
        .insert(s.assignments)
        .values({ optionTradeId: optionEvent.id, stockTradeId, shares, premiumPerShare });
      return {
        ...response,
        tradeIds: [optionEvent.id, stockTradeId],
        assignment: {
          stockPositionId,
          stockLegId,
          stockTradeId,
          optionTradeId: optionEvent.id,
          shares,
          basis,
          premiumPerShare,
        },
      };
    });
  }

  async function linkHedge(id: string, input: LinkHedgeRequest): Promise<LinkHedgeResponse | null> {
    return db.transaction(async (tx) => {
      const state = await snapshot(tx, id);
      if (!state) return null;
      const [target] = await tx
        .select()
        .from(s.campaigns)
        .where(eq(s.campaigns.id, input.campaignId))
        .for("update");
      if (!target) return null;
      if (target.accountId !== state.campaign.accountId)
        throw new LifecycleValidationError("Hedge target must belong to the same account");
      if (state.position.role !== "hedge")
        throw new LifecycleValidationError("Only hedge positions can be linked");
      requireOpen(state);
      if (state.position.rollChainId !== null || state.trades.some((t) => t.rollId !== null))
        throw new LifecycleConflictError("Roll-linked hedge positions cannot move campaigns");
      if (target.id !== state.campaign.id) {
        await tx
          .update(s.campaigns)
          .set({
            openedOn:
              target.openedOn < state.position.openedOn ? target.openedOn : state.position.openedOn,
            closedOn: null,
          })
          .where(eq(s.campaigns.id, target.id));
        await tx.update(s.positions).set({ campaignId: target.id }).where(eq(s.positions.id, id));
      }
      return { positionId: id, campaignId: target.id };
    });
  }
  return { closePosition, expirePosition, assignPosition, linkHedge };
}

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { positionMetrics } from "../domain/positions.ts";
import { bookTotals } from "../domain/totals.ts";
import { type CreatePositionRequest, createPositionSchema } from "../shared/trade.ts";
import { toBookPosition, toBookPositions } from "./book.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { assignmentFixture } from "./test/assignment.ts";
import { testDatabase } from "./test/database.ts";
import { tradeRepository } from "./tradeRepository.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(sql`truncate accounts cascade`);
});
const dram = {
  strategy: "csp",
  underlying: "DRAM",
  openedOn: "2026-09-25",
  expiry: "2026-10-09",
  quantity: 10,
  adjusted: false,
  strike: "50",
  price: "1.85",
  fees: "6.50",
  tags: ["wheel"],
} as const;
const common = {
  underlying: "DRAM",
  openedOn: "2026-09-25",
  expiry: "2026-10-09",
  quantity: 15,
  adjusted: false,
  tags: ["wheel"],
};
const credit = {
  short: { strike: "55", price: "2", fees: "9.90" },
  long: { strike: "50", price: "1.10", fees: "6.60" },
};
const debit = {
  short: { strike: "55", price: "0.44", fees: "1.95" },
  long: { strike: "60", price: "2", fees: "1.95" },
};
const cases = [
  {
    input: dram,
    expected: { strategy: "csp", price: 18500, qty: 10 },
    edited: {
      kind: "put",
      side: "short",
      price: "2",
      bookPrice: 20000,
      cash: 20000000,
      metrics: { premium: 20000000 },
    },
  },
  {
    input: {
      ...common,
      strategy: "cc",
      strike: "55",
      price: "1.10",
      fees: "9.90",
      cover: { kind: "held", basis: "53" },
    },
    expected: { strategy: "cc", price: 11000, basis: 530000, qty: 15 },
    edited: {
      kind: "call",
      side: "short",
      price: "1.85",
      bookPrice: 18500,
      cash: 27750000,
      metrics: { premium: 27750000 },
    },
  },
  {
    input: { ...common, strategy: "put_credit_spread", ...credit },
    expected: { strategy: "put_credit_spread", price: 9000, qty: 15 },
    edited: {
      kind: "put",
      side: "short",
      price: "3.10",
      bookPrice: 20000,
      cash: 46500000,
      metrics: { premium: 30000000, collateral: 45000000 },
    },
  },
  {
    input: {
      ...common,
      strategy: "call_credit_spread",
      short: credit.short,
      long: { ...credit.long, strike: "60" },
    },
    expected: { strategy: "call_credit_spread", price: 9000, qty: 15 },
    edited: {
      kind: "call",
      side: "short",
      price: "3.10",
      bookPrice: 20000,
      cash: 46500000,
      metrics: { premium: 30000000, collateral: 45000000 },
    },
  },
  {
    input: { ...common, strategy: "put_debit_spread", ...debit, quantity: 3, role: "hedge" },
    expected: { strategy: "put_debit_spread", price: 15600, qty: 3, role: "hedge" },
    edited: {
      kind: "put",
      side: "long",
      price: "3.10",
      bookPrice: 26600,
      cash: -9300000,
      metrics: { debit: 7980000, maxProfit: 7020000 },
    },
  },
  {
    input: {
      ...common,
      strategy: "call_debit_spread",
      short: { ...debit.short, strike: "60" },
      long: { ...debit.long, strike: "55" },
      quantity: 3,
      role: "swing",
    },
    expected: { strategy: "call_debit_spread", price: 15600, qty: 3, role: "swing" },
    edited: {
      kind: "call",
      side: "long",
      price: "3.10",
      bookPrice: 26600,
      cash: -9300000,
      metrics: { debit: 7980000, maxProfit: 7020000 },
    },
  },
  {
    input: {
      ...common,
      strategy: "long_call",
      underlying: "AAPL",
      strike: "250",
      price: "7.80",
      fees: "0.65",
      quantity: 1,
      role: "swing",
    },
    expected: { strategy: "long_call", price: 78000, qty: 1 },
    edited: {
      kind: "call",
      side: "long",
      price: "5.10",
      bookPrice: 51000,
      cash: -5100000,
      metrics: { debit: 5100000, maxProfit: "unlimited" },
    },
  },
  {
    input: {
      ...common,
      strategy: "long_put",
      strike: "55",
      price: "2",
      fees: "9.90",
      role: "hedge",
    },
    expected: { strategy: "long_put", price: 20000, qty: 15 },
    edited: {
      kind: "put",
      side: "long",
      price: "1.85",
      bookPrice: 18500,
      cash: -27750000,
      metrics: { debit: 27750000 },
    },
  },
  {
    input: {
      strategy: "stock",
      underlying: "CRWD",
      openedOn: "2026-09-25",
      shares: 50,
      price: "455.20",
      fees: "0",
      tags: [],
    },
    expected: { strategy: "stock", price: 4552000, shares: 50, role: "swing" },
    edited: {
      kind: "stock",
      side: "long",
      price: "471.30",
      bookPrice: 4713000,
      cash: -235650000,
      metrics: { collateral: 235650000 },
    },
  },
  {
    input: {
      strategy: "day_trade",
      underlying: "CRWD",
      openedOn: "2026-09-25",
      shares: 50,
      price: "455.20",
      fees: "0",
      tags: [],
    },
    expected: { strategy: "day_trade", price: 4552000, shares: 50, role: "swing" },
    edited: {
      kind: "stock",
      side: "long",
      price: "471.30",
      bookPrice: 4713000,
      cash: -235650000,
      metrics: { collateral: 235650000 },
    },
  },
] as const;

const repo = () => tradeRepository(database.db);
const parse = (input: unknown) => createPositionSchema.parse(input);
async function firstTrade(positionId: string) {
  const { trades } = await repo().manualTrades(positionId);
  const trade = trades[0];
  if (!trade) throw new Error("Missing opening fill");
  return trade;
}
async function counts() {
  return {
    accounts: (await database.db.select().from(s.accounts)).length,
    campaigns: (await database.db.select().from(s.campaigns)).length,
    positions: (await database.db.select().from(s.positions)).length,
    legs: (await database.db.select().from(s.legs)).length,
    trades: (await database.db.select().from(s.trades)).length,
  };
}
function assignedCall(stockLegId: string, quantity = 10): CreatePositionRequest {
  return parse({
    ...common,
    strategy: "cc",
    strike: "55",
    price: "1.10",
    fees: "9.90",
    quantity,
    cover: { kind: "assigned", stockLegId },
  });
}

describe("manual trade persistence", () => {
  test("DRAM create persists an opening and reads the plan metrics through the book", async () => {
    const created = await repo().create(parse(dram));
    const rows = await repository(database.db).readOpenBook();
    expect(rows).toHaveLength(1);
    const row = rows.find((r) => r.id === created.positionId);
    if (!row) throw new Error("Missing created position");
    const metrics = positionMetrics(toBookPosition(row));
    expect(metrics).toMatchObject({
      premium: 18500000,
      collateral: 500000000,
      yield: 0.037,
      term: 14,
      breakeven: 481500,
    });
    if (metrics.kind !== "income") throw new Error("Expected income");
    expect(metrics.annualized).toBeCloseTo(0.964642857, 8);
    expect(bookTotals(toBookPositions(rows))).toMatchObject({
      contracts: 10,
      premium: 18500000,
      incomeCollateral: 500000000,
    });
    expect(await firstTrade(created.positionId)).toMatchObject({
      kind: "put",
      side: "short",
      strike: 500000,
      expiry: "2026-10-09",
      tradeDate: "2026-09-25",
      quantity: 10,
      price: 18500,
      fees: -65000,
      editable: true,
    });
    expect(await database.db.select().from(s.trades)).toMatchObject([
      { cash: 18500000, fees: -65000, executedAt: null, source: "manual" },
    ]);
    const trade = await firstTrade(created.positionId);
    expect(await repo().patch(trade.id, { price: "2" })).toEqual({ id: trade.id });
    const updated = toBookPositions(await repository(database.db).readOpenBook());
    const updatedPosition = updated[0];
    if (!updatedPosition) throw new Error("Missing edited position");
    expect(positionMetrics(updatedPosition)).toMatchObject({
      premium: 20000000,
      collateral: 500000000,
      yield: 0.04,
      breakeven: 480000,
    });
    expect(bookTotals(updated)).toMatchObject({
      premium: 20000000,
      yield: 0.04,
      capitalDeployed: 500000000,
    });
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 1, legs: 1, trades: 1 });
  });

  test.each(cases)(
    "round trips $expected.strategy and edits its real opening fills",
    async ({ input, expected, edited }) => {
      const created = await repo().create(parse(input));
      const rows = await repository(database.db).readOpenBook();
      expect(toBookPositions(rows)).toMatchObject([{ id: created.positionId, ...expected }]);
      const manual = await repo().manualTrades(created.positionId);
      expect(manual.trades.length).toBe("short" in input || input.strategy === "cc" ? 2 : 1);
      for (const t of manual.trades) {
        expect(t.editable).toBe(true);
        expect(await repo().patch(t.id, { fees: "0.6527" })).toEqual({ id: t.id });
      }
      expect((await repo().manualTrades(created.positionId)).trades.map((t) => t.fees)).toEqual(
        manual.trades.map(() => -6527),
      );
      expect(toBookPositions(await repository(database.db).readOpenBook())).toMatchObject([
        { ...expected },
      ]);
      const target = manual.trades.find((t) => t.kind === edited.kind && t.side === edited.side);
      if (!target) throw new Error("Missing editable fill");
      expect(await repo().patch(target.id, { price: edited.price })).toEqual({ id: target.id });
      const updated = toBookPositions(await repository(database.db).readOpenBook());
      expect(updated).toMatchObject([{ ...expected, price: edited.bookPrice }]);
      const position = updated[0];
      if (!position) throw new Error("Missing edited book row");
      expect(positionMetrics(position)).toMatchObject(edited.metrics);
      expect(
        await database.db.select().from(s.trades).where(eq(s.trades.id, target.id)),
      ).toMatchObject([{ cash: edited.cash, fees: -6527 }]);
    },
  );

  test("preserves individual spread fills, signed cash and different sub-cent fees", async () => {
    const created = await repo().create(
      parse({
        ...common,
        strategy: "put_debit_spread",
        ...debit,
        quantity: 3,
        role: "hedge",
        long: { ...debit.long, fees: "0.6527" },
      }),
    );
    const legs = await database.db.select().from(s.legs);
    const trades = await database.db.select().from(s.trades);
    const short = legs.find((l) => l.side === "short");
    const long = legs.find((l) => l.side === "long");
    expect(trades.find((t) => t.legId === short?.id)).toMatchObject({
      quantity: 3,
      price: 4400,
      cash: 1320000,
      fees: -19500,
    });
    expect(trades.find((t) => t.legId === long?.id)).toMatchObject({
      quantity: 3,
      price: 20000,
      cash: -6000000,
      fees: -6527,
    });
    const book = toBookPositions(await repository(database.db).readOpenBook());
    const position = book[0];
    if (!position) throw new Error("Missing debit spread");
    expect(positionMetrics(position)).toMatchObject({ debit: 4680000, maxProfit: 10320000 });
    if (!long) throw new Error("Missing long leg");
    const longTrade = trades.find((t) => t.legId === long.id);
    if (!longTrade) throw new Error("Missing long fill");
    expect(await repo().patch(longTrade.id, { price: "1.85" })).toEqual({ id: longTrade.id });
    expect(
      (await repo().manualTrades(created.positionId)).trades.find((t) => t.id === longTrade.id)
        ?.fees,
    ).toBe(-6527);
    expect(
      await database.db.select().from(s.trades).where(eq(s.trades.id, longTrade.id)),
    ).toMatchObject([{ price: 18500, cash: -5550000, fees: -6527 }]);
  });

  test("cash uses Money4 without floating error and adjustments/notes are retained", async () => {
    const created = await repo().create(
      parse({
        ...dram,
        quantity: 2,
        price: "1.09",
        fees: "0.6527",
        adjusted: true,
        notes: "Non-standard series",
      }),
    );
    expect(await database.db.select().from(s.trades)).toMatchObject([
      { price: 10900, cash: 2180000, fees: -6527 },
    ]);
    expect(await database.db.select().from(s.positions)).toMatchObject([
      { id: created.positionId, notes: "Non-standard series" },
    ]);
    expect(await database.db.select().from(s.campaigns)).toMatchObject([
      { notes: "Non-standard series" },
    ]);
    expect(toBookPositions(await repository(database.db).readOpenBook())).toMatchObject([
      { adjusted: true },
    ]);
    const t = await firstTrade(created.positionId);
    await repo().patch(t.id, { price: "1.0850", fees: "0" });
    expect(await database.db.select().from(s.trades)).toMatchObject([
      { price: 10850, cash: 2170000, fees: 0 },
    ]);
  });

  test("uses a stable lazy manual account, reuses existing accounts and refuses ambiguity", async () => {
    await repo().create(parse(dram));
    await repo().create(parse(dram));
    expect(await database.db.select().from(s.accounts)).toMatchObject([
      { id: "00000000-0000-4000-8000-000000000001", broker: "manual" },
    ]);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 2, positions: 2, legs: 2, trades: 2 });
    await database.db.insert(s.accounts).values({ label: "Second", broker: "ibkr" });
    await expect(repo().create(parse(dram))).rejects.toThrow("exactly one account");
    expect(await counts()).toEqual({ accounts: 2, campaigns: 2, positions: 2, legs: 2, trades: 2 });
  });

  test("rolls back campaign, position, legs, first fill and lazy account after a real late insert failure", async () => {
    await database.client.exec(`CREATE FUNCTION reject_long_opening() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM legs WHERE id = NEW.leg_id AND side = 'long') THEN
          RAISE EXCEPTION 'forced opening failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_long_opening BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION reject_long_opening();`);
    try {
      await expect(
        repo().create(parse({ ...common, strategy: "put_credit_spread", ...credit })),
      ).rejects.toThrow('insert into "trades"');
      expect(await counts()).toEqual({
        accounts: 0,
        campaigns: 0,
        positions: 0,
        legs: 0,
        trades: 0,
      });
    } finally {
      await database.client.exec(
        "DROP TRIGGER reject_long_opening ON trades; DROP FUNCTION reject_long_opening();",
      );
    }
  });

  test("options include historical unique tickers/tags and omit non-assigned held shares", async () => {
    expect(await repo().options()).toEqual({ tickers: [], tags: [], assignedStock: [] });
    const one = await repo().create(parse({ ...dram, tags: ["wheel", "income", "wheel"] }));
    await repo().create(parse(cases[1].input));
    await repo().create(parse({ ...dram, underlying: "AAPL", tags: ["income"] }));
    await database.db
      .update(s.positions)
      .set({ closedOn: "2026-10-09" })
      .where(eq(s.positions.id, one.positionId));
    expect(await repo().options()).toEqual({
      tickers: ["AAPL", "DRAM"],
      tags: ["income", "wheel"],
      assignedStock: [],
    });
  });
});

describe("assigned covered calls", () => {
  test("prefills basis 53, shares 1500; partial coverage shares one campaign and never duplicates stock", async () => {
    const ids = await assignmentFixture(database.db);
    expect(await repo().options()).toEqual({
      tickers: ["DRAM"],
      tags: ["assigned", "wheel"],
      assignedStock: [
        {
          legId: ids.stockLegId,
          underlying: "DRAM",
          uncoveredShares: 1500,
          basis: 530000,
          assignedOn: "2026-09-25",
        },
      ],
    });
    const call = await repo().create(assignedCall(ids.stockLegId));
    expect(call.campaignId).toBe(ids.campaignId);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 3, legs: 3, trades: 4 });
    expect(
      await database.db.select().from(s.legs).where(eq(s.legs.positionId, call.positionId)),
    ).toMatchObject([{ kind: "call", side: "short", coveredLegId: ids.stockLegId }]);
    expect((await repo().options()).assignedStock).toEqual([
      {
        legId: ids.stockLegId,
        underlying: "DRAM",
        uncoveredShares: 500,
        basis: 530000,
        assignedOn: "2026-09-25",
      },
    ]);
    const rows = await repository(database.db).readOpenBook();
    expect(rows.find((r) => r.id === call.positionId)?.coveredStock).toEqual({
      legId: ids.stockLegId,
      basis: 530000,
    });
    const book = toBookPositions(rows);
    expect(book).toHaveLength(2);
    expect(book.find((p) => p.id === ids.stockPositionId)).toMatchObject({ shares: 500 });
    expect(book.find((p) => p.id === call.positionId)).toMatchObject({
      strategy: "cc",
      basis: 530000,
      qty: 10,
    });
    expect(bookTotals(toBookPositions(rows))).toMatchObject({
      contracts: 10,
      premium: 11000000,
      incomeCollateral: 550000000,
      swingCapital: 275000000,
      capitalDeployed: 825000000,
    });
    const manual = await firstTrade(call.positionId);
    expect(manual.editable).toBe(true);
    await repo().patch(manual.id, { price: "1.85" });
    expect(
      toBookPositions(await repository(database.db).readOpenBook()).find(
        (p) => p.id === call.positionId,
      ),
    ).toMatchObject({ basis: 530000, price: 18500 });
    await repo().create(assignedCall(ids.stockLegId, 5));
    expect((await repo().options()).assignedStock).toEqual([]);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 4, legs: 4, trades: 5 });
    const fullBook = toBookPositions(await repository(database.db).readOpenBook());
    expect(fullBook).toHaveLength(2);
    expect(fullBook.every((p) => p.strategy === "cc")).toBe(true);
    expect(bookTotals(fullBook)).toMatchObject({
      contracts: 15,
      swingCapital: 0,
      incomeCollateral: 825000000,
      capitalDeployed: 825000000,
    });
    await expect(repo().create(assignedCall(ids.stockLegId, 1))).rejects.toMatchObject({
      status: 409,
    });
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 4, legs: 4, trades: 5 });
  });

  test("rechecks capacity on save and serializes competing covering calls", async () => {
    const ids = await assignmentFixture(database.db);
    const result = await Promise.allSettled([
      repo().create(assignedCall(ids.stockLegId, 10)),
      repo().create(assignedCall(ids.stockLegId, 10)),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toMatchObject([
      { reason: { status: 409 } },
    ]);
    expect((await repo().options()).assignedStock).toMatchObject([{ uncoveredShares: 500 }]);
  });

  test("rejects missing, mismatched, premature, insufficient and non-assigned stock", async () => {
    const ids = await assignmentFixture(database.db);
    const requests = [
      assignedCall(randomUUID()),
      assignedCall(ids.putLegId),
      assignedCall(ids.stockLegId, 16),
      parse({ ...assignedCall(ids.stockLegId), underlying: "AAPL" }),
      parse({ ...assignedCall(ids.stockLegId), openedOn: "2026-09-24" }),
    ];
    for (const input of requests)
      await expect(repo().create(input)).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 2, legs: 2, trades: 3 });
    const held = await repo().create(parse(cases[8].input));
    const stock = await firstTrade(held.positionId);
    await expect(repo().create(assignedCall(stock.legId))).rejects.toMatchObject({ status: 409 });
    expect((await repo().options()).assignedStock).toHaveLength(1);
  });

  test("coverage uses live close events for both shares and calls, not initial quantities", async () => {
    const ids = await assignmentFixture(database.db);
    const call = await repo().create(assignedCall(ids.stockLegId, 10));
    const t = await firstTrade(call.positionId);
    await database.db.insert(s.trades).values({
      legId: t.legId,
      action: "close",
      tradeDate: "2026-10-01",
      quantity: 5,
      price: t.price,
      cash: t.price,
      fees: t.fees,
    });
    expect((await repo().options()).assignedStock).toMatchObject([{ uncoveredShares: 1000 }]);
    await database.db.insert(s.trades).values({
      legId: ids.stockLegId,
      action: "close",
      tradeDate: "2026-10-01",
      quantity: 500,
      price: t.price,
      cash: t.price,
    });
    expect((await repo().options()).assignedStock).toMatchObject([{ uncoveredShares: 500 }]);
    await expect(repo().create(assignedCall(ids.stockLegId, 6))).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("manual fill edit protections", () => {
  test.each(["ibkr_upload", "ibkr_flex"] as const)(
    "never exposes %s fills as editable",
    async (source) => {
      const p = await repo().create(parse(dram));
      const t = await firstTrade(p.positionId);
      await database.db.update(s.trades).set({ source }).where(eq(s.trades.id, t.id));
      expect((await repo().manualTrades(p.positionId)).trades).toMatchObject([{ editable: false }]);
      await expect(repo().patch(t.id, { price: "2" })).rejects.toMatchObject({ status: 409 });
      expect(await database.db.select().from(s.trades)).toMatchObject([
        { cash: 18500000, price: 18500 },
      ]);
    },
  );

  test("blocks both sides of an assignment, including the put's original premium", async () => {
    const ids = await assignmentFixture(database.db);
    for (const id of [ids.putOpenTradeId, ids.optionTradeId, ids.stockTradeId])
      await expect(repo().patch(id, { price: "2" })).rejects.toMatchObject({ status: 409 });
    expect((await repo().manualTrades(ids.stockPositionId)).trades).toMatchObject([
      { editable: false },
    ]);
    expect((await repo().manualTrades(ids.putPositionId)).trades.map((t) => t.editable)).toEqual([
      false,
      false,
    ]);
    expect((await repo().options()).assignedStock).toMatchObject([{ basis: 530000 }]);
  });

  test.each(["trade", "position"])("blocks %s roll links", async (kind) => {
    const p = await repo().create(parse(dram));
    const t = await firstTrade(p.positionId);
    const chainId = randomUUID();
    const rollId = randomUUID();
    await database.db.insert(s.rollChains).values({ id: chainId, campaignId: p.campaignId });
    await database.db
      .insert(s.rolls)
      .values({ id: rollId, rollChainId: chainId, rolledOn: "2026-10-01" });
    if (kind === "trade")
      await database.db.update(s.trades).set({ rollId }).where(eq(s.trades.id, t.id));
    else
      await database.db
        .update(s.positions)
        .set({ rollChainId: chainId })
        .where(eq(s.positions.id, p.positionId));
    expect((await repo().manualTrades(p.positionId)).trades).toMatchObject([{ editable: false }]);
    await expect(repo().patch(t.id, { fees: "0" })).rejects.toMatchObject({ status: 409 });
  });

  test.each(["close", "expire", "exercise", "assign"] as const)(
    "does not edit %s lifecycle events",
    async (action) => {
      const p = await repo().create(parse(dram));
      const t = await firstTrade(p.positionId);
      await database.db.update(s.trades).set({ action }).where(eq(s.trades.id, t.id));
      await expect(repo().patch(t.id, { price: "2" })).rejects.toMatchObject({ status: 409 });
      expect((await repo().manualTrades(p.positionId)).trades).toMatchObject([{ editable: false }]);
    },
  );

  test("blocks historical/ambiguous fills, distinguishes missing IDs, and serves an empty position", async () => {
    await expect(repo().patch(randomUUID(), { price: "2" })).rejects.toMatchObject({ status: 404 });
    await expect(repo().manualTrades(randomUUID())).rejects.toMatchObject({ status: 404 });
    const p = await repo().create(parse(dram));
    const t = await firstTrade(p.positionId);
    await database.db
      .update(s.positions)
      .set({ closedOn: "2026-10-09" })
      .where(eq(s.positions.id, p.positionId));
    await expect(repo().patch(t.id, { price: "2" })).rejects.toMatchObject({ status: 409 });
    await database.db
      .update(s.positions)
      .set({ closedOn: null })
      .where(eq(s.positions.id, p.positionId));
    await database.db.insert(s.trades).values({
      legId: t.legId,
      action: "open",
      tradeDate: "2026-09-25",
      quantity: 10,
      price: t.price,
      cash: t.price,
    });
    await expect(repo().patch(t.id, { price: "2" })).rejects.toMatchObject({ status: 409 });
    await database.db.delete(s.legs).where(eq(s.legs.id, t.legId));
    expect(await repo().manualTrades(p.positionId)).toEqual({
      positionId: p.positionId,
      trades: [],
    });
  });

  test("rejects zero positive entries, CSP over strike and spread inversion/width without mutating cash", async () => {
    const csp = await repo().create(parse(dram));
    const t = await firstTrade(csp.positionId);
    for (const price of ["0", "50"])
      await expect(repo().patch(t.id, { price })).rejects.toMatchObject({ status: 400 });
    expect(await firstTrade(csp.positionId)).toMatchObject({ price: 18500, fees: -65000 });
    const spread = await repo().create(
      parse({ ...common, strategy: "put_credit_spread", ...credit }),
    );
    const trades = (await repo().manualTrades(spread.positionId)).trades;
    const short = trades.find((t) => t.side === "short");
    const long = trades.find((t) => t.side === "long");
    if (!short || !long) throw new Error("Missing spread fills");
    for (const price of ["1.10", "1", "6.10"])
      await expect(repo().patch(short.id, { price })).rejects.toMatchObject({ status: 400 });
    await expect(repo().patch(long.id, { price: "2" })).rejects.toMatchObject({ status: 400 });
    expect((await repo().manualTrades(spread.positionId)).trades).toMatchObject(trades);
    expect(await repo().patch(long.id, { price: "0" })).toEqual({ id: long.id });
    expect(
      toBookPositions(await repository(database.db).readOpenBook()).find(
        (p) => p.id === spread.positionId,
      ),
    ).toMatchObject({ price: 20000 });
  });

  test("held CC stock edits change basis only, and enforce positive basis/cash storage limits", async () => {
    const call = await repo().create(parse(cases[1].input));
    const stock = (await repo().manualTrades(call.positionId)).trades.find(
      (t) => t.kind === "stock",
    );
    if (!stock) throw new Error("Missing held stock");
    await expect(repo().patch(stock.id, { price: "0" })).rejects.toMatchObject({ status: 400 });
    expect(await repo().patch(stock.id, { price: "55", fees: "0.6527" })).toEqual({ id: stock.id });
    expect(toBookPositions(await repository(database.db).readOpenBook())).toMatchObject([
      { basis: 550000, price: 11000 },
    ]);
    const large = await repo().create(
      parse({
        ...dram,
        strategy: "cc",
        quantity: 1000000,
        price: "0.0001",
        cover: { kind: "held", basis: "1" },
      }),
    );
    const largeStock = (await repo().manualTrades(large.positionId)).trades.find(
      (t) => t.kind === "stock",
    );
    if (!largeStock) throw new Error("Missing large stock");
    await expect(repo().patch(largeStock.id, { price: "99999999" })).rejects.toMatchObject({
      status: 400,
    });
    expect(
      createPositionSchema.safeParse({
        ...dram,
        strategy: "cc",
        quantity: 1000000,
        price: "0.0001",
        cover: { kind: "held", basis: "99999999" },
      }).success,
    ).toBe(false);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 2, positions: 2, legs: 4, trades: 4 });
  });
});

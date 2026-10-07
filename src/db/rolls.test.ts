import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { rollSchema } from "../contracts/rollSchemas.ts";
import { parseIsoDate as d } from "../domain/dates.ts";
import { allocateRealizedTrades } from "../domain/lifecyclePnl.ts";
import type { Money4 } from "../domain/money.ts";
import { toBookPositions } from "./book.ts";
import {
  LifecycleValidationError,
  lifecycleRepository,
  StalePositionRevisionError,
} from "./lifecycle.ts";
import { repository } from "./repository.ts";
import { rollRepository } from "./rolls.ts";
import * as s from "./schema.ts";
import { assignmentFixture } from "./test/assignment.ts";
import { testDatabase } from "./test/database.ts";
import { qqqFixture, revision, tqqqFixture } from "./test/rollFixture.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.client.exec("TRUNCATE accounts CASCADE");
});
const today = d("2026-10-01");
const m = (value: number) => value as Money4;
async function allRows() {
  return {
    positions: await database.db.select().from(s.positions).orderBy(s.positions.id),
    legs: await database.db.select().from(s.legs).orderBy(s.legs.id),
    trades: await database.db.select().from(s.trades).orderBy(s.trades.id),
    rolls: await database.db.select().from(s.rolls).orderBy(s.rolls.id),
    chains: await database.db.select().from(s.rollChains).orderBy(s.rollChains.id),
  };
}

test("QQQ rolls whole spread in mapped fill order, books October, preserves source metadata and exact cash", async () => {
  const f = await qqqFixture(database.db);
  const result = await rollRepository(database.db).rollPosition(rollSchema.parse(f.raw, today));
  assert(result);
  expect(result).toMatchObject({
    positionId: f.positionId,
    campaignId: f.campaignId,
    closedOn: "2026-10-01",
    metrics: {
      realizedGross: -560000,
      realizedNet: -560000,
      rollCashGross: -700000,
      rollCashNet: -700000,
      chainCashGross: -2100000,
      chainCashNet: -2100000,
    },
  });
  expect(result.tradeIds).toHaveLength(4);
  expect(result.realized.map((a) => a.bookedMonth)).toEqual(["2026-10", "2026-10"]);
  const rows = await allRows();
  expect(rows.chains).toEqual([{ id: result.rollChainId, campaignId: f.campaignId }]);
  expect(rows.rolls).toEqual([
    {
      id: result.rollId,
      rollChainId: result.rollChainId,
      rolledOn: "2026-10-01",
      detectedBy: "manual",
    },
  ]);
  expect(rows.positions.find((p) => p.id === result.newPositionId)).toMatchObject({
    strategy: "put_debit_spread",
    role: "hedge",
    campaignId: f.campaignId,
    rollChainId: result.rollChainId,
    tags: ["hedge"],
    notes: "Keep notes",
    openedOn: "2026-10-01",
  });
  expect(rows.positions.find((p) => p.id === f.positionId)).toMatchObject({
    closedOn: "2026-10-01",
    rollChainId: result.rollChainId,
  });
  expect(rows.trades.filter((t) => result.tradeIds.includes(t.id)).map((t) => t.rollId)).toEqual(
    Array(4).fill(result.rollId),
  );
  expect(rows.trades.filter((t) => !result.tradeIds.includes(t.id)).map((t) => t.rollId)).toEqual([
    null,
    null,
  ]);
  expect(
    rows.legs
      .filter((l) => l.positionId === result.newPositionId)
      .sort((a, b) => (a.strike === null || b.strike === null ? 0 : a.strike - b.strike))
      .map((l) => [l.side, l.strike, l.expiry, l.multiplier]),
  ).toEqual([
    ["short", 6650000, "2026-11-06", 100],
    ["long", 6700000, "2026-11-06", 100],
  ]);
});

test("TQQQ literal seeded history reuses chain, keeps prior roll ids and separates gross/net fees", async () => {
  const f = await tqqqFixture(database.db);
  const prior = await database.db
    .select()
    .from(s.trades)
    .where(eq(s.trades.legId, f.priorLegId))
    .orderBy(s.trades.tradeDate);
  expect(allocateRealizedTrades(prior.map((t) => ({ ...t, date: d(t.tradeDate) })))).toMatchObject([
    { pnl: -8132000, bookedMonth: "2026-09" },
  ]);
  const result = await rollRepository(database.db).rollPosition(
    rollSchema.parse(
      { ...f.raw, fills: [{ ...f.raw.fills[0], closeFees: "-13.20", openFees: "-13.20" }] },
      today,
    ),
  );
  assert(result);
  expect(result.rollChainId).toBe(f.chainId);
  expect(result.metrics).toEqual({
    realizedGross: -14800000,
    realizedNet: -14932000,
    rollCashGross: 7000000,
    rollCashNet: 6736000,
    chainCashGross: 48000000,
    chainCashNet: 47604000,
  });
  expect(result.realized).toMatchObject([{ pnl: -14932000, bookedMonth: "2026-10", quantity: 20 }]);
  const rows = await allRows();
  expect(rows.chains).toHaveLength(1);
  expect(rows.rolls).toHaveLength(2);
  expect(rows.trades.filter((t) => t.rollId === f.priorRollId)).toHaveLength(2);
  const newLeg = rows.legs.find((l) => l.positionId === result.newPositionId);
  assert(newLeg);
  const second = await rollRepository(database.db).rollPosition(
    rollSchema.parse(
      {
        positionId: result.newPositionId,
        expectedRevision: await revision(database.db, result.newPositionId),
        tradeDate: "2026-10-02",
        expiry: "2026-12-18",
        fills: [{ legId: newLeg.id, strike: "54", closePrice: "1", openPrice: "2" }],
      },
      d("2026-10-02"),
    ),
  );
  assert(second);
  expect(second.rollChainId).toBe(f.chainId);
  expect((await allRows()).trades.filter((t) => t.rollId === result.rollId)).toHaveLength(2);
  expect((await allRows()).trades.filter((t) => t.rollId === f.priorRollId)).toHaveLength(2);
  await expect(
    rollRepository(database.db).rollPosition(rollSchema.parse(f.raw, today)),
  ).rejects.toBeInstanceOf(StalePositionRevisionError);
});

test("TQQQ prototype defaults realize -1480, credit700 and bring the existing chain to4800 gross", async () => {
  const f = await tqqqFixture(database.db);
  const result = await rollRepository(database.db).rollPosition(rollSchema.parse(f.raw, today));
  expect(result?.metrics).toEqual({
    realizedGross: -14800000,
    realizedNet: -14800000,
    rollCashGross: 7000000,
    rollCashNet: 7000000,
    chainCashGross: 48000000,
    chainCashNet: 47868000,
  });
});

test("late replacement opening insert failure rolls back close, source links, legs, positions, chain and roll", async () => {
  const f = await qqqFixture(database.db);
  const before = await allRows();
  await database.client.exec(
    `CREATE FUNCTION fail_roll_open() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'open' AND NEW.roll_id IS NOT NULL THEN RAISE EXCEPTION 'late opening failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_roll_open BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION fail_roll_open();`,
  );
  try {
    await expect(
      rollRepository(database.db).rollPosition(rollSchema.parse(f.raw, today)),
    ).rejects.toThrow();
    expect(await allRows()).toEqual(before);
    expect(await revision(database.db, f.positionId)).toBe(f.raw.expectedRevision);
  } finally {
    await database.client.exec(
      "DROP TRIGGER fail_roll_open ON trades; DROP FUNCTION fail_roll_open()",
    );
  }
  expect(
    (await rollRepository(database.db).rollPosition(rollSchema.parse(f.raw, today)))?.metrics
      .chainCashGross,
  ).toBe(-2100000);
});

test.each([
  "missing",
  "extra",
  "duplicate",
  "expiry",
  "strikes",
  "credit",
  "imbalance",
  "underlying",
  "kind",
  "multiplier",
])("invalid %s produces no partial rows", async (mode) => {
  const f = await qqqFixture(database.db);
  const input = rollSchema.parse(f.raw, today);
  const first = input.fills[0];
  assert(first);
  switch (mode) {
    case "missing":
      input.fills.pop();
      break;
    case "extra":
      input.fills.push({ ...first, legId: randomUUID() });
      break;
    case "duplicate":
      input.fills[1] = { ...first };
      break;
    case "expiry":
      input.expiry = d("2026-10-16");
      break;
    case "strikes":
      first.strike = m(6800000);
      break;
    case "credit":
      first.openPrice = m(10000);
      break;
    case "imbalance":
      await database.db
        .update(s.trades)
        .set({ quantity: 1, cash: m(-700000) })
        .where(eq(s.trades.legId, f.longId));
      break;
    case "underlying":
      await database.db.update(s.legs).set({ underlying: "SPY" }).where(eq(s.legs.id, f.shortId));
      break;
    case "kind":
      await database.db.update(s.legs).set({ kind: "call" }).where(eq(s.legs.id, f.shortId));
      break;
    case "multiplier":
      await database.db.update(s.legs).set({ multiplier: 50 }).where(eq(s.legs.id, f.shortId));
      break;
  }
  input.expectedRevision = await revision(database.db, f.positionId);
  const before = await allRows();
  await expect(rollRepository(database.db).rollPosition(input)).rejects.toBeInstanceOf(
    LifecycleValidationError,
  );
  expect(await allRows()).toEqual(before);
});

test("stale revision wins over invalid expiry or eligibility", async () => {
  const f = await qqqFixture(database.db);
  await database.db
    .update(s.trades)
    .set({ price: m(8000) })
    .where(eq(s.trades.legId, f.longId));
  const before = await allRows();
  await expect(
    rollRepository(database.db).rollPosition({
      ...rollSchema.parse(f.raw, today),
      expiry: d("2026-10-16"),
    }),
  ).rejects.toBeInstanceOf(StalePositionRevisionError);
  expect(await allRows()).toEqual(before);
});

test.each(["stock", "day_trade"] as const)("%s cannot roll", async (strategy) => {
  const f = await qqqFixture(database.db);
  await database.db.update(s.positions).set({ strategy }).where(eq(s.positions.id, f.positionId));
  const input = {
    ...rollSchema.parse(f.raw, today),
    expectedRevision: await revision(database.db, f.positionId),
  };
  const before = await allRows();
  await expect(rollRepository(database.db).rollPosition(input)).rejects.toBeInstanceOf(
    LifecycleValidationError,
  );
  expect(await allRows()).toEqual(before);
});

test.each([false, true])(
  "CC roll preserves held/assigned stock history and exact coverage (assigned=%s)",
  async (assigned) => {
    let stockLegId: string;
    let campaignId: string;
    let accountId: string;
    let oldId: string;
    const callId = randomUUID();
    if (assigned) {
      const f = await assignmentFixture(database.db);
      ({ stockLegId, campaignId, accountId } = f);
      oldId = await repository(database.db).createPosition({
        campaignId,
        underlying: "DRAM",
        strategy: "cc",
        role: "income",
        openedOn: "2026-09-25",
        legs: [
          {
            id: callId,
            kind: "call",
            side: "short",
            underlying: "DRAM",
            strike: m(550000),
            expiry: "2026-10-16",
            coveredLegId: stockLegId,
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-25",
                quantity: 15,
                price: m(11000),
                cash: m(16500000),
              },
            ],
          },
        ],
      });
    } else {
      const f = await qqqFixture(database.db);
      ({ campaignId, accountId } = f);
      stockLegId = randomUUID();
      oldId = await repository(database.db).createPosition({
        campaignId,
        underlying: "DRAM",
        strategy: "cc",
        role: "income",
        openedOn: "2026-09-25",
        legs: [
          {
            id: stockLegId,
            kind: "stock",
            side: "long",
            underlying: "DRAM",
            multiplier: 1,
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-25",
                quantity: 1500,
                price: m(530000),
                cash: m(-795000000),
              },
            ],
          },
          {
            id: callId,
            kind: "call",
            side: "short",
            underlying: "DRAM",
            strike: m(550000),
            expiry: "2026-10-16",
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-25",
                quantity: 15,
                price: m(11000),
                cash: m(16500000),
              },
            ],
          },
        ],
      });
    }
    const beforeStock = await database.db
      .select()
      .from(s.trades)
      .where(eq(s.trades.legId, stockLegId));
    const result = await rollRepository(database.db).rollPosition(
      rollSchema.parse(
        {
          positionId: oldId,
          expectedRevision: await revision(database.db, oldId),
          tradeDate: "2026-10-01",
          expiry: "2026-11-06",
          fills: [{ legId: callId, closePrice: "0.40", strike: "56", openPrice: "1.20" }],
        },
        today,
      ),
    );
    assert(result);
    expect(result.closedOn).toBe(assigned ? "2026-10-01" : null);
    expect(result.metrics).toMatchObject({
      realizedGross: 10500000,
      rollCashGross: 12000000,
      chainCashGross: 28500000,
    });
    expect(await database.db.select().from(s.trades).where(eq(s.trades.legId, stockLegId))).toEqual(
      beforeStock,
    );
    const [newCall] = await database.db
      .select()
      .from(s.legs)
      .where(eq(s.legs.positionId, result.newPositionId));
    expect(newCall).toMatchObject({ coveredLegId: stockLegId, multiplier: 100 });
    const book = toBookPositions(await repository(database.db).readOpenPositions(accountId));
    expect(book.find((p) => p.id === result.newPositionId)).toMatchObject({
      strategy: "cc",
      basis: 530000,
      qty: 15,
    });
    expect(book.filter((p) => p.underlying === "DRAM" && p.strategy === "stock")).toEqual([]);
    const [stock] = await database.db.select().from(s.legs).where(eq(s.legs.id, stockLegId));
    assert(stock);
    await expect(
      lifecycleRepository(database.db).closePosition(stock.positionId, {
        expectedRevision: await revision(database.db, stock.positionId),
        tradeDate: today,
        fills: [{ legId: stockLegId, quantity: 1, price: m(550000), fees: m(0) }],
      }),
    ).rejects.toThrow("Covered calls exceed stock balance");
    expect(await database.db.select().from(s.trades).where(eq(s.trades.legId, stockLegId))).toEqual(
      beforeStock,
    );
    if (!assigned) {
      await database.db.delete(s.trades).where(eq(s.trades.legId, stockLegId));
      await expect(repository(database.db).readOpenPositions(accountId)).rejects.toThrow(
        "Covered stock leg has no opening fills",
      );
    }
  },
);

test.each(["put_credit_spread", "call_credit_spread", "call_debit_spread"] as const)(
  "%s uses existing economic validation and preserves leg sides",
  async (strategy) => {
    const f = await qqqFixture(database.db);
    const debit = strategy === "call_debit_spread";
    const shortId = randomUUID();
    const longId = randomUUID();
    const positionId = await repository(database.db).createPosition({
      campaignId: f.campaignId,
      underlying: "QQQ",
      strategy,
      role: debit ? "hedge" : "income",
      openedOn: "2026-09-01",
      legs: [
        {
          id: shortId,
          kind: strategy.startsWith("put_") ? "put" : "call",
          side: "short",
          underlying: "QQQ",
          strike: m(strategy === "put_credit_spread" ? 550000 : debit ? 550000 : 500000),
          expiry: "2026-10-16",
          trades: [
            {
              action: "open",
              tradeDate: "2026-09-01",
              quantity: 2,
              price: m(debit ? 0 : 10000),
              cash: m(debit ? 0 : 2000000),
            },
          ],
        },
        {
          id: longId,
          kind: strategy.startsWith("put_") ? "put" : "call",
          side: "long",
          underlying: "QQQ",
          strike: m(strategy === "put_credit_spread" ? 500000 : debit ? 500000 : 550000),
          expiry: "2026-10-16",
          trades: [
            {
              action: "open",
              tradeDate: "2026-09-01",
              quantity: 2,
              price: m(debit ? 10000 : 0),
              cash: m(debit ? -2000000 : 0),
            },
          ],
        },
      ],
    });
    const raw = {
      positionId,
      expectedRevision: await revision(database.db, positionId),
      tradeDate: "2026-10-01",
      expiry: "2026-11-06",
      fills: [
        {
          legId: shortId,
          strike: strategy === "put_credit_spread" || debit ? "55" : "50",
          closePrice: debit ? "0" : "0.40",
          openPrice: debit ? "0" : "1.20",
        },
        {
          legId: longId,
          strike: strategy === "put_credit_spread" || debit ? "50" : "55",
          closePrice: debit ? "0.40" : "0",
          openPrice: debit ? "1.20" : "0",
        },
      ],
    };
    const result = await rollRepository(database.db).rollPosition(rollSchema.parse(raw, today));
    expect(result?.metrics).toEqual({
      realizedGross: debit ? -1200000 : 1200000,
      realizedNet: debit ? -1200000 : 1200000,
      rollCashGross: debit ? -1600000 : 1600000,
      rollCashNet: debit ? -1600000 : 1600000,
      chainCashGross: debit ? -3600000 : 3600000,
      chainCashNet: debit ? -3600000 : 3600000,
    });
  },
);

test.each(["long_call", "long_put"] as const)(
  "%s preserves adjusted deliverable and multiplier with partial remaining quantity",
  async (strategy) => {
    const f = await qqqFixture(database.db);
    const legId = randomUUID();
    const positionId = await repository(database.db).createPosition({
      campaignId: f.campaignId,
      underlying: "QQQ",
      strategy,
      role: "swing",
      openedOn: "2026-09-01",
      legs: [
        {
          id: legId,
          kind: strategy === "long_put" ? "put" : "call",
          side: "long",
          underlying: "QQQ",
          strike: m(550000),
          expiry: "2026-10-16",
          multiplier: 50,
          adjusted: true,
          trades: [
            {
              action: "open",
              tradeDate: "2026-09-01",
              quantity: 4,
              price: m(10000),
              cash: m(-2000000),
            },
          ],
        },
      ],
    });
    await lifecycleRepository(database.db).closePosition(positionId, {
      expectedRevision: await revision(database.db, positionId),
      tradeDate: d("2026-09-24"),
      fills: [{ legId, quantity: 2, price: m(5000), fees: m(0) }],
    });
    const result = await rollRepository(database.db).rollPosition(
      rollSchema.parse(
        {
          positionId,
          expectedRevision: await revision(database.db, positionId),
          tradeDate: "2026-10-01",
          expiry: "2026-11-06",
          fills: [{ legId, strike: "56", closePrice: "0.40", openPrice: "1.20" }],
        },
        today,
      ),
    );
    assert(result);
    expect(result.metrics).toEqual({
      realizedGross: -600000,
      realizedNet: -600000,
      rollCashGross: -800000,
      rollCashNet: -800000,
      chainCashGross: -2300000,
      chainCashNet: -2300000,
    });
    const [newLeg] = await database.db
      .select()
      .from(s.legs)
      .where(eq(s.legs.positionId, result.newPositionId));
    expect(newLeg).toMatchObject({ multiplier: 50, adjusted: true, side: "long", strike: 560000 });
    expect(result.realized).toMatchObject([{ quantity: 2, openingCash: -1000000, pnl: -600000 }]);
  },
);

test("closed/no-option conflicts and invalid historical dates leave all rows unchanged", async () => {
  const f = await qqqFixture(database.db);
  const before = await allRows();
  await expect(
    rollRepository(database.db).rollPosition({
      ...rollSchema.parse(f.raw, today),
      tradeDate: d("2026-08-28"),
    }),
  ).rejects.toThrow("Trade date cannot precede");
  expect(await allRows()).toEqual(before);
  await lifecycleRepository(database.db).closePosition(f.positionId, {
    expectedRevision: f.raw.expectedRevision,
    tradeDate: today,
    fills: [
      { legId: f.longId, quantity: 2, price: m(0), fees: m(0) },
      { legId: f.shortId, quantity: 2, price: m(0), fees: m(0) },
    ],
  });
  const after = await allRows();
  await expect(
    rollRepository(database.db).rollPosition({
      ...rollSchema.parse(f.raw, today),
      expectedRevision: await revision(database.db, f.positionId),
    }),
  ).rejects.toThrow("Position has no open option quantity to roll");
  expect(await allRows()).toEqual(after);
});

test.each(["missing", "underlying", "campaign", "reserved"])(
  "CC invalid %s backing cannot roll or leave partial rows",
  async (mode) => {
    const f = await tqqqFixture(database.db);
    await database.db
      .update(s.positions)
      .set({ strategy: "cc" })
      .where(eq(s.positions.id, f.positionId));
    await database.db.update(s.legs).set({ kind: "call" }).where(eq(s.legs.id, f.legId));
    if (mode !== "missing") {
      let campaignId = f.campaignId;
      if (mode === "campaign") {
        const [row] = await database.db
          .insert(s.campaigns)
          .values({ accountId: f.accountId, title: "Other", openedOn: "2026-09-24" })
          .returning();
        assert(row);
        campaignId = row.id;
      }
      const stockLegId = randomUUID();
      await repository(database.db).createPosition({
        campaignId,
        underlying: "TQQQ",
        strategy: "stock",
        role: "swing",
        openedOn: "2026-09-24",
        legs: [
          {
            id: stockLegId,
            kind: "stock",
            side: "long",
            underlying: mode === "underlying" ? "SPY" : "TQQQ",
            multiplier: 1,
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-24",
                quantity: 2000,
                price: m(530000),
                cash: m(-1060000000),
              },
            ],
          },
        ],
      });
      await database.db
        .update(s.legs)
        .set({ coveredLegId: stockLegId })
        .where(eq(s.legs.id, f.legId));
      if (mode === "reserved")
        await repository(database.db).createPosition({
          campaignId,
          underlying: "TQQQ",
          strategy: "cc",
          role: "income",
          openedOn: "2026-09-24",
          legs: [
            {
              kind: "call",
              side: "short",
              underlying: "TQQQ",
              coveredLegId: stockLegId,
              strike: m(550000),
              expiry: "2026-10-16",
              trades: [
                {
                  action: "open",
                  tradeDate: "2026-09-24",
                  quantity: 1,
                  price: m(10000),
                  cash: m(1000000),
                },
              ],
            },
          ],
        });
    }
    const before = await allRows();
    await expect(
      rollRepository(database.db).rollPosition({
        ...rollSchema.parse(f.raw, today),
        expectedRevision: await revision(database.db, f.positionId),
      }),
    ).rejects.toThrow(
      mode === "missing"
        ? "no backing stock"
        : mode === "underlying"
          ? "does not match"
          : mode === "campaign"
            ? "same campaign"
            : "exceed stock balance",
    );
    expect(await allRows()).toEqual(before);
  },
);

test("a chain from another campaign cannot be adopted, even after a successful nested close", async () => {
  const f = await qqqFixture(database.db);
  const [campaign] = await database.db
    .insert(s.campaigns)
    .values({ accountId: f.accountId, title: "Other", openedOn: "2026-09-01" })
    .returning();
  assert(campaign);
  const [chain] = await database.db
    .insert(s.rollChains)
    .values({ campaignId: campaign.id })
    .returning();
  assert(chain);
  await database.db
    .update(s.positions)
    .set({ rollChainId: chain.id })
    .where(eq(s.positions.id, f.positionId));
  const before = await allRows();
  await expect(
    rollRepository(database.db).rollPosition({
      ...rollSchema.parse(f.raw, today),
      expectedRevision: await revision(database.db, f.positionId),
    }),
  ).rejects.toThrow("another campaign");
  expect(await allRows()).toEqual(before);
});

test("opening arithmetic beyond Money4 safe range is validation, not a500, with no partial writes", async () => {
  const f = await tqqqFixture(database.db);
  await database.db
    .update(s.trades)
    .set({ quantity: 2147483647, price: m(0), cash: m(0) })
    .where(eq(s.trades.legId, f.legId));
  const input = rollSchema.parse(
    {
      ...f.raw,
      expectedRevision: await revision(database.db, f.positionId),
      fills: [{ legId: f.legId, closePrice: "0", strike: "55", openPrice: "54.99" }],
    },
    today,
  );
  const before = await allRows();
  await expect(rollRepository(database.db).rollPosition(input)).rejects.toBeInstanceOf(
    LifecycleValidationError,
  );
  expect(await allRows()).toEqual(before);
});

test("multiple accounts conflict; empty book has no roll source", async () => {
  const input = rollSchema.parse(
    {
      positionId: randomUUID(),
      expectedRevision: "a".repeat(64),
      expiry: "2026-11-06",
      fills: [{ legId: randomUUID(), strike: "55", closePrice: "0", openPrice: "1" }],
    },
    today,
  );
  expect(await rollRepository(database.db).rollPosition(input)).toBeNull();
  await qqqFixture(database.db);
  await database.db.insert(s.accounts).values({ label: "Second", broker: "manual" });
  await expect(rollRepository(database.db).rollPosition(input)).rejects.toThrow(
    "Roll requires a single account",
  );
});

test("unknown position returns null", async () => {
  const f = await qqqFixture(database.db);
  expect(
    await rollRepository(database.db).rollPosition({
      ...rollSchema.parse(f.raw, today),
      positionId: randomUUID(),
    }),
  ).toBeNull();
});

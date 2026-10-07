import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { CloseInput } from "../contracts/lifecycle.ts";
import { parseIsoDate as d } from "../domain/dates.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { campaignRepository } from "./campaigns.ts";
import {
  LifecycleConflictError,
  LifecycleValidationError,
  lifecycleRepository,
} from "./lifecycle.ts";
import { type NewLeg, type NewPosition, repository } from "./repository.ts";
import * as s from "./schema.ts";
import { testDatabase } from "./test/database.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
let accountId: string;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.client.exec("TRUNCATE accounts CASCADE");
  const [account] = await database.db
    .insert(s.accounts)
    .values({ label: "Lifecycle", broker: "manual" })
    .returning();
  assert(account);
  accountId = account.id;
});

async function campaign(openedOn = "2026-09-01", owner = accountId) {
  const [row] = await database.db
    .insert(s.campaigns)
    .values({ accountId: owner, title: "Lifecycle campaign", openedOn, notes: "Keep audit" })
    .returning();
  assert(row);
  return row;
}
const muu: NewLeg & { trades: [NewLeg["trades"][number]] } = {
  kind: "put",
  side: "short",
  underlying: "MUU",
  strike: m("25"),
  expiry: "2026-10-16",
  multiplier: 100,
  trades: [
    {
      action: "open",
      tradeDate: "2026-09-01",
      quantity: 10,
      price: m("1.50"),
      cash: m("1500"),
      fees: m("-6.60"),
    },
  ],
};
const dram: NewLeg & { trades: [NewLeg["trades"][number]] } = {
  ...muu,
  underlying: "DRAM",
  strike: m("55"),
  trades: [
    {
      action: "open",
      tradeDate: "2026-09-01",
      quantity: 15,
      price: m("2"),
      cash: m("3000"),
      fees: m("-9.90"),
    },
  ],
};
const spxl: NewLeg = {
  ...muu,
  underlying: "SPXL",
  strike: m("240"),
  trades: [
    {
      action: "open",
      tradeDate: "2026-09-01",
      quantity: 2,
      price: m("3.10"),
      cash: m("620"),
      fees: m("-1.30"),
    },
  ],
};
const stock: NewLeg & { trades: [NewLeg["trades"][number]] } = {
  kind: "stock",
  side: "long",
  underlying: "MUU",
  multiplier: 1,
  trades: [
    {
      action: "open",
      tradeDate: "2026-09-01",
      quantity: 100,
      price: m("25"),
      cash: m("-2500"),
      fees: m("0"),
    },
  ],
};
async function position(legs: NewLeg[] = [muu], fields: Partial<NewPosition> = {}) {
  const source = await campaign();
  const id = await repository(database.db).createPosition({
    campaignId: source.id,
    underlying: legs[0]?.underlying ?? "MUU",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    ...fields,
    legs,
  });
  const loaded = await database.db.select().from(s.legs).where(eq(s.legs.positionId, id));
  const first = loaded.find((leg) => leg.kind === legs[0]?.kind && leg.side === legs[0]?.side);
  assert(first);
  return { id, legs: loaded, legId: first.id, campaignId: source.id };
}
const repo = () => lifecycleRepository(database.db);
const close = (
  legId: string,
  quantity = 5,
): CloseInput & { fills: [CloseInput["fills"][number]] } => ({
  tradeDate: d("2026-10-01"),
  fills: [{ legId, quantity, price: m("0.40"), fees: m("-1.30") }],
});
async function rows() {
  const { db } = database;
  return {
    positions: await db.select().from(s.positions).orderBy(s.positions.id),
    legs: await db.select().from(s.legs).orderBy(s.legs.id),
    trades: await db.select().from(s.trades).orderBy(s.trades.id),
    assignments: await db.select().from(s.assignments).orderBy(s.assignments.id),
    campaigns: await db.select().from(s.campaigns).orderBy(s.campaigns.id),
  };
}

test("MUU expiration books 1493.40 once and persists a zero-price/cash/fee event", async () => {
  const p = await position();
  const result = await repo().expirePosition(p.id, { tradeDate: d("2026-10-16") });
  assert(result);
  expect(result).toEqual({
    positionId: p.id,
    campaignId: p.campaignId,
    closedOn: "2026-10-16",
    tradeIds: [expect.any(String)],
    realized: [
      {
        tradeId: result.tradeIds[0],
        quantity: 10,
        openingCash: 15000000,
        openingFees: -66000,
        pnl: 14934000,
        bookedMonth: "2026-10",
      },
    ],
  });
  const saved = await rows();
  expect(saved.trades.find((t) => t.id === result.tradeIds[0])).toMatchObject({
    action: "expire",
    quantity: 10,
    price: 0,
    cash: 0,
    fees: 0,
    source: "manual",
  });
  expect(saved.positions[0]?.closedOn).toBe("2026-10-16");
  await expect(repo().expirePosition(p.id, { tradeDate: d("2026-10-16") })).rejects.toThrow(
    LifecycleConflictError,
  );
  expect(await rows()).toEqual(saved);
});

test("SPXL close books 537.40 net and debits 80 cash", async () => {
  const p = await position([spxl]);
  const result = await repo().closePosition(p.id, close(p.legId, 2));
  assert(result);
  expect(result.closedOn).toBe("2026-10-01");
  expect(result.realized).toEqual([
    {
      tradeId: result.tradeIds[0],
      quantity: 2,
      openingCash: 6200000,
      openingFees: -13000,
      pnl: 5374000,
      bookedMonth: "2026-10",
    },
  ]);
  expect((await rows()).trades.find((t) => t.id === result.tradeIds[0])).toMatchObject({
    cash: -800000,
    fees: -13000,
    price: 4000,
    quantity: 2,
  });
});

test("partial MUU close leaves 5, expire books only remaining quantity and new allocation", async () => {
  const p = await position();
  const result = await repo().closePosition(p.id, close(p.legId));
  assert(result);
  expect(result.closedOn).toBeNull();
  expect(result.realized[0]).toMatchObject({
    quantity: 5,
    openingCash: 7500000,
    openingFees: -33000,
    pnl: 5454000,
  });
  const expired = await repo().expirePosition(p.id, { tradeDate: d("2026-10-16") });
  assert(expired);
  expect(expired.closedOn).toBe("2026-10-16");
  expect(expired.realized).toEqual([
    {
      tradeId: expired.tradeIds[0],
      quantity: 5,
      openingCash: 7500000,
      openingFees: -33000,
      pnl: 7467000,
      bookedMonth: "2026-10",
    },
  ]);
});

test("per-leg long/short fills use opposite cash signs; zero price closes are valid", async () => {
  const p = await position(
    [
      muu,
      { ...muu, side: "long", strike: m("30"), trades: [{ ...muu.trades[0], cash: m("-1500") }] },
    ],
    { strategy: "put_debit_spread", role: "hedge" },
  );
  const long = p.legs.find((leg) => leg.side === "long");
  assert(long);
  const result = await repo().closePosition(p.id, {
    tradeDate: d("2026-10-01"),
    fills: [
      { legId: p.legId, quantity: 10, price: m("0"), fees: m("0") },
      { legId: long.id, quantity: 10, price: m("0.40"), fees: m("0") },
    ],
  });
  assert(result);
  expect(result.realized).toHaveLength(2);
  expect(result.closedOn).toBe("2026-10-01");
  const saved = (await rows()).trades.filter((t) => result.tradeIds.includes(t.id));
  expect(saved.find((t) => t.legId === p.legId)?.cash).toBe(0);
  expect(saved.find((t) => t.legId === long.id)?.cash).toBe(4000000);
});

const spreadStrategies = [
  "put_credit_spread",
  "put_debit_spread",
  "call_credit_spread",
  "call_debit_spread",
] as const;
async function spreadPosition(strategy: (typeof spreadStrategies)[number]) {
  const kind = strategy.startsWith("put_") ? "put" : "call";
  return position(
    [
      {
        ...muu,
        kind,
        underlying: "TQQQ",
        side: "long",
        strike: m("60"),
        trades: [{ ...muu.trades[0], quantity: 3, price: m("2.26"), cash: m("-678") }],
      },
      {
        ...muu,
        kind,
        underlying: "TQQQ",
        strike: m("55"),
        trades: [{ ...muu.trades[0], quantity: 3, price: m("0.70"), cash: m("210") }],
      },
    ],
    { strategy, role: strategy.includes("debit") ? "hedge" : "income" },
  );
}

test.each(spreadStrategies)(
  "%s close rejects unequal remaining leg balances atomically",
  async (strategy) => {
    const p = await spreadPosition(strategy);
    const long = p.legs.find((leg) => leg.side === "long");
    const short = p.legs.find((leg) => leg.side === "short");
    assert(long && short);
    const before = await rows();
    for (const [longQty, shortQty] of [
      [3, 0],
      [0, 3],
      [1, 0],
      [0, 1],
      [2, 1],
    ] as const) {
      const fills = [
        { legId: long.id, quantity: longQty, price: m("0.40"), fees: m("0") },
        { legId: short.id, quantity: shortQty, price: m("0.10"), fees: m("0") },
      ].filter((fill) => fill.quantity > 0);
      await expect(
        repo().closePosition(p.id, { tradeDate: d("2026-10-01"), fills }),
      ).rejects.toMatchObject({
        status: 400,
        message: "Spread close must leave equal open quantities on both legs",
      });
      expect(await rows()).toEqual(before);
    }
  },
);

test.each(spreadStrategies)(
  "%s balanced partial close allows independently priced fills",
  async (strategy) => {
    const p = await spreadPosition(strategy);
    const long = p.legs.find((leg) => leg.side === "long");
    const short = p.legs.find((leg) => leg.side === "short");
    assert(long && short);
    const result = await repo().closePosition(p.id, {
      tradeDate: d("2026-10-01"),
      fills: [
        { legId: long.id, quantity: 1, price: m("0.40"), fees: m("0") },
        { legId: short.id, quantity: 1, price: m("0.10"), fees: m("0") },
      ],
    });
    assert(result);
    expect(result.closedOn).toBeNull();
    expect(result.realized).toHaveLength(2);
    const saved = (await rows()).trades.filter((t) => result.tradeIds.includes(t.id));
    expect(saved.find((t) => t.legId === long.id)).toMatchObject({ quantity: 1, cash: 400000 });
    expect(saved.find((t) => t.legId === short.id)).toMatchObject({ quantity: 1, cash: -100000 });
    const remaining = await repository(database.db).readOpenPositions(accountId);
    expect(remaining).toHaveLength(1);
    for (const leg of remaining[0]?.legs ?? []) {
      expect(
        leg.trades.reduce((qty, t) => qty + (t.action === "open" ? t.quantity : -t.quantity), 0),
      ).toBe(2);
    }
  },
);

async function coveredPosition() {
  return position(
    [
      {
        ...dram,
        kind: "call",
        trades: [{ ...dram.trades[0], price: m("1.10"), cash: m("1650") }],
      },
      {
        ...stock,
        underlying: "DRAM",
        trades: [{ ...stock.trades[0], quantity: 1500, price: m("53"), cash: m("-79500") }],
      },
    ],
    { strategy: "cc" },
  );
}

test("covered call close rejects sales that uncover remaining calls atomically", async () => {
  const p = await coveredPosition();
  const shares = p.legs.find((leg) => leg.kind === "stock");
  assert(shares);
  const before = await rows();
  for (const [stockQty, callQty] of [
    [1, 0],
    [1500, 0],
    [101, 1],
  ] as const) {
    const fills = [
      { legId: shares.id, quantity: stockQty, price: m("55"), fees: m("0") },
      { legId: p.legId, quantity: callQty, price: m("0.40"), fees: m("0") },
    ].filter((fill) => fill.quantity > 0);
    await expect(
      repo().closePosition(p.id, { tradeDate: d("2026-10-01"), fills }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Covered call close must retain enough held shares for remaining calls",
    });
    expect(await rows()).toEqual(before);
  }
});

test("covered call close can sell shares when the same batch reduces calls sufficiently", async () => {
  const p = await coveredPosition();
  const shares = p.legs.find((leg) => leg.kind === "stock");
  assert(shares);
  const result = await repo().closePosition(p.id, {
    tradeDate: d("2026-10-01"),
    fills: [
      { legId: shares.id, quantity: 100, price: m("55"), fees: m("0") },
      { legId: p.legId, quantity: 1, price: m("0.40"), fees: m("0") },
    ],
  });
  assert(result);
  expect(result.closedOn).toBeNull();
  const saved = (await rows()).trades.filter((t) => result.tradeIds.includes(t.id));
  expect(saved.find((t) => t.legId === shares.id)).toMatchObject({ quantity: 100, cash: 55000000 });
  expect(saved.find((t) => t.legId === p.legId)).toMatchObject({ quantity: 1, cash: -400000 });
});

test("covered call stock can close after all calls expire", async () => {
  const p = await coveredPosition();
  const shares = p.legs.find((leg) => leg.kind === "stock");
  assert(shares);
  const expired = await repo().expirePosition(p.id, { tradeDate: d("2026-10-16") });
  expect(expired?.closedOn).toBeNull();
  expect(expired?.tradeIds).toHaveLength(1);
  const result = await repo().closePosition(p.id, {
    tradeDate: d("2026-10-16"),
    fills: [{ legId: shares.id, quantity: 1500, price: m("55"), fees: m("0") }],
  });
  assert(result);
  expect(result.closedOn).toBe("2026-10-16");
  expect(result.realized[0]).toMatchObject({ quantity: 1500, pnl: 30000000 });
  expect((await rows()).trades.find((t) => t.id === result.tradeIds[0])).toMatchObject({
    quantity: 1500,
    cash: 825000000,
  });
});

test("expire all option legs but never stock, including a covered position", async () => {
  const p = await position([muu, { ...muu, side: "long", strike: m("30") }, stock], {
    strategy: "cc",
  });
  const result = await repo().expirePosition(p.id, { tradeDate: d("2026-10-16") });
  assert(result);
  expect(result.tradeIds).toHaveLength(2);
  expect(result.closedOn).toBeNull();
  const stockLeg = p.legs.find((leg) => leg.kind === "stock");
  assert(stockLeg);
  expect((await rows()).trades.filter((t) => t.legId === stockLeg.id)).toHaveLength(1);
  await expect(repo().expirePosition(p.id, { tradeDate: d("2026-10-16") })).rejects.toThrow(
    LifecycleConflictError,
  );
});

test("DRAM assignment realizes 2990.10 and writes a separate 1500-share swing at strike, basis 53", async () => {
  const p = await position([dram]);
  const result = await repo().assignPosition(p.id, {
    legId: p.legId,
    tradeDate: d("2026-10-16"),
    fees: m("0"),
  });
  assert(result?.assignment);
  const a = result.assignment;
  expect(result.closedOn).toBe("2026-10-16");
  expect(result.tradeIds).toEqual([a.optionTradeId, a.stockTradeId]);
  expect(result.realized).toEqual([
    {
      tradeId: a.optionTradeId,
      quantity: 15,
      openingCash: 30000000,
      openingFees: -99000,
      pnl: 29901000,
      bookedMonth: "2026-10",
    },
  ]);
  expect(a).toMatchObject({ shares: 1500, premiumPerShare: 20000, basis: 530000 });
  const saved = await rows();
  expect(saved.positions.find((row) => row.id === a.stockPositionId)).toMatchObject({
    campaignId: p.campaignId,
    strategy: "stock",
    role: "swing",
    closedOn: null,
    openedOn: "2026-10-16",
  });
  expect(saved.legs.find((row) => row.id === a.stockLegId)).toMatchObject({
    positionId: a.stockPositionId,
    kind: "stock",
    side: "long",
    strike: null,
    expiry: null,
    multiplier: 1,
  });
  expect(saved.trades.find((row) => row.id === a.stockTradeId)).toMatchObject({
    action: "open",
    quantity: 1500,
    price: 550000,
    cash: -825000000,
    fees: 0,
  });
  expect(saved.trades.find((row) => row.id === a.optionTradeId)).toMatchObject({
    action: "assign",
    quantity: 15,
    cash: 0,
    price: 0,
    fees: 0,
  });
  expect(saved.assignments).toEqual([
    {
      id: expect.any(String),
      optionTradeId: a.optionTradeId,
      stockTradeId: a.stockTradeId,
      shares: 1500,
      premiumPerShare: 20000,
    },
  ]);
  const detail = await campaignRepository(database.db).readCampaign(p.campaignId, d("2026-10-16"));
  expect(detail?.assignments).toEqual(saved.assignments);
  expect(detail?.positions).toHaveLength(2);
  await expect(
    repo().assignPosition(p.id, { legId: p.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
  ).rejects.toThrow(LifecycleConflictError);
});

test("partial then assign allocates only remaining premium, gross basis ignores fees", async () => {
  const p = await position([dram]);
  await repo().closePosition(p.id, close(p.legId, 5));
  const result = await repo().assignPosition(p.id, {
    legId: p.legId,
    tradeDate: d("2026-10-16"),
    fees: m("-1"),
  });
  assert(result);
  expect(result.assignment).toMatchObject({ shares: 1000, premiumPerShare: 20000, basis: 530000 });
  expect(result.realized[0]).toMatchObject({
    quantity: 10,
    openingCash: 20000000,
    openingFees: -66000,
    pnl: 19924000,
  });
});

test("rounding residue survives a partial close and reopening uses new opening cash", async () => {
  const p = await position([
    {
      ...muu,
      trades: [
        {
          action: "open",
          tradeDate: "2026-09-01",
          quantity: 3,
          price: m("0.0001"),
          cash: m("0.0004"),
          fees: m("-0.0002"),
        },
      ],
    },
  ]);
  const first = await repo().closePosition(p.id, {
    tradeDate: d("2026-09-02"),
    fills: [{ legId: p.legId, quantity: 1, price: m("0"), fees: m("0") }],
  });
  expect(first?.realized[0]).toMatchObject({ openingCash: 1, openingFees: 0, pnl: 1 });
  const rest = await repo().expirePosition(p.id, { tradeDate: d("2026-10-16") });
  expect(rest?.realized[0]).toMatchObject({ openingCash: 3, openingFees: -2, pnl: 1 });
  await repository(database.db).appendTrades(p.id, [
    {
      legId: p.legId,
      action: "open",
      tradeDate: "2026-10-17",
      quantity: 1,
      price: m("2"),
      cash: m("200"),
      fees: m("-1"),
    },
  ]);
  const reopened = await repo().closePosition(p.id, {
    tradeDate: d("2026-10-18"),
    fills: [{ legId: p.legId, quantity: 1, price: m("0"), fees: m("0") }],
  });
  expect(reopened?.closedOn).toBe("2026-10-18");
  expect(reopened?.realized).toHaveLength(1);
  expect(reopened?.realized[0]).toMatchObject({
    openingCash: 2000000,
    openingFees: -10000,
    pnl: 1990000,
  });
});

test("stock-insert trigger failure rolls back option event, closedOn, stock and assignment", async () => {
  const p = await position([dram]);
  const before = await rows();
  await database.client.exec(`
    CREATE FUNCTION reject_lifecycle_stock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind = 'stock' THEN RAISE EXCEPTION 'stock insert deliberately failed'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_lifecycle_stock BEFORE INSERT ON legs
    FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_stock();
  `);
  try {
    await expect(
      repo().assignPosition(p.id, { legId: p.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
    ).rejects.toThrow("stock");
    expect(await rows()).toEqual(before);
  } finally {
    await database.client.exec(
      "DROP TRIGGER reject_lifecycle_stock ON legs; DROP FUNCTION reject_lifecycle_stock()",
    );
  }
});

test.each([
  [
    "duplicate legs",
    (legId: string) => ({
      ...close(legId),
      fills: [close(legId).fills[0], close(legId).fills[0]],
    }),
  ],
  ["empty fills", (legId: string) => ({ ...close(legId), fills: [] })],
  ["zero quantity", (legId: string) => close(legId, 0)],
  ["fractional quantity", (legId: string) => close(legId, 0.5)],
  ["unknown leg", () => close(randomUUID())],
  [
    "negative price",
    (legId: string) => ({
      ...close(legId),
      fills: [{ ...close(legId).fills[0], price: m("-1") }],
    }),
  ],
  [
    "positive fees",
    (legId: string) => ({ ...close(legId), fills: [{ ...close(legId).fills[0], fees: m("1") }] }),
  ],
  [
    "price precision",
    (legId: string) => ({
      ...close(legId),
      fills: [{ ...close(legId).fills[0], price: m("100000000") }],
    }),
  ],
  [
    "fees precision",
    (legId: string) => ({
      ...close(legId),
      fills: [{ ...close(legId).fills[0], fees: m("-10000000000") }],
    }),
  ],
  [
    "cash precision",
    (legId: string) => ({
      ...close(legId),
      fills: [{ ...close(legId).fills[0], price: m("99999999.9999") }],
    }),
  ],
  ["before opening", (legId: string) => ({ ...close(legId), tradeDate: d("2026-08-31") })],
] as const)("close rejects %s before writing", async (_name, input) => {
  const p = await position();
  const before = await rows();
  await expect(repo().closePosition(p.id, input(p.legId))).rejects.toThrow(
    LifecycleValidationError,
  );
  expect(await rows()).toEqual(before);
});

test("overclose and a stale date reject the entire batch", async () => {
  const p = await position();
  let before = await rows();
  await expect(repo().closePosition(p.id, close(p.legId, 11))).rejects.toThrow(
    LifecycleConflictError,
  );
  expect(await rows()).toEqual(before);
  await repo().closePosition(p.id, close(p.legId, 5));
  before = await rows();
  await expect(
    repo().closePosition(p.id, { ...close(p.legId, 1), tradeDate: d("2026-09-30") }),
  ).rejects.toThrow(LifecycleValidationError);
  expect(await rows()).toEqual(before);
});

test("all per-leg fills validate before any trade is written", async () => {
  const p = await position([muu, { ...muu, side: "long", strike: m("30") }]);
  const other = p.legs.find((leg) => leg.side === "long");
  assert(other);
  const before = await rows();
  await expect(
    repo().closePosition(p.id, {
      ...close(p.legId),
      fills: [
        ...close(p.legId).fills,
        { legId: other.id, quantity: 11, price: m("0"), fees: m("0") },
      ],
    }),
  ).rejects.toThrow(LifecycleConflictError);
  expect(await rows()).toEqual(before);
});

test("expiry date gate checks every option and stock-only expiry conflicts", async () => {
  const p = await position([muu, { ...muu, side: "long", expiry: "2026-11-20" }]);
  const before = await rows();
  await expect(repo().expirePosition(p.id, { tradeDate: d("2026-10-16") })).rejects.toThrow(
    LifecycleValidationError,
  );
  expect(await rows()).toEqual(before);
  const shares = await position([stock], { strategy: "stock", role: "swing" });
  await expect(repo().expirePosition(shares.id, { tradeDate: d("2026-10-16") })).rejects.toThrow(
    LifecycleConflictError,
  );
});

test.each([
  ["long", { ...dram, side: "long" as const }, "csp" as const],
  ["call", { ...dram, kind: "call" as const }, "csp" as const],
  ["adjusted", { ...dram, adjusted: true }, "csp" as const],
  ["nonstandard multiplier", { ...dram, multiplier: 10 }, "csp" as const],
  ["non CSP", dram, "put_credit_spread" as const],
] as const)("assignment rejects unsupported %s", async (_name, leg, strategy) => {
  const p = await position([leg], { strategy });
  const before = await rows();
  await expect(
    repo().assignPosition(p.id, {
      legId: p.legId,
      tradeDate: d("2026-10-16"),
      fees: m("0"),
    }),
  ).rejects.toThrow(LifecycleValidationError);
  expect(await rows()).toEqual(before);
});

test("assignment rejects extra legs, foreign leg, stale date, positive fees and unsafe shares/cash", async () => {
  const p = await position([dram, { ...dram, side: "long" }]);
  await expect(
    repo().assignPosition(p.id, { legId: p.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
  ).rejects.toThrow(LifecycleValidationError);
  const single = await position([dram]);
  await expect(
    repo().assignPosition(single.id, { legId: p.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
  ).rejects.toThrow(LifecycleValidationError);
  await expect(
    repo().assignPosition(single.id, {
      legId: single.legId,
      tradeDate: d("2026-08-31"),
      fees: m("0"),
    }),
  ).rejects.toThrow(LifecycleValidationError);
  await expect(
    repo().assignPosition(single.id, {
      legId: single.legId,
      tradeDate: d("2026-10-16"),
      fees: m("1"),
    }),
  ).rejects.toThrow(LifecycleValidationError);
  const huge = await position([{ ...dram, trades: [{ ...dram.trades[0], quantity: 2147483647 }] }]);
  const before = await rows();
  await expect(
    repo().assignPosition(huge.id, { legId: huge.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
  ).rejects.toThrow(LifecycleValidationError);
  expect(await rows()).toEqual(before);
  const expensive = await position([{ ...dram, strike: m("99999999.9999") }]);
  await expect(
    repo().assignPosition(expensive.id, {
      legId: expensive.legId,
      tradeDate: d("2026-10-16"),
      fees: m("0"),
    }),
  ).rejects.toThrow(LifecycleValidationError);
});

test("position lock makes a close immediately ineligible for manual marks", async () => {
  const p = await position([stock], { strategy: "stock", role: "swing" });
  const result = await repo().closePosition(p.id, {
    tradeDate: d("2026-10-01"),
    fills: [{ legId: p.legId, quantity: 100, price: m("30"), fees: m("0") }],
  });
  expect(result?.realized[0]?.pnl).toBe(5000000);
  await expect(
    campaignRepository(database.db).saveManualMark(p.legId, {
      asOf: d("2026-10-01"),
      price: m("31"),
      source: "manual",
    }),
  ).rejects.toThrow("open swing leg");
});

test("unknown positions and unknown hedge target return null", async () => {
  const id = randomUUID();
  expect(await repo().closePosition(id, close(randomUUID()))).toBeNull();
  expect(await repo().expirePosition(id, { tradeDate: d("2026-10-16") })).toBeNull();
  expect(
    await repo().assignPosition(id, {
      legId: randomUUID(),
      tradeDate: d("2026-10-16"),
      fees: m("0"),
    }),
  ).toBeNull();
  expect(await repo().linkHedge(id, { campaignId: randomUUID() })).toBeNull();
  const p = await position([muu], { role: "hedge" });
  expect(await repo().linkHedge(p.id, { campaignId: randomUUID() })).toBeNull();
});

test("link open hedge into same-account campaign, adjust target opening and preserve source audit", async () => {
  const p = await position([muu], { role: "hedge" });
  const target = await campaign("2026-10-01");
  const source = (await rows()).campaigns.find((row) => row.id === p.campaignId);
  const result = await repo().linkHedge(p.id, { campaignId: target.id });
  expect(result).toEqual({ positionId: p.id, campaignId: target.id });
  const saved = await rows();
  expect(saved.campaigns.find((row) => row.id === p.campaignId)).toEqual(source);
  expect(saved.campaigns.find((row) => row.id === target.id)?.openedOn).toBe("2026-09-01");
  expect(saved.positions.find((row) => row.id === p.id)?.campaignId).toBe(target.id);
  expect(await repo().linkHedge(p.id, { campaignId: target.id })).toEqual(result);
  expect(await rows()).toEqual(saved);
});

test("link forbids income, closed hedge, roll chain and rolled trade", async () => {
  const target = await campaign();
  const p = await position();
  await expect(repo().linkHedge(p.id, { campaignId: target.id })).rejects.toThrow(
    LifecycleValidationError,
  );
  const hedge = await position([muu], { role: "hedge" });
  await repo().expirePosition(hedge.id, { tradeDate: d("2026-10-16") });
  await expect(repo().linkHedge(hedge.id, { campaignId: target.id })).rejects.toThrow(
    LifecycleConflictError,
  );
  const rolling = await position([muu], { role: "hedge" });
  const [chain] = await database.db
    .insert(s.rollChains)
    .values({ campaignId: rolling.campaignId })
    .returning();
  assert(chain);
  await database.db
    .update(s.positions)
    .set({ rollChainId: chain.id })
    .where(eq(s.positions.id, rolling.id));
  await expect(repo().linkHedge(rolling.id, { campaignId: target.id })).rejects.toThrow(
    LifecycleConflictError,
  );
  const rolled = await position([muu], { role: "hedge" });
  const [roll] = await database.db
    .insert(s.rolls)
    .values({ rollChainId: chain.id, rolledOn: "2026-09-01" })
    .returning();
  assert(roll);
  await database.db
    .update(s.trades)
    .set({ rollId: roll.id })
    .where(eq(s.trades.legId, rolled.legId));
  const before = await rows();
  await expect(repo().linkHedge(rolled.id, { campaignId: target.id })).rejects.toThrow(
    LifecycleConflictError,
  );
  expect(await rows()).toEqual(before);
});

test("single-account boundary rejects lifecycle and cross-account linking without writes", async () => {
  const p = await position([muu], { role: "hedge" });
  const [other] = await database.db
    .insert(s.accounts)
    .values({ label: "Other", broker: "manual" })
    .returning();
  assert(other);
  const target = await campaign("2026-09-01", other.id);
  const before = await rows();
  await expect(repo().closePosition(p.id, close(p.legId))).rejects.toThrow("single account");
  await expect(repo().expirePosition(p.id, { tradeDate: d("2026-10-16") })).rejects.toThrow(
    "single account",
  );
  await expect(
    repo().assignPosition(p.id, { legId: p.legId, tradeDate: d("2026-10-16"), fees: m("0") }),
  ).rejects.toThrow("single account");
  await expect(repo().linkHedge(p.id, { campaignId: target.id })).rejects.toThrow("account");
  expect(await rows()).toEqual(before);
});

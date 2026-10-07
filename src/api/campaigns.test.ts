import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Database } from "../db/database.ts";
import { repository } from "../db/repository.ts";
import * as s from "../db/schema.ts";
import { seedBook } from "../db/seed.ts";
import { testDatabase } from "../db/test/database.ts";
import type { CampaignResponse } from "../domain/campaign.ts";
import { buildCampaignView } from "../domain/campaignMetrics.ts";
import { formatMoney4, parseMoney4 as m } from "../domain/money.ts";
import { createApp } from "./app.ts";

const now = new Date("2026-10-02T03:30:00Z");
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let nvdlId: string;
let aaplLegId: string;
let crwdLegId: string;
let dramId: string;
let closedLegId: string;
let incomeLegId: string;

/** Seed a recorded DRAM assignment and covered call for campaign HTTP assertions. */
async function wheel(db: Database) {
  const [account] = await db.select().from(s.accounts);
  assert(account);
  const [campaign] = await db
    .insert(s.campaigns)
    .values({ accountId: account.id, title: "Recorded DRAM wheel", openedOn: "2026-09-01" })
    .returning();
  assert(campaign);
  const put = await repository(db).createPosition({
    id: "00000000-0000-4000-9000-000000000101",
    campaignId: campaign.id,
    underlying: "DRAM",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-01",
    legs: [
      {
        kind: "put",
        side: "short",
        underlying: "DRAM",
        strike: m("55"),
        expiry: "2026-09-18",
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
      },
    ],
  });
  const [putLeg] = await db.select().from(s.legs).where(eq(s.legs.positionId, put));
  assert(putLeg);
  closedLegId = putLeg.id;
  await repository(db).appendTrades(put, [
    {
      legId: putLeg.id,
      action: "assign",
      tradeDate: "2026-09-18",
      quantity: 15,
      price: m("0"),
      cash: m("0"),
    },
  ]);
  const stock = await repository(db).createPosition({
    id: "00000000-0000-4000-9000-000000000102",
    campaignId: campaign.id,
    underlying: "DRAM",
    strategy: "stock",
    role: "income",
    openedOn: "2026-09-18",
    legs: [
      {
        kind: "stock",
        side: "long",
        underlying: "DRAM",
        multiplier: 1,
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-18",
            quantity: 1500,
            price: m("55"),
            cash: m("-82500"),
          },
        ],
      },
    ],
  });
  const [stockLeg] = await db.select().from(s.legs).where(eq(s.legs.positionId, stock));
  assert(stockLeg);
  const [stockTrade] = await db.select().from(s.trades).where(eq(s.trades.legId, stockLeg.id));
  const putTrades = await db.select().from(s.trades).where(eq(s.trades.legId, putLeg.id));
  const optionTrade = putTrades.find((t) => t.action === "assign");
  assert(stockTrade && optionTrade);
  await db.insert(s.assignments).values({
    optionTradeId: optionTrade.id,
    stockTradeId: stockTrade.id,
    shares: 1500,
    premiumPerShare: m("2"),
  });
  await repository(db).createPosition({
    id: "00000000-0000-4000-9000-000000000103",
    campaignId: campaign.id,
    underlying: "DRAM",
    strategy: "cc",
    role: "income",
    openedOn: "2026-09-18",
    legs: [
      {
        kind: "call",
        side: "short",
        underlying: "DRAM",
        coveredLegId: stockLeg.id,
        strike: m("55"),
        expiry: "2026-10-16",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-18",
            quantity: 15,
            price: m("1.10"),
            cash: m("1650"),
          },
        ],
      },
    ],
  });
  return campaign.id;
}

beforeAll(async () => {
  database = await testDatabase();
  const { db } = database;
  await seedBook(db);
  const positions = await db.select().from(s.positions);
  for (const [underlying, target] of [
    ["NVDL", "campaign"],
    ["AAPL", "leg"],
    ["CRWD", "leg"],
  ] as const) {
    const position = positions.find((p) => p.underlying === underlying);
    assert(position);
    if (target === "campaign") nvdlId = position.campaignId;
    else {
      const [leg] = await db.select().from(s.legs).where(eq(s.legs.positionId, position.id));
      assert(leg);
      if (underlying === "AAPL") aaplLegId = leg.id;
      else crwdLegId = leg.id;
    }
  }
  const income = positions.find((p) => p.strategy === "csp");
  assert(income);
  const [incomeLeg] = await db.select().from(s.legs).where(eq(s.legs.positionId, income.id));
  assert(incomeLeg);
  incomeLegId = incomeLeg.id;
  dramId = await wheel(db);
  app = createApp({ withDb: (use) => use(db), now: () => now });
}, 20_000);
afterAll(async () => {
  await database.client.close();
});

const mark = (id: string, body: unknown) =>
  app.request(`/api/legs/${id}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET returns an uncached, grouped NVDL snapshot with literal opening trades", async () => {
  const response = await app.request(`/api/campaigns/${nvdlId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = (await response.json()) as CampaignResponse;
  expect(body.asOf).toBe("2026-10-01");
  expect(body.assignments).toEqual([]);
  expect(body.positions.map((p) => p.underlying)).toEqual(["NVDL", "NVDL", "NVDA"]);
  expect(
    body.positions
      .flatMap((p) => p.legs.flatMap((l) => l.trades))
      .map((t) => t.cash)
      .sort((a, b) => a - b),
  ).toEqual([-2180000, 0, 9500000, 14000000]);
});

test("GET returns recorded assignment data and a covered call in a separate position", async () => {
  const response = await app.request(`/api/campaigns/${dramId}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as CampaignResponse;
  expect(body.positions.map((p) => p.strategy)).toEqual(["csp", "stock", "cc"]);
  expect(body.assignments).toHaveLength(1);
  expect(body.assignments[0]).toMatchObject({ shares: 1500, premiumPerShare: 20000 });
  expect(body.positions[0]?.closedOn).toBe("2026-09-18");
  expect(body.positions[0]?.legs[0]?.trades.map((t) => t.action)).toEqual(["open", "assign"]);
  expect(body.positions[1]?.legs[0]?.trades[0]?.price).toBe(550000);
  expect(body.positions[2]?.legs[0]?.coveredLegId).toBe(body.positions[1]?.legs[0]?.id);
  const view = buildCampaignView(body);
  expect(view.csp).toBeNull();
  expect(view.coveredCalls).toEqual([
    {
      positionId: "00000000-0000-4000-9000-000000000103",
      underlying: "DRAM",
      collateral: 825000000,
      shares: 1500,
      basis: 530000,
      basisSource: "assignment",
      adjustedBasis: 519000,
      premium: 16500000,
      strike: 550000,
      calledAwayGain: 46500000,
    },
  ]);
  expect(
    view.timeline.map((event) => [
      event.kind,
      event.trade.action,
      event.assignment?.shares ?? null,
    ]),
  ).toEqual([
    ["put", "open", null],
    ["put", "assign", 1500],
    ["stock", "open", 1500],
    ["call", "open", null],
  ]);
});

test("seeded NVDL reproduces every T3 scenario number through the read API", async () => {
  const response = await app.request(`/api/campaigns/${nvdlId}`);
  expect(response.status).toBe(200);
  const view = buildCampaignView((await response.json()) as CampaignResponse);
  expect(view.csp).toMatchObject({
    premium: 23500000,
    capital: 725000000,
    hedgeDebit: 2180000,
    hedgePayout: 10000000,
    noAssignment: { netProfit: 21320000, term: 31 },
    assigned: {
      cash: 31320000,
      shares: 1000,
      basisBeforeHedge: [722000, 681000],
      hedgeCut: 7820,
      effectiveBasis: [714180, 673180],
    },
  });
  assert(view.csp);
  expect((view.csp.noAssignment.periodYield * 100).toFixed(2)).toBe("2.94");
  expect((view.csp.noAssignment.annualized * 100).toFixed(1)).toBe("34.6");
  expect((view.csp.assigned.cashYield * 100).toFixed(2)).toBe("4.32");
  expect(formatMoney4(view.csp.assigned.hedgeCut, 2)).toBe("0.78");
  expect(view.csp.assigned.effectiveBasis.map((basis) => formatMoney4(basis, 2))).toEqual([
    "71.42",
    "67.32",
  ]);
});

test("seeded DRAM opening basis has no invented assignment history", async () => {
  const [position] = await database.db
    .select()
    .from(s.positions)
    .where(eq(s.positions.strategy, "cc"))
    .orderBy(s.positions.id);
  assert(position);
  const response = await app.request(`/api/campaigns/${position.campaignId}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as CampaignResponse;
  expect(body.assignments).toEqual([]);
  const view = buildCampaignView(body);
  expect(view.coveredCalls[0]).toMatchObject({
    underlying: "DRAM",
    basis: 530000,
    basisSource: "opening",
    adjustedBasis: 519000,
  });
  expect(view.timeline.map((event) => event.trade.action)).toEqual(["open", "open"]);
});

test("defaults manual marks to New York today, accepts four decimals and replaces idempotently", async () => {
  const response = await mark(aaplLegId, { price: "5.1001" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    legId: aaplLegId,
    asOf: "2026-10-01",
    price: 51001,
    source: "manual",
  });
  const replace = await mark(aaplLegId, { price: "5.10", asOf: "2026-10-01" });
  expect(replace.status).toBe(200);
  expect(await replace.json()).toEqual({
    legId: aaplLegId,
    asOf: "2026-10-01",
    price: 51000,
    source: "manual",
  });
  expect(await database.db.select().from(s.marks).where(eq(s.marks.legId, aaplLegId))).toEqual([
    { legId: aaplLegId, asOf: "2026-10-01", price: 51000, source: "manual" },
  ]);
  const past = await mark(crwdLegId, { price: "471.30", asOf: "2026-09-30" });
  expect(past.status).toBe(200);
  expect(await past.json()).toEqual({
    legId: crwdLegId,
    asOf: "2026-09-30",
    price: 4713000,
    source: "manual",
  });
});

test("saved manual marks drive AAPL -270 and CRWD +805 through campaign views", async () => {
  for (const [legId, unrealized] of [
    [aaplLegId, -2700000],
    [crwdLegId, 8050000],
  ] as const) {
    const [row] = await database.db
      .select({ campaignId: s.positions.campaignId })
      .from(s.positions)
      .innerJoin(s.legs, eq(s.legs.positionId, s.positions.id))
      .where(eq(s.legs.id, legId));
    assert(row);
    const response = await app.request(`/api/campaigns/${row.campaignId}`);
    expect(response.status).toBe(200);
    const view = buildCampaignView((await response.json()) as CampaignResponse);
    expect(view.swings).toHaveLength(1);
    expect(view.swings[0]).toMatchObject({ legId, unrealized });
  }
});

test.each(
  [
    null,
    [],
    {},
    { price: 5.1 },
    { price: true },
    { price: "" },
    { price: "5e1" },
    { price: " 5" },
    { price: "+5" },
    { price: "5.12345" },
    { price: "0" },
    { price: "-5" },
    { price: "100000000" },
    { price: "99999999999999999999999" },
    { price: "5", asOf: null },
    { price: "5", asOf: 1 },
    { price: "5", asOf: "2026-02-30" },
    { price: "5", asOf: "2026-10-02" },
    { price: "5", source: "feed" },
  ].map((body) => ({ body })),
)("rejects invalid mark %j without changing rows", async ({ body }) => {
  const before = await database.db
    .select()
    .from(s.marks)
    .orderBy(s.marks.legId, s.marks.asOf, s.marks.source);
  expect((await mark(aaplLegId, body)).status).toBe(400);
  expect(
    await database.db.select().from(s.marks).orderBy(s.marks.legId, s.marks.asOf, s.marks.source),
  ).toEqual(before);
});

test("malformed JSON fails before writing", async () => {
  const before = await database.db.select().from(s.marks);
  const response = await app.request(`/api/legs/${aaplLegId}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect(await database.db.select().from(s.marks)).toEqual(before);
});

test("invalid UUIDs are 400, unknown UUIDs are 404", async () => {
  expect((await app.request("/api/campaigns/not-a-uuid")).status).toBe(400);
  expect((await mark("bad", { price: "5" })).status).toBe(400);
  expect((await app.request(`/api/campaigns/${randomUUID()}`)).status).toBe(404);
  expect((await mark(randomUUID(), { price: "5" })).status).toBe(404);
});

test("marks reject closed and non-swing legs as 409 without writing", async () => {
  for (const legId of [incomeLegId, closedLegId]) {
    expect((await mark(legId, { price: "5" })).status).toBe(409);
    expect(await database.db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([]);
  }
});

test.each([
  { asOf: "2026-09-17", status: 400 },
  { asOf: "2026-09-18", status: 200 },
  { asOf: "2026-09-19", status: 200 },
  { asOf: "2026-09-20", status: 400 },
  { asOf: "2026-09-21", status: 400 },
  { asOf: "2026-09-30", status: 200 },
])("manual mark date eligibility: $asOf returns $status", async ({ asOf, status }) => {
  const { db } = database;
  const legId = randomUUID();
  const positionId = await repository(db).createPosition({
    campaignId: nvdlId,
    underlying: "AAPL",
    strategy: "long_call",
    role: "swing",
    openedOn: "2026-09-01",
    legs: [
      {
        id: legId,
        kind: "call",
        side: "long",
        underlying: "AAPL",
        strike: m("250"),
        expiry: "2026-11-20",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-18",
            quantity: 1,
            price: m("7.80"),
            cash: m("-780"),
          },
        ],
      },
    ],
  });
  await repository(db).appendTrades(positionId, [
    {
      legId,
      action: "close",
      tradeDate: "2026-09-20",
      quantity: 1,
      price: m("5.10"),
      cash: m("510"),
    },
    {
      legId,
      action: "open",
      tradeDate: "2026-09-30",
      quantity: 1,
      price: m("7.80"),
      cash: m("-780"),
    },
  ]);
  const response = await mark(legId, { asOf, price: "5.10" });
  expect(response.status).toBe(status);
  if (status === 400) {
    expect(await response.json()).toEqual({ error: "Leg was not open on mark date" });
    expect(await db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([]);
  } else {
    expect(await response.json()).toEqual({ legId, asOf, price: 51000, source: "manual" });
    expect(await db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([
      { legId, asOf, price: 51000, source: "manual" },
    ]);
  }
});

test("database failures propagate to the application error boundary", async () => {
  const broken = createApp({
    withDb: async () => {
      throw new Error("DB unavailable");
    },
    now: () => now,
  });
  expect((await broken.request(`/api/campaigns/${nvdlId}`)).status).toBe(500);
  expect(
    (
      await broken.request(`/api/legs/${aaplLegId}/mark`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price: "5" }),
      })
    ).status,
  ).toBe(500);
});

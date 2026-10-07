import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parseIsoDate as d } from "../domain/dates.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { campaignRepository } from "./campaigns.ts";
import type { Database } from "./database.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { testDatabase } from "./test/database.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
let campaignId: string;
let swingLegId: string;
let incomeLegId: string;
let closedLegId: string;
let assignment: typeof s.assignments.$inferSelect;
const asOf = d("2026-10-01");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function position(
  db: Database,
  campaignId: string,
  n: number,
  role: "income" | "swing",
  closed = false,
) {
  const positionId = await repository(db).createPosition({
    id: id(n),
    campaignId,
    underlying: role === "swing" ? "AAPL" : "DRAM",
    strategy: role === "swing" ? "long_call" : "csp",
    role,
    openedOn: "2026-09-01",
    legs: [
      {
        id: id(n + 1),
        kind: role === "swing" ? "call" : "put",
        side: role === "swing" ? "long" : "short",
        underlying: role === "swing" ? "AAPL" : "DRAM",
        strike: m(role === "swing" ? "250" : "55"),
        expiry: "2026-10-16",
        trades: [
          {
            id: id(n + 2),
            action: "open",
            tradeDate: "2026-09-01",
            quantity: role === "swing" ? 1 : 15,
            price: m(role === "swing" ? "7.80" : "2.00"),
            cash: m(role === "swing" ? "-780" : "3000"),
            fees: m("-9.90"),
            createdAt: new Date("2026-09-01T16:00:00Z"),
          },
        ],
      },
    ],
  });
  if (closed)
    await repository(db).appendTrades(positionId, [
      {
        id: id(n + 3),
        legId: id(n + 1),
        action: "assign",
        tradeDate: "2026-09-18",
        quantity: 15,
        price: m("0"),
        cash: m("0"),
      },
    ]);
  return id(n + 1);
}

beforeAll(async () => {
  database = await testDatabase();
  const { db } = database;
  const [account] = await db
    .insert(s.accounts)
    .values({ label: "test", broker: "manual" })
    .returning();
  assert(account);
  const [campaign] = await db
    .insert(s.campaigns)
    .values({
      accountId: account.id,
      title: "DRAM wheel",
      openedOn: "2026-09-01",
      notes: "recorded",
    })
    .returning();
  assert(campaign);
  campaignId = campaign.id;
  // Insert positions out of order: reads must order by openedOn/id, not insertion order.
  swingLegId = await position(db, campaignId, 40, "swing");
  incomeLegId = await position(db, campaignId, 30, "income");
  closedLegId = await position(db, campaignId, 10, "income", true);
  await repository(db).createPosition({
    id: id(20),
    campaignId,
    underlying: "DRAM",
    strategy: "stock",
    role: "income",
    openedOn: "2026-09-18",
    legs: [
      {
        id: id(21),
        kind: "stock",
        side: "long",
        underlying: "DRAM",
        multiplier: 1,
        trades: [
          {
            id: id(22),
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
  const [link] = await db
    .insert(s.assignments)
    .values({
      id: id(50),
      optionTradeId: id(13),
      stockTradeId: id(22),
      shares: 1500,
      premiumPerShare: m("2"),
    })
    .returning();
  assert(link);
  assignment = link;
  await db.insert(s.marks).values([
    { legId: swingLegId, asOf: "2026-09-30", source: "manual", price: m("4.00") },
    { legId: swingLegId, asOf: "2026-10-01", source: "manual", price: m("5.10") },
    { legId: swingLegId, asOf: "2026-10-01", source: "feed", price: m("9.99") },
    { legId: swingLegId, asOf: "2026-10-02", source: "feed", price: m("6.00") },
  ]);
}, 20_000);
afterAll(async () => {
  await database.client.close();
});

test("reads complete history, assignment and a deterministic manual-priority mark snapshot", async () => {
  const response = await campaignRepository(database.db).readCampaign(campaignId, asOf);
  expect(response).toMatchObject({
    id: campaignId,
    title: "DRAM wheel",
    openedOn: "2026-09-01",
    closedOn: null,
    notes: "recorded",
    asOf: "2026-10-01",
  });
  assert(response);
  expect(response.positions.map((p) => p.id)).toEqual([id(10), id(30), id(40), id(20)]);
  expect(response.positions[0]?.closedOn).toBe("2026-09-18");
  expect(response.positions[0]?.legs[0]?.trades).toEqual([
    {
      id: id(12),
      action: "open",
      tradeDate: "2026-09-01",
      quantity: 15,
      price: 20000,
      cash: 30000000,
      fees: -99000,
    },
    {
      id: id(13),
      action: "assign",
      tradeDate: "2026-09-18",
      quantity: 15,
      price: 0,
      cash: 0,
      fees: 0,
    },
  ]);
  expect(response.assignments).toEqual([assignment]);
  expect(response.positions[2]?.legs[0]?.mark).toEqual({
    asOf: "2026-10-01",
    price: 51000,
    source: "manual",
  });
  expect(response.positions[0]?.legs[0]?.mark).toBeNull();
  const future = await campaignRepository(database.db).readCampaign(campaignId, d("2026-10-02"));
  expect(future?.positions[2]?.legs[0]?.mark).toEqual({
    asOf: "2026-10-02",
    price: 60000,
    source: "feed",
  });
  const old = await campaignRepository(database.db).readCampaign(campaignId, d("2026-09-01"));
  expect(old?.positions[2]?.legs[0]?.mark).toBeNull();
});

test("repeat campaign reads and asOf changes retain every position revision", async () => {
  const repo = campaignRepository(database.db);
  const first = await repo.readCampaign(campaignId, asOf);
  assert(first);
  for (const position of first.positions) expect(position.revision).toMatch(/^[0-9a-f]{64}$/);
  const revisions = first.positions.map((position) => [position.id, position.revision]);
  expect(
    (await repo.readCampaign(campaignId, asOf))?.positions.map((position) => [
      position.id,
      position.revision,
    ]),
  ).toEqual(revisions);
  expect(
    (await repo.readCampaign(campaignId, d("2026-10-02")))?.positions.map((position) => [
      position.id,
      position.revision,
    ]),
  ).toEqual(revisions);
});

test("orders legs by id and same-day trades by createdAt then id", async () => {
  const { db } = database;
  await db.insert(s.legs).values([
    {
      id: id(46),
      positionId: id(40),
      kind: "stock",
      side: "long",
      underlying: "AAPL",
      multiplier: 1,
    },
    {
      id: id(45),
      positionId: id(40),
      kind: "stock",
      side: "long",
      underlying: "AAPL",
      multiplier: 1,
    },
  ]);
  await db.insert(s.trades).values(
    [44, 43].map((n) => ({
      id: id(n),
      legId: swingLegId,
      action: "open" as const,
      tradeDate: "2026-09-01",
      quantity: 1,
      price: m("7.80"),
      cash: m("-780"),
      createdAt: new Date(n === 44 ? "2026-09-01T15:00:00Z" : "2026-09-01T16:00:00Z"),
    })),
  );
  const response = await campaignRepository(db).readCampaign(campaignId, asOf);
  expect(response?.positions[2]?.legs.map((l) => l.id)).toEqual([id(41), id(45), id(46)]);
  expect(response?.positions[2]?.legs[0]?.trades.map((t) => t.id)).toEqual([
    id(44),
    id(42),
    id(43),
  ]);
});

test("includes assignments when only the stock or only the option side belongs to the campaign", async () => {
  const { db } = database;
  const [original] = await db.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId));
  assert(original);
  const [other] = await db
    .insert(s.campaigns)
    .values({ accountId: original.accountId, title: "stock only", openedOn: "2026-09-18" })
    .returning();
  assert(other);
  await db
    .update(s.positions)
    .set({ campaignId: other.id })
    .where(eq(s.positions.id, id(20)));
  expect((await campaignRepository(db).readCampaign(other.id, asOf))?.assignments).toEqual([
    assignment,
  ]);
  expect((await campaignRepository(db).readCampaign(campaignId, asOf))?.assignments).toEqual([
    assignment,
  ]);
});

test("upserts manual marks losslessly without replacing feed marks", async () => {
  const repo = campaignRepository(database.db);
  const before = (await repo.readCampaign(campaignId, asOf))?.positions.map((position) => [
    position.id,
    position.revision,
  ]);
  assert(before);
  expect(
    await repo.saveManualMark(swingLegId, { asOf, price: m("5.1001"), source: "manual" }),
  ).toEqual({ legId: swingLegId, asOf, price: 51001, source: "manual" });
  expect(
    await repo.saveManualMark(swingLegId, { asOf, price: m("5.20"), source: "manual" }),
  ).toEqual({ legId: swingLegId, asOf, price: 52000, source: "manual" });
  const rows = await database.db
    .select()
    .from(s.marks)
    .where(eq(s.marks.legId, swingLegId))
    .orderBy(s.marks.asOf, s.marks.source);
  expect(rows).toEqual([
    { legId: swingLegId, asOf: "2026-09-30", price: 40000, source: "manual" },
    { legId: swingLegId, asOf: "2026-10-01", price: 99900, source: "feed" },
    { legId: swingLegId, asOf: "2026-10-01", price: 52000, source: "manual" },
    { legId: swingLegId, asOf: "2026-10-02", price: 60000, source: "feed" },
  ]);
  expect(
    (await repo.readCampaign(campaignId, asOf))?.positions.map((position) => [
      position.id,
      position.revision,
    ]),
  ).toEqual(before);
});

test("unknown campaign/leg is absent and ineligible marks leave no rows", async () => {
  const repo = campaignRepository(database.db);
  expect(await repo.readCampaign(randomUUID(), asOf)).toBeNull();
  expect(
    await repo.saveManualMark(randomUUID(), { asOf, price: m("5"), source: "manual" }),
  ).toBeNull();
  for (const legId of [incomeLegId, closedLegId, id(45)]) {
    await expect(
      repo.saveManualMark(legId, { asOf, price: m("5"), source: "manual" }),
    ).rejects.toThrow("open swing leg");
    expect(await database.db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([]);
  }
});

test("a swing position's closed leg cannot be marked even when another leg is open", async () => {
  const { db } = database;
  const [balance] = await db.select().from(s.trades).where(eq(s.trades.legId, swingLegId));
  assert(balance);
  await repository(db).appendTrades(id(40), [
    {
      legId: swingLegId,
      action: "close",
      tradeDate: "2026-10-01",
      quantity: 3,
      price: m("5"),
      cash: m("1500"),
    },
    {
      legId: id(45),
      action: "open",
      tradeDate: "2026-10-01",
      quantity: 1,
      price: m("10"),
      cash: m("-10"),
    },
  ]);
  await expect(
    campaignRepository(db).saveManualMark(swingLegId, { asOf, price: m("8"), source: "manual" }),
  ).rejects.toThrow("open swing leg");
  expect(
    (await db.select().from(s.marks).where(eq(s.marks.legId, swingLegId))).find(
      (mark) => mark.asOf === asOf && mark.source === "manual",
    )?.price,
  ).toBe(52000);
});

test("a fully closed swing position rejects marks transactionally", async () => {
  const { db } = database;
  const legId = await position(db, campaignId, 70, "swing");
  await repository(db).appendTrades(id(70), [
    { legId, action: "close", tradeDate: "2026-10-01", quantity: 1, price: m("5"), cash: m("500") },
  ]);
  await expect(
    campaignRepository(db).saveManualMark(legId, { asOf, price: m("5"), source: "manual" }),
  ).rejects.toThrow("open swing leg");
  expect(await db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([]);
});

test("manual marks require the leg's opening date, not the position's opening date", async () => {
  const { db } = database;
  await position(db, campaignId, 80, "swing");
  const legId = id(84);
  await db.insert(s.legs).values({
    id: legId,
    positionId: id(80),
    kind: "call",
    side: "long",
    underlying: "AAPL",
    strike: m("250"),
    expiry: "2026-10-16",
  });
  await repository(db).appendTrades(id(80), [
    {
      legId,
      action: "open",
      tradeDate: "2026-09-18",
      quantity: 1,
      price: m("7.80"),
      cash: m("-780"),
    },
  ]);
  const repo = campaignRepository(db);
  await expect(
    repo.saveManualMark(legId, { asOf: d("2026-09-17"), price: m("5.10"), source: "manual" }),
  ).rejects.toThrow("Leg was not open on mark date");
  expect(await db.select().from(s.marks).where(eq(s.marks.legId, legId))).toEqual([]);
  for (const date of ["2026-09-18", "2026-09-30"]) {
    expect(
      await repo.saveManualMark(legId, { asOf: d(date), price: m("5.10"), source: "manual" }),
    ).toEqual({ legId, asOf: date, price: 51000, source: "manual" });
  }
});

test("closed-gap marks reject without replacing existing marks even after the leg reopens", async () => {
  const { db } = database;
  const legId = await position(db, campaignId, 90, "swing");
  await repository(db).appendTrades(id(90), [
    {
      legId,
      action: "close",
      tradeDate: "2026-09-18",
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
  await db.insert(s.marks).values([
    { legId, asOf: "2026-09-20", source: "manual", price: m("5.10") },
    { legId, asOf: "2026-09-20", source: "feed", price: m("7.80") },
  ]);
  await expect(
    campaignRepository(db).saveManualMark(legId, {
      asOf: d("2026-09-20"),
      price: m("5.20"),
      source: "manual",
    }),
  ).rejects.toThrow("Leg was not open on mark date");
  expect(
    await db.select().from(s.marks).where(eq(s.marks.legId, legId)).orderBy(s.marks.source),
  ).toEqual([
    { legId, asOf: "2026-09-20", source: "feed", price: 78000 },
    { legId, asOf: "2026-09-20", source: "manual", price: 51000 },
  ]);
});

test("multiple accounts fail loudly instead of silently selecting or merging", async () => {
  await database.db.insert(s.accounts).values({ label: "second", broker: "manual" });
  await expect(campaignRepository(database.db).readCampaign(campaignId, asOf)).rejects.toThrow(
    "More than one account",
  );
});

test("empty accounts and campaigns return null", async () => {
  const empty = await testDatabase();
  try {
    expect(await campaignRepository(empty.db).readCampaign(randomUUID(), asOf)).toBeNull();
    const [account] = await empty.db
      .insert(s.accounts)
      .values({ label: "empty", broker: "manual" })
      .returning();
    assert(account);
    const [campaign] = await empty.db
      .insert(s.campaigns)
      .values({
        accountId: account.id,
        title: "closed empty campaign",
        openedOn: "2026-09-01",
        closedOn: "2026-09-02",
      })
      .returning();
    assert(campaign);
    expect(await campaignRepository(empty.db).readCampaign(campaign.id, asOf)).toEqual({
      id: campaign.id,
      title: "closed empty campaign",
      openedOn: "2026-09-01",
      closedOn: "2026-09-02",
      notes: null,
      asOf,
      positions: [],
      assignments: [],
    });
  } finally {
    await empty.client.close();
  }
});

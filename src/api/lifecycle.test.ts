import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { LifecycleResponse } from "../contracts/lifecycle.ts";
import { repository } from "../db/repository.ts";
import * as s from "../db/schema.ts";
import { testDatabase } from "../db/test/database.ts";
import type { CampaignResponse } from "../domain/campaign.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { createApp } from "./app.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let accountId: string;
beforeAll(async () => {
  database = await testDatabase();
  const [account] = await database.db
    .insert(s.accounts)
    .values({ label: "Lifecycle", broker: "manual" })
    .returning();
  assert(account);
  accountId = account.id;
  app = createApp({
    withDb: (use) => use(database.db),
    now: () => new Date("2026-10-17T03:30:00Z"),
  });
}, 20_000);
afterAll(async () => {
  await database.client.close();
});

async function put(
  underlying = "MUU",
  quantity = 10,
  price = "1.50",
  cash = "1500",
  fees = "-6.60",
  strike = "25",
) {
  const [campaign] = await database.db
    .insert(s.campaigns)
    .values({ accountId, title: underlying, openedOn: "2026-09-15" })
    .returning();
  assert(campaign);
  const legId = randomUUID();
  const positionId = await repository(database.db).createPosition({
    campaignId: campaign.id,
    underlying,
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-15",
    legs: [
      {
        id: legId,
        kind: "put",
        side: "short",
        underlying,
        strike: m(strike),
        expiry: "2026-10-16",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-15",
            quantity,
            price: m(price),
            cash: m(cash),
            fees: m(fees),
          },
        ],
      },
    ],
  });
  return { positionId, campaignId: campaign.id, legId };
}
const post = (id: string, action: string, body: unknown) =>
  app.request(`/api/positions/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("MUU expiry books 1493.40 through HTTP; second expiry conflicts without double booking", async () => {
  const fixture = await put();
  const response = await post(fixture.positionId, "expire", {});
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = (await response.json()) as LifecycleResponse;
  expect(body.closedOn).toBe("2026-10-16");
  expect(body.realized).toEqual([
    {
      tradeId: body.tradeIds[0],
      quantity: 10,
      openingCash: 15000000,
      openingFees: -66000,
      pnl: 14934000,
      bookedMonth: "2026-10",
    },
  ]);
  expect((await post(fixture.positionId, "expire", {})).status).toBe(409);
  expect(
    await database.db.select().from(s.trades).where(eq(s.trades.legId, fixture.legId)),
  ).toHaveLength(2);
});

test("SPXL buyback books 537.40 and closes its position", async () => {
  const fixture = await put("SPXL", 2, "3.10", "620", "-1.30", "240");
  const response = await post(fixture.positionId, "close", {
    tradeDate: "2026-10-16",
    fills: [{ legId: fixture.legId, quantity: 2, price: "0.40", fees: "-1.30" }],
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as LifecycleResponse;
  expect(body.realized[0]).toMatchObject({
    pnl: 5374000,
    openingCash: 6200000,
    openingFees: -13000,
    bookedMonth: "2026-10",
  });
  expect(body.closedOn).toBe("2026-10-16");
});

test("DRAM assignment books 2990.10, opens 1500 shares at 55 and records basis53 wheel timeline", async () => {
  const fixture = await put("DRAM", 15, "2", "3000", "-9.90", "55");
  const response = await post(fixture.positionId, "assign", { legId: fixture.legId });
  expect(response.status).toBe(200);
  const body = (await response.json()) as LifecycleResponse;
  expect(body.realized[0]).toMatchObject({ pnl: 29901000 });
  expect(body.assignment).toMatchObject({ shares: 1500, premiumPerShare: 20000, basis: 530000 });
  const read = await app.request(`/api/campaigns/${fixture.campaignId}`);
  expect(read.status).toBe(200);
  const campaign = (await read.json()) as CampaignResponse;
  expect(campaign.positions.map((p) => p.strategy)).toEqual(["csp", "stock"]);
  expect(campaign.assignments[0]).toMatchObject({ shares: 1500, premiumPerShare: 20000 });
  expect(
    campaign.positions
      .flatMap((p) => p.legs)
      .flatMap((l) => l.trades)
      .map((t) => t.action),
  ).toEqual(["open", "assign", "open"]);
  expect(campaign.positions[1]?.legs[0]?.trades[0]).toMatchObject({
    quantity: 1500,
    price: 550000,
    cash: -825000000,
  });
});

test("partial5/10 allocates cash and opening fees pro rata and leaves5 open", async () => {
  const fixture = await put();
  const response = await post(fixture.positionId, "close", {
    fills: [{ legId: fixture.legId, quantity: 5, price: "0.40", fees: "-1.30" }],
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as LifecycleResponse;
  expect(body.closedOn).toBeNull();
  expect(body.realized[0]).toMatchObject({
    quantity: 5,
    openingCash: 7500000,
    openingFees: -33000,
    pnl: 5454000,
  });
  const read = await app.request(`/api/campaigns/${fixture.campaignId}`);
  const campaign = (await read.json()) as CampaignResponse;
  expect(campaign.positions[0]?.legs[0]?.trades.map((t) => [t.action, t.quantity])).toEqual([
    ["open", 10],
    ["close", 5],
  ]);
});

test.each(
  [
    ["close", null],
    ["close", {}],
    ["close", { fills: [] }],
    ["close", { fills: [null] }],
    [
      "close",
      {
        fills: [
          { legId: "00000000-0000-4000-8000-000000000001", quantity: 1, price: "1" },
          { legId: "00000000-0000-4000-8000-000000000001", quantity: 1, price: "1" },
        ],
      },
    ],
    ["close", { fills: [{ legId: randomUUID(), quantity: "1", price: "1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 2147483648, price: "1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "-1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "100000000" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "1", fees: "-10000000000" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "1", extra: true }] }],
    ["close", { fills: [{ legId: "bad", quantity: 1, price: "1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 0, price: "1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1.5, price: "1" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: 1 }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "1.12345" }] }],
    ["close", { fills: [{ legId: randomUUID(), quantity: 1, price: "1", fees: "1" }] }],
    ["expire", { tradeDate: "2026-02-30" }],
    ["expire", { tradeDate: null }],
    ["expire", []],
    ["expire", { tradeDate: "2026-10-17" }],
    ["expire", { price: "1" }],
    ["assign", {}],
    ["link-hedge", { campaignId: "bad" }],
  ].map(([action, body]) => ({ action: action as string, body })),
)("invalid lifecycle body $action/$body returns400 without changes", async ({ action, body }) => {
  const fixture = await put();
  const before = await database.db.select().from(s.trades).where(eq(s.trades.legId, fixture.legId));
  expect((await post(fixture.positionId, action, body)).status).toBe(400);
  expect(
    await database.db.select().from(s.trades).where(eq(s.trades.legId, fixture.legId)),
  ).toEqual(before);
});

test("unsupported adjusted and call assignments return clear400; repeated eligible assignment is409", async () => {
  const fixture = await put("DRAM", 15, "2", "3000", "-9.90", "55");
  await database.db.update(s.legs).set({ adjusted: true }).where(eq(s.legs.id, fixture.legId));
  const adjusted = await post(fixture.positionId, "assign", { legId: fixture.legId });
  expect(adjusted.status).toBe(400);
  expect(await adjusted.json()).toMatchObject({
    error: expect.stringMatching(/unadjusted|adjusted/i),
  });
  await database.db
    .update(s.legs)
    .set({ adjusted: false, kind: "call" })
    .where(eq(s.legs.id, fixture.legId));
  const call = await post(fixture.positionId, "assign", { legId: fixture.legId });
  expect(call.status).toBe(400);
  expect(await call.json()).toMatchObject({ error: expect.stringMatching(/put|CSP/i) });
  await database.db.update(s.legs).set({ kind: "put" }).where(eq(s.legs.id, fixture.legId));
  const success = await post(fixture.positionId, "assign", { legId: fixture.legId });
  expect(success.status).toBe(200);
  const result = (await success.json()) as LifecycleResponse;
  assert(result.assignment);
  expect((await post(fixture.positionId, "assign", { legId: fixture.legId })).status).toBe(409);
  expect(
    await database.db
      .select()
      .from(s.assignments)
      .where(eq(s.assignments.optionTradeId, result.assignment.optionTradeId)),
  ).toHaveLength(1);
});

test("link moves an open hedge through HTTP, preserves source and current-campaign link is a no-op", async () => {
  const source = await put("MUU");
  const target = await put("SPXL", 2, "3.10", "620", "-1.30", "240");
  await database.db
    .update(s.positions)
    .set({ role: "hedge" })
    .where(eq(s.positions.id, source.positionId));
  const response = await post(source.positionId, "link-hedge", { campaignId: target.campaignId });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    positionId: source.positionId,
    campaignId: target.campaignId,
  });
  expect(
    (await post(source.positionId, "link-hedge", { campaignId: target.campaignId })).status,
  ).toBe(200);
  expect(
    await database.db.select().from(s.campaigns).where(eq(s.campaigns.id, source.campaignId)),
  ).toHaveLength(1);
  const campaign = await app.request(`/api/campaigns/${target.campaignId}`);
  expect(((await campaign.json()) as CampaignResponse).positions.map((p) => p.id).sort()).toEqual(
    [source.positionId, target.positionId].sort(),
  );
});

test("uppercase leg UUIDs close and assign the same stored legs", async () => {
  const closeFixture = await put();
  const closeResult = await post(closeFixture.positionId.toUpperCase(), "close", {
    fills: [{ legId: closeFixture.legId.toUpperCase(), quantity: 5, price: "0.40" }],
  });
  expect(closeResult.status).toBe(200);
  expect(((await closeResult.json()) as LifecycleResponse).realized[0]).toMatchObject({
    quantity: 5,
    pnl: 5467000,
  });
  const assignFixture = await put("DRAM", 15, "2", "3000", "-9.90", "55");
  const assigned = await post(assignFixture.positionId, "assign", {
    legId: assignFixture.legId.toUpperCase(),
  });
  expect(assigned.status).toBe(200);
  expect(((await assigned.json()) as LifecycleResponse).assignment).toMatchObject({
    shares: 1500,
    basis: 530000,
  });
});

test("held-cover shares accept a manual mark after the call expires, but not while covered", async () => {
  const fixture = await put("DRAM", 15, "2", "3000", "-9.90", "55");
  const stockLegId = randomUUID();
  const cc = await repository(database.db).createPosition({
    campaignId: fixture.campaignId,
    underlying: "DRAM",
    strategy: "cc",
    role: "income",
    openedOn: "2026-09-15",
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
            tradeDate: "2026-09-15",
            quantity: 1500,
            price: m("53"),
            cash: m("-79500"),
          },
        ],
      },
      {
        kind: "call",
        side: "short",
        underlying: "DRAM",
        strike: m("55"),
        expiry: "2026-10-16",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-15",
            quantity: 15,
            price: m("1.10"),
            cash: m("1650"),
          },
        ],
      },
    ],
  });
  const mark = () =>
    app.request(`/api/legs/${stockLegId}/mark`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: "55" }),
    });
  expect((await mark()).status).toBe(409);
  expect((await post(cc, "expire", {})).status).toBe(200);
  const marked = await mark();
  expect(marked.status).toBe(200);
  expect(await marked.json()).toMatchObject({
    legId: stockLegId,
    price: 550000,
    asOf: "2026-10-16",
  });
});

test("deployed createApp never exposes browser fixture/reset routes", async () => {
  expect((await app.request("/api/test/reset", { method: "POST" })).status).toBe(404);
  expect((await app.request("/api/test/lifecycle-fixture", { method: "POST" })).status).toBe(404);
});

test("malformed JSON and invalid/unknown ids have400/404 boundary responses", async () => {
  expect(
    (await app.request(`/api/positions/${randomUUID()}/close`, { method: "POST", body: "{" }))
      .status,
  ).toBe(400);
  expect((await post("bad", "expire", {})).status).toBe(400);
  expect((await post(randomUUID(), "expire", {})).status).toBe(404);
});

test("database failure propagates to500 rather than conflict or validation", async () => {
  const broken = createApp({
    withDb: async () => {
      throw new Error("DB unavailable");
    },
    now: () => new Date("2026-10-17T03:30:00Z"),
  });
  expect(
    (
      await broken.request(`/api/positions/${randomUUID()}/expire`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(500);
});

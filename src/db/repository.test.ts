import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { parseMoney4 as m } from "../domain/money.ts";
import { createPositionSchema } from "../shared/trade.ts";
import { toBookPositions } from "./book.ts";
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

const opening = {
  action: "open",
  tradeDate: "2026-09-01",
  quantity: 10,
  price: m("1.0850"),
  cash: m("1085"),
  fees: m("-0.6527"),
} as const;
async function position(multi = false) {
  const { db } = database;
  const [account] = await db
    .insert(s.accounts)
    .values({ label: randomUUID(), broker: "manual" })
    .returning();
  assert(account);
  const [campaign] = await db
    .insert(s.campaigns)
    .values({ accountId: account.id, title: "test", openedOn: "2026-09-01" })
    .returning();
  assert(campaign);
  const repo = repository(db);
  const id = await repo.createPosition({
    campaignId: campaign.id,
    underlying: "NVDL",
    strategy: multi ? "put_debit_spread" : "csp",
    role: multi ? "hedge" : "income",
    openedOn: "2026-09-01",
    legs: [
      {
        kind: "put",
        side: "short",
        underlying: "NVDL",
        strike: m("26.67"),
        expiry: "2026-10-16",
        trades: [opening],
      },
      ...(multi
        ? [
            {
              kind: "put" as const,
              side: "long" as const,
              underlying: "NVDL",
              strike: m("30"),
              expiry: "2026-10-16",
              trades: [opening],
            },
          ]
        : []),
    ],
  });
  const legs = await db.select().from(s.legs).where(eq(s.legs.positionId, id));
  return { repo, id, legs, accountId: account.id };
}
const close = (legId: string, quantity: number, tradeDate: string) => ({
  legId,
  action: "close" as const,
  tradeDate,
  quantity,
  price: m("0.4"),
  cash: m("-400"),
});

test("open, partial and final close maintain the event-balance invariant", async () => {
  const { repo, id, legs, accountId } = await position();
  const leg = legs[0];
  assert(leg);
  expect((await repo.readOpenPositions(accountId))[0]?.closedOn).toBeNull();
  expect(await repo.appendTrades(id, [close(leg.id, 5, "2026-09-15")])).toBeNull();
  expect(await repo.appendTrades(id, [close(leg.id, 5, "2026-09-30")])).toBe("2026-09-30");
  expect(await repo.readOpenPositions(accountId)).toEqual([]);
  expect(
    (await database.db.select().from(s.positions).where(eq(s.positions.id, id)))[0]?.closedOn,
  ).toBe("2026-09-30");
});
test("all legs must balance; final event supplies the closing date", async () => {
  const { repo, id, legs, accountId } = await position(true);
  const [first, second] = legs;
  assert(first && second);
  expect(await repo.appendTrades(id, [close(first.id, 10, "2026-09-15")])).toBeNull();
  expect(await repo.readOpenPositions(accountId)).toHaveLength(1);
  expect(await repo.appendTrades(id, [close(second.id, 10, "2026-09-30")])).toBe("2026-09-30");
});
test("invalid event batches roll back trades and position state", async () => {
  const { repo, id, legs, accountId } = await position();
  const leg = legs[0];
  assert(leg);
  await expect(repo.appendTrades(id, [close(leg.id, 11, "2026-09-15")])).rejects.toThrow("exceeds");
  const [loaded] = await repo.readOpenPositions(accountId);
  expect(loaded?.legs[0]?.trades).toHaveLength(1);
  await expect(repo.appendTrades(id, [close(randomUUID(), 1, "2026-09-15")])).rejects.toThrow(
    "not in position",
  );
  await expect(repo.appendTrades(randomUUID(), [])).rejects.toThrow("not found");
});
describe("assigned covered stock closes", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase>>;
  let ids: Awaited<ReturnType<typeof assignmentFixture>>;
  let callPositionId: string;
  let callLegId: string;
  beforeEach(async () => {
    isolated = await testDatabase();
    ids = await assignmentFixture(isolated.db);
    const call = await tradeRepository(isolated.db).create(
      createPositionSchema.parse({
        strategy: "cc",
        underlying: "DRAM",
        openedOn: "2026-09-25",
        expiry: "2026-10-09",
        quantity: 10,
        adjusted: false,
        strike: "55",
        price: "1.10",
        fees: "6.50",
        tags: ["wheel"],
        cover: { kind: "assigned", stockLegId: ids.stockLegId },
      }),
    );
    callPositionId = call.positionId;
    const [leg] = await isolated.db
      .select()
      .from(s.legs)
      .where(eq(s.legs.positionId, callPositionId));
    assert(leg);
    callLegId = leg.id;
  });
  afterEach(async () => {
    await isolated.client.close();
  });

  test.each([
    { quantity: 600, cash: m("33000") },
    { quantity: 1500, cash: m("82500") },
  ])(
    "rejects a $quantity-share close atomically and preserves a readable covered book",
    async ({ quantity, cash }) => {
      const repo = repository(isolated.db);
      const before = await repo.readOpenBook();
      expect(toBookPositions(before)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: ids.stockPositionId, shares: 500, price: 550000 }),
          expect.objectContaining({ id: callPositionId, strategy: "cc", qty: 10, basis: 530000 }),
        ]),
      );
      const trades = await isolated.db
        .select()
        .from(s.trades)
        .where(eq(s.trades.legId, ids.stockLegId));
      const positions = await isolated.db.select().from(s.positions);
      await expect(
        repo.appendTrades(ids.stockPositionId, [
          {
            legId: ids.stockLegId,
            action: "close",
            tradeDate: "2026-10-01",
            quantity,
            price: m("55"),
            cash,
          },
        ]),
      ).rejects.toThrow("Covered calls exceed stock balance");
      expect(
        await isolated.db.select().from(s.trades).where(eq(s.trades.legId, ids.stockLegId)),
      ).toEqual(trades);
      expect(await isolated.db.select().from(s.positions)).toEqual(positions);
      expect(await repo.readOpenBook()).toEqual(before);
      expect(toBookPositions(await repo.readOpenBook())).toEqual(toBookPositions(before));
    },
  );

  test.each(["multiple calls", "adjusted multiplier"])(
    "reserves all referenced shares with %s",
    async (coverage) => {
      if (coverage === "multiple calls") {
        await tradeRepository(isolated.db).create(
          createPositionSchema.parse({
            strategy: "cc",
            underlying: "DRAM",
            openedOn: "2026-09-25",
            expiry: "2026-10-09",
            quantity: 5,
            adjusted: false,
            strike: "55",
            price: "1.10",
            fees: "3.25",
            tags: ["wheel"],
            cover: { kind: "assigned", stockLegId: ids.stockLegId },
          }),
        );
      } else {
        await isolated.db
          .update(s.legs)
          .set({ multiplier: 150, adjusted: true })
          .where(eq(s.legs.id, callLegId));
      }
      await expect(
        repository(isolated.db).appendTrades(ids.stockPositionId, [
          {
            legId: ids.stockLegId,
            action: "close",
            tradeDate: "2026-10-01",
            quantity: 1,
            price: m("55"),
            cash: m("55"),
          },
        ]),
      ).rejects.toThrow("Covered calls exceed stock balance");
      expect(
        await isolated.db.select().from(s.trades).where(eq(s.trades.legId, ids.stockLegId)),
      ).toMatchObject([{ id: ids.stockTradeId, action: "open", quantity: 1500 }]);
      expect(
        await isolated.db.select().from(s.trades).where(eq(s.trades.legId, ids.stockLegId)),
      ).toHaveLength(1);
    },
  );

  test("allows closing the 500 uncovered shares without changing CC valuation", async () => {
    const repo = repository(isolated.db);
    expect(
      await repo.appendTrades(ids.stockPositionId, [
        {
          legId: ids.stockLegId,
          action: "close",
          tradeDate: "2026-10-01",
          quantity: 500,
          price: m("55"),
          cash: m("27500"),
        },
      ]),
    ).toBeNull();
    const rows = await repo.readOpenBook();
    expect(rows.find((row) => row.id === ids.stockPositionId)).toMatchObject({ closedOn: null });
    expect(toBookPositions(rows)).toMatchObject([
      { id: callPositionId, strategy: "cc", qty: 10, basis: 530000, price: 11000 },
    ]);
    expect(toBookPositions(rows)).toHaveLength(1);
    expect((await tradeRepository(isolated.db).options()).assignedStock).toEqual([]);
  });

  test("call reductions release coverage and fully closed calls no longer reserve shares", async () => {
    const repo = repository(isolated.db);
    expect(await repo.appendTrades(callPositionId, [close(callLegId, 5, "2026-10-01")])).toBeNull();
    expect(
      await repo.appendTrades(ids.stockPositionId, [
        {
          legId: ids.stockLegId,
          action: "close",
          tradeDate: "2026-10-01",
          quantity: 1000,
          price: m("55"),
          cash: m("55000"),
        },
      ]),
    ).toBeNull();
    expect(toBookPositions(await repo.readOpenBook())).toMatchObject([
      { id: callPositionId, strategy: "cc", qty: 5, basis: 530000 },
    ]);
    expect(await repo.appendTrades(callPositionId, [close(callLegId, 5, "2026-10-02")])).toBe(
      "2026-10-02",
    );
    expect(
      await repo.appendTrades(ids.stockPositionId, [
        {
          legId: ids.stockLegId,
          action: "close",
          tradeDate: "2026-10-02",
          quantity: 500,
          price: m("55"),
          cash: m("27500"),
        },
      ]),
    ).toBe("2026-10-02");
    expect(await repo.readOpenBook()).toEqual([]);
    expect(
      await isolated.db
        .select({ id: s.positions.id, closedOn: s.positions.closedOn })
        .from(s.positions)
        .where(eq(s.positions.id, ids.stockPositionId)),
    ).toEqual([{ id: ids.stockPositionId, closedOn: "2026-10-02" }]);
  });
});

test("money round trips signed fees and positive prices/strikes exactly", async () => {
  const { repo, accountId } = await position();
  const [loaded] = await repo.readOpenPositions(accountId);
  expect(loaded?.legs[0]?.strike).toBe(m("26.67"));
  expect(loaded?.legs[0]?.trades[0]?.price).toBe(m("1.0850"));
  expect(loaded?.legs[0]?.trades[0]?.fees).toBe(m("-0.6527"));
});
test("recordHeartbeat inserts one row with the given time and source", async () => {
  const { db } = database;
  const at = new Date("2026-10-04T10:07:00Z");
  await repository(db).recordHeartbeat({ at, source: "repository-test" });
  const rows = await db
    .select()
    .from(s.platformHeartbeat)
    .where(eq(s.platformHeartbeat.source, "repository-test"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.at).toEqual(at);
});

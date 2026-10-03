import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parseMoney4 as m } from "../domain/money.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { testDatabase } from "./test/database.ts";

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

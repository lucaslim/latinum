import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { RollResponse } from "../contracts/roll.ts";
import * as s from "../db/schema.ts";
import { testDatabase } from "../db/test/database.ts";
import { qqqFixture } from "../db/test/rollFixture.ts";
import { createApp } from "./app.ts";
import { noSession } from "./testGuard.ts";

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
const now = () => new Date("2026-10-02T03:30:00Z");
const request = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("POST /rolls returns lifecycle and metrics, no-store, and reused observed revision is409", async () => {
  const app = createApp({ guard: noSession, withDb: (use) => use(database.db), now });
  const f = await qqqFixture(database.db);
  const response = await app.request("/api/rolls", request(f.raw));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const result = (await response.json()) as RollResponse;
  expect(result.metrics).toMatchObject({
    realizedNet: -560000,
    rollCashGross: -700000,
    chainCashGross: -2100000,
  });
  expect(result.positionId).toBe(f.positionId);
  expect(result.tradeIds).toHaveLength(4);
  const stale = await app.request("/api/rolls", request(f.raw));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({
    error: "Position changed. Reload the campaign before another action.",
    code: "stale_revision",
  });
});

test("invalid JSON/body parses before withDb and uses NY today", async () => {
  let connected = 0;
  const app = createApp({
    guard: noSession,
    withDb: async () => {
      connected++;
      throw new Error("must not connect");
    },
    now,
  });
  const raw = {
    positionId: randomUUID(),
    expectedRevision: "0".repeat(64),
    expiry: "2026-11-06",
    fills: [{ legId: randomUUID(), closePrice: "0", strike: "55", openPrice: "1" }],
  };
  for (const body of [
    null,
    {},
    { ...raw, tradeDate: "2026-10-02" },
    { ...raw, expectedRevision: "A".repeat(64) },
    { ...raw, fills: [{ ...raw.fills[0], openFees: "1" }] },
  ]) {
    const result = await app.request("/api/rolls", request(body));
    expect(result.status).toBe(400);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  }
  expect((await app.request("/api/rolls", { method: "POST", body: "{" })).status).toBe(400);
  expect(connected).toBe(0);
});

test("unknown position is404 and invalid later expiry is400 without changed revision", async () => {
  const app = createApp({ guard: noSession, withDb: (use) => use(database.db), now });
  const f = await qqqFixture(database.db);
  expect(
    (await app.request("/api/rolls", request({ ...f.raw, positionId: randomUUID() }))).status,
  ).toBe(404);
  expect(
    (await app.request("/api/rolls", request({ ...f.raw, expiry: "2026-10-16" }))).status,
  ).toBe(400);
  const retry = await app.request("/api/rolls", request(f.raw));
  expect(retry.status).toBe(200);
  const result = (await retry.json()) as RollResponse;
  assert(result.realized[0]);
  expect(result.realized[0].bookedMonth).toBe("2026-10");
});

test("book conflicts return409 rather than500", async () => {
  const f = await qqqFixture(database.db);
  await database.db.insert(s.accounts).values({ label: "Other", broker: "manual" });
  const app = createApp({ guard: noSession, withDb: (use) => use(database.db), now });
  const response = await app.request("/api/rolls", request(f.raw));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Roll requires a single account" });
});

test("unexpected database errors remain500", async () => {
  const f = await qqqFixture(database.db);
  const app = createApp({
    guard: noSession,
    withDb: async () => {
      throw new Error("DB unavailable");
    },
    now,
  });
  expect((await app.request("/api/rolls", request(f.raw))).status).toBe(500);
});

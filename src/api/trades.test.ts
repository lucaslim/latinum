import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as s from "../db/schema.ts";
import { assignmentFixture } from "../db/test/assignment.ts";
import { testDatabase } from "../db/test/database.ts";
import { positionMetrics } from "../domain/positions.ts";
import type { OpenPositionsResponse } from "../domain/sheet.ts";
import { bookTotals } from "../domain/totals.ts";
import type {
  CreatePositionResponse,
  ManualTradesResponse,
  TradeFormOptions,
} from "../shared/trade.ts";
import { positionsRoute } from "./positions.ts";
import {
  createPositionRoute,
  manualTradesRoute,
  patchTradeRoute,
  tradeFormOptionsRoute,
} from "./trades.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
let app: Hono;
let errors: Error[];
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(sql`truncate accounts cascade`);
  const deps = {
    withDb: <T>(use: (db: typeof database.db) => Promise<T>) => use(database.db),
    now: () => new Date("2026-10-02T03:30:00Z"),
  };
  errors = [];
  app = new Hono().basePath("/api");
  app.post("/positions", createPositionRoute(deps));
  app.patch("/trades/:id", patchTradeRoute(deps));
  app.get("/trade-form/options", tradeFormOptionsRoute(deps));
  app.get("/positions/:id/manual-trades", manualTradesRoute(deps));
  app.get("/positions", positionsRoute(deps));
  app.onError((error, c) => {
    errors.push(error);
    return c.json({ error: "Internal Server Error" }, 500);
  });
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
};
function send(path: string, method: "POST" | "PATCH", input: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
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
async function create(input = dram) {
  const response = await send("/api/positions", "POST", input);
  if (response.status !== 201) throw new Error(`Create failed: ${await response.text()}`);
  return response.json() as Promise<CreatePositionResponse>;
}
async function manual(positionId: string) {
  const response = await app.request(`/api/positions/${positionId}/manual-trades`);
  if (response.status !== 200) throw new Error("Manual trade read failed");
  return response.json() as Promise<ManualTradesResponse>;
}
async function book() {
  const response = await app.request("/api/positions?status=open");
  if (response.status !== 200) throw new Error("Book read failed");
  return response.json() as Promise<OpenPositionsResponse>;
}

describe("trade HTTP boundary", () => {
  test("POST201 and PATCH200 refresh real Sheet rows/totals, with Money4 response values", async () => {
    const response = await send("/api/positions", "POST", dram);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const created = (await response.json()) as CreatePositionResponse;
    expect(created).toEqual({
      positionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      campaignId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const rows = await book();
    expect(rows.asOf).toBe("2026-10-01");
    expect(rows.positions).toHaveLength(1);
    const position = rows.positions[0];
    if (!position) throw new Error("Missing DRAM");
    expect(position).toMatchObject({
      id: created.positionId,
      strategy: "csp",
      price: 18500,
      strike: 500000,
      qty: 10,
    });
    expect(positionMetrics(position)).toMatchObject({
      premium: 18500000,
      collateral: 500000000,
      yield: 0.037,
      term: 14,
      breakeven: 481500,
    });
    expect(bookTotals(rows.positions)).toMatchObject({
      contracts: 10,
      premium: 18500000,
      yield: 0.037,
      capitalDeployed: 500000000,
    });
    const read = await app.request(`/api/positions/${created.positionId}/manual-trades`);
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await read.json()) as ManualTradesResponse;
    expect(body.positionId).toBe(created.positionId);
    expect(body.trades).toHaveLength(1);
    const trade = body.trades[0];
    if (!trade) throw new Error("Missing manual fill");
    expect(trade).toMatchObject({
      price: 18500,
      fees: -65000,
      quantity: 10,
      kind: "put",
      side: "short",
      editable: true,
    });
    const patch = await send(`/api/trades/${trade.id}`, "PATCH", { price: "2", fees: "0.6527" });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ id: trade.id });
    const updated = await book();
    expect(updated.positions).toMatchObject([{ id: created.positionId, price: 20000 }]);
    expect(bookTotals(updated.positions)).toMatchObject({
      premium: 20000000,
      yield: 0.04,
      capitalDeployed: 500000000,
    });
    expect((await manual(created.positionId)).trades).toMatchObject([
      { price: 20000, fees: -6527 },
    ]);
    expect(await database.db.select().from(s.trades)).toMatchObject([
      { cash: 20000000, price: 20000, fees: -6527 },
    ]);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 1, legs: 1, trades: 1 });
  });

  test.each([
    null,
    [],
    {},
    { ...dram, extra: true },
    { ...dram, price: 1.85 },
    { ...dram, price: "NaN" },
    { ...dram, fees: "-0.65" },
    { ...dram, price: "0" },
    { ...dram, quantity: 0 },
    { ...dram, quantity: 1.5 },
    { ...dram, quantity: 2147483647, strike: "99999999.9999", price: "0.0001", fees: "0" },
    { ...dram, underlying: "dram" },
    { ...dram, expiry: "2026-09-25" },
    { ...dram, openedOn: "0000-09-25" },
    { ...dram, expiry: "0000-10-09" },
    { ...dram, openedOn: "2026-02-30" },
    {
      ...dram,
      strategy: "cc",
      quantity: 2147483647,
      price: "0.0001",
      cover: { kind: "held", basis: "1" },
    },
    {
      ...dram,
      strategy: "cc",
      quantity: 1000000,
      price: "0.0001",
      cover: { kind: "held", basis: "99999999" },
    },
    { ...dram, price: "50" },
    { ...dram, strategy: "roll" },
    { ...dram, tags: [""] },
  ])("rejects invalid POST %# without even creating an account", async (input) => {
    const response = await send("/api/positions", "POST", input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(await counts()).toEqual({ accounts: 0, campaigns: 0, positions: 0, legs: 0, trades: 0 });
    expect(errors).toEqual([]);
  });

  test.each(["", "{", '{"strategy":"csp"'])(
    "malformed JSON %j returns400 for POST and PATCH",
    async (raw) => {
      for (const path of ["/api/positions", `/api/trades/${randomUUID()}`]) {
        const response = await app.request(path, {
          method: path === "/api/positions" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Malformed JSON" });
      }
      expect(await counts()).toEqual({
        accounts: 0,
        campaigns: 0,
        positions: 0,
        legs: 0,
        trades: 0,
      });
    },
  );

  test("a real late DB failure crosses the HTTP boundary as500 and rolls everything back", async () => {
    await database.client.exec(`CREATE FUNCTION fail_api_opening() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM legs WHERE id = NEW.leg_id AND side = 'long') THEN
          RAISE EXCEPTION 'late API insert failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_api_opening BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION fail_api_opening();`);
    try {
      const response = await send("/api/positions", "POST", {
        strategy: "put_credit_spread",
        underlying: "DRAM",
        openedOn: "2026-09-25",
        expiry: "2026-10-09",
        quantity: 15,
        adjusted: false,
        tags: [],
        short: { strike: "55", price: "2", fees: "9.90" },
        long: { strike: "50", price: "1.10", fees: "6.60" },
      });
      expect(response.status).toBe(500);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.cause).toMatchObject({ message: "late API insert failure" });
      expect(await counts()).toEqual({
        accounts: 0,
        campaigns: 0,
        positions: 0,
        legs: 0,
        trades: 0,
      });
    } finally {
      await database.client.exec(
        "DROP TRIGGER fail_api_opening ON trades; DROP FUNCTION fail_api_opening();",
      );
    }
  });

  test("ambiguous account fails loudly and does not choose an arbitrary book", async () => {
    await database.db.insert(s.accounts).values([
      { label: "one", broker: "manual" },
      { label: "two", broker: "ibkr" },
    ]);
    const response = await send("/api/positions", "POST", dram);
    expect(response.status).toBe(500);
    expect(errors.map((error) => error.message)).toEqual([
      "Trade entry requires exactly one account",
    ]);
    expect(await counts()).toEqual({ accounts: 2, campaigns: 0, positions: 0, legs: 0, trades: 0 });
  });

  test.each([
    {},
    null,
    [],
    { price: 2 },
    { fees: "-1" },
    { quantity: 5 },
    { action: "close" },
    { price: "2", fees: "0", source: "manual" },
  ])("PATCH rejects invalid body %# without mutation", async (input) => {
    const p = await create();
    const t = (await manual(p.positionId)).trades[0];
    if (!t) throw new Error("Missing fill");
    const response = await send(`/api/trades/${t.id}`, "PATCH", input);
    expect(response.status).toBe(400);
    expect((await manual(p.positionId)).trades).toMatchObject([
      { price: 18500, fees: -65000, quantity: 10 },
    ]);
  });

  test("PATCH revalidates economic constraints and distinguishes missing/readonly fills", async () => {
    const missing = await send(`/api/trades/${randomUUID()}`, "PATCH", { price: "2" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Trade not found" });
    const p = await create();
    const t = (await manual(p.positionId)).trades[0];
    if (!t) throw new Error("Missing fill");
    for (const price of ["0", "50"])
      expect((await send(`/api/trades/${t.id}`, "PATCH", { price })).status).toBe(400);
    expect((await manual(p.positionId)).trades).toMatchObject([{ price: 18500, editable: true }]);
    await database.db.update(s.trades).set({ source: "ibkr_upload" }).where(eq(s.trades.id, t.id));
    expect((await send(`/api/trades/${t.id}`, "PATCH", { price: "2" })).status).toBe(409);
    expect((await manual(p.positionId)).trades).toMatchObject([{ price: 18500, editable: false }]);
    expect((await app.request(`/api/positions/${randomUUID()}/manual-trades`)).status).toBe(404);
    expect((await app.request("/api/positions/not-a-uuid/manual-trades")).status).toBe(400);
    expect((await send("/api/trades/not-a-uuid", "PATCH", { price: "2" })).status).toBe(400);
  });

  test("assigned options expose basis53 and actual coverage; POST reuses campaign/no stock copies; linked economic edits409", async () => {
    const empty = await app.request("/api/trade-form/options");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await empty.json()).toEqual({ tickers: [], tags: [], assignedStock: [] });
    const ids = await assignmentFixture(database.db);
    const response = await app.request("/api/trade-form/options");
    const options = (await response.json()) as TradeFormOptions;
    expect(options).toEqual({
      tickers: ["DRAM"],
      tags: ["assigned", "wheel"],
      assignedStock: [
        {
          legId: ids.stockLegId,
          underlying: "DRAM",
          basis: 530000,
          uncoveredShares: 1500,
          assignedOn: "2026-09-25",
        },
      ],
    });
    const input = {
      strategy: "cc",
      underlying: "DRAM",
      openedOn: "2026-09-25",
      expiry: "2026-10-09",
      quantity: 15,
      adjusted: false,
      strike: "55",
      price: "1.10",
      fees: "9.90",
      tags: ["wheel"],
      cover: { kind: "assigned", stockLegId: ids.stockLegId },
    };
    const created = await send("/api/positions", "POST", input);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ campaignId: ids.campaignId });
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 3, legs: 3, trades: 4 });
    const rows = await book();
    expect(rows.positions).toHaveLength(1);
    expect(rows.positions).toMatchObject([{ strategy: "cc", qty: 15, basis: 530000 }]);
    expect(bookTotals(rows.positions)).toMatchObject({
      contracts: 15,
      premium: 16500000,
      incomeCollateral: 825000000,
      swingCapital: 0,
      capitalDeployed: 825000000,
    });
    expect(
      ((await (await app.request("/api/trade-form/options")).json()) as TradeFormOptions)
        .assignedStock,
    ).toEqual([]);
    const exhausted = await send("/api/positions", "POST", input);
    expect(exhausted.status).toBe(409);
    expect(await counts()).toEqual({ accounts: 1, campaigns: 1, positions: 3, legs: 3, trades: 4 });
    for (const id of [ids.putOpenTradeId, ids.optionTradeId, ids.stockTradeId]) {
      const edit = await send(`/api/trades/${id}`, "PATCH", { price: "2" });
      expect(edit.status).toBe(409);
      expect(await edit.json()).toEqual({ error: "Trade is read-only" });
    }
    expect((await manual(ids.stockPositionId)).trades).toMatchObject([
      { price: 550000, editable: false },
    ]);
  });
});

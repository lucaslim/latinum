import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import type { WithDb } from "../db/database.ts";
import type { JournalExport } from "../db/export.types.ts";
import * as s from "../db/schema.ts";
import { testDatabase } from "../db/test/database.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { exportRoute, tradesCsv } from "./export.ts";

function exportApp(withDb: WithDb) {
  return new Hono().get("/api/export", exportRoute({ withDb }));
}

test("exports an empty migrated journal as a private JSON attachment", async () => {
  const { db, client } = await testDatabase();
  try {
    const res = await exportApp((use) => use(db)).request("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="trading-journal-backup.json"',
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      version: 1,
      tables: {
        accounts: [],
        campaigns: [],
        roll_chains: [],
        positions: [],
        legs: [],
        rolls: [],
        trades: [],
        assignments: [],
        marks: [],
        platform_heartbeat: [],
      },
    });
  } finally {
    await client.close();
  }
});

const csvHeader =
  "id,legId,action,tradeDate,executedAt,quantity,price,cash,fees,currency,rollId,source,createdAt\r\n";

test("an empty book produces only the raw trade CSV header", async () => {
  const { db, client } = await testDatabase();
  try {
    const res = await exportApp((use) => use(db)).request("/api/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="trading-journal-trades.csv"',
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toBe(csvHeader);
  } finally {
    await client.close();
  }
});

const legId = "20000000-0000-4000-8000-000000000001";
const firstId = "20000000-0000-4000-8000-000000000002";
const secondId = "20000000-0000-4000-8000-000000000003";
const at = "2026-10-01T01:00:00.123Z";

test.each(["available", "missing"])(
  "CSV includes every raw column, lossless four-decimal USD and null fields, in ID order (marks %s)",
  async (marks) => {
    const { db, client } = await testDatabase();
    try {
      const accountId = "20000000-0000-4000-8000-000000000004";
      const campaignId = "20000000-0000-4000-8000-000000000005";
      const positionId = "20000000-0000-4000-8000-000000000006";
      await db.insert(s.accounts).values({ id: accountId, label: "CSV", broker: "manual" });
      await db.insert(s.campaigns).values({
        id: campaignId,
        accountId,
        title: "CSV",
        openedOn: "2026-09-30",
      });
      await db.insert(s.positions).values({
        id: positionId,
        campaignId,
        underlying: "NVDL",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-30",
      });
      await db.insert(s.legs).values({
        id: legId,
        positionId,
        kind: "put",
        side: "short",
        underlying: "NVDL",
        strike: m("26.67"),
        expiry: "2026-10-16",
      });
      const chainId = "20000000-0000-4000-8000-000000000007";
      const rollId = "20000000-0000-4000-8000-000000000008";
      await db.insert(s.rollChains).values({ id: chainId, campaignId });
      await db.insert(s.rolls).values({ id: rollId, rollChainId: chainId, rolledOn: "2026-09-30" });
      await db.insert(s.trades).values([
        {
          id: secondId,
          legId,
          action: "close",
          tradeDate: "2026-10-01",
          quantity: 1,
          price: m("0"),
          cash: m("-108.50"),
          fees: m("0"),
          createdAt: new Date(at),
        },
        {
          id: firstId,
          legId,
          action: "open",
          tradeDate: "2026-09-30",
          executedAt: new Date(at),
          quantity: 1,
          price: m("1.0850"),
          cash: m("108.50"),
          fees: m("-0.6527"),
          rollId,
          source: "ibkr_flex",
          createdAt: new Date(at),
        },
      ]);
      if (marks === "missing") await client.exec("drop table marks");
      const queries = vi.spyOn(client, "query");
      const errors: Error[] = [];
      const app = exportApp((use) => use(db));
      app.onError((err, c) => {
        errors.push(err);
        return c.text("Export failed", 500);
      });
      const csv = await app.request("/api/export?format=csv");
      expect(csv.status).toBe(200);
      expect(await csv.text()).toBe(
        csvHeader +
          `${firstId},${legId},open,2026-09-30,${at},1,1.0850,108.5000,-0.6527,USD,${rollId},ibkr_flex,${at}\r\n` +
          `${secondId},${legId},close,2026-10-01,,1,0.0000,-108.5000,0.0000,USD,,manual,${at}\r\n`,
      );
      expect(queries.mock.calls.map(([query]) => query)).toEqual([
        'select "id", "leg_id", "action", "trade_date", "executed_at", "quantity", "price", "cash", "fees", "currency", "roll_id", "source", "created_at" from "trades" order by "trades"."id"',
      ]);
      queries.mockRestore();
      expect(errors).toEqual([]);
      const json = await app.request("/api/export?format=json");
      if (marks === "missing") {
        expect(json.status).toBe(500);
        expect(await json.text()).toBe("Export failed");
        expect(json.headers.get("Content-Disposition")).toBeNull();
        expect(errors.map((err) => err.message)).toEqual([expect.stringContaining('from "marks"')]);
        return;
      }
      const backup = (await json.json()) as JournalExport;
      expect(json.status).toBe(200);
      expect(
        backup.tables.trades.map(({ price, cash, fees, executedAt }) => ({
          price,
          cash,
          fees,
          executedAt,
        })),
      ).toEqual([
        { price: 10850, cash: 1085000, fees: -6527, executedAt: at },
        { price: 0, cash: -1085000, fees: 0, executedAt: null },
      ]);
    } finally {
      await client.close();
    }
  },
);

test.each(["", "xml", "JSON", "Csv", " json"])(
  "rejects format=%j without opening a database",
  async (format) => {
    const withDb = vi.fn(async () => {
      throw new Error("invalid format opened the database");
    });
    const res = await exportApp(withDb).request(`/api/export?format=${encodeURIComponent(format)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "format must be json or csv" });
    expect(withDb).toHaveBeenCalledTimes(0);
  },
);

test.each(["json", "csv"])(
  "database failures reach the Hono error boundary for %s",
  async (format) => {
    const error = new Error("database unavailable");
    const withDb = vi.fn(async () => {
      throw error;
    });
    const errors: Error[] = [];
    const app = exportApp(withDb);
    app.onError((err, c) => {
      errors.push(err);
      return c.text("Export failed", 500);
    });
    const res = await app.request(`/api/export?format=${format}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Export failed");
    expect(errors).toEqual([error]);
    expect(withDb).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  },
);

test("CSV serializer quotes commas, quotes, CR and LF in raw string fields", () => {
  const row: JournalExport["tables"]["trades"][number] = {
    id: firstId,
    legId,
    action: "open",
    tradeDate: "2026-09-30",
    executedAt: null,
    quantity: 1,
    price: 10850,
    cash: 1085000,
    fees: -6527,
    currency: 'a,"b"\r\nc',
    rollId: null,
    source: "manual",
    createdAt: at,
  };
  expect(tradesCsv([row])).toBe(
    csvHeader +
      `${firstId},${legId},open,2026-09-30,,1,1.0850,108.5000,-0.6527,"a,""b""\r\nc",,manual,${at}\r\n`,
  );
});

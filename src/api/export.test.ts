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
  "id,legId,action,tradeDate,executedAt,quantity,price,cash,fees,currency,rollId,source,createdAt,realizedPnl\r\n";

test("an empty book produces only the raw trade CSV header plus realizedPnl", async () => {
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
          id: firstId,
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
          id: secondId,
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
          `${firstId},${legId},close,2026-10-01,,1,0.0000,-108.5000,0.0000,USD,,manual,${at},-0.6527\r\n` +
          `${secondId},${legId},open,2026-09-30,${at},1,1.0850,108.5000,-0.6527,USD,${rollId},ibkr_flex,${at},\r\n`,
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
        { price: 0, cash: -1085000, fees: 0, executedAt: null },
        { price: 10850, cash: 1085000, fees: -6527, executedAt: at },
      ]);
      expect(backup.tables.trades.map((row) => Object.keys(row))).toEqual([
        [
          "id",
          "legId",
          "action",
          "tradeDate",
          "executedAt",
          "quantity",
          "price",
          "cash",
          "fees",
          "currency",
          "rollId",
          "source",
          "createdAt",
        ],
        [
          "id",
          "legId",
          "action",
          "tradeDate",
          "executedAt",
          "quantity",
          "price",
          "cash",
          "fees",
          "currency",
          "rollId",
          "source",
          "createdAt",
        ],
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
      `${firstId},${legId},open,2026-09-30,,1,1.0850,108.5000,-0.6527,"a,""b""\r\nc",,manual,${at},\r\n`,
  );
});

type TradeRow = JournalExport["tables"]["trades"][number];

function tradeRow(
  id: string,
  action: TradeRow["action"],
  quantity: number,
  cash: number,
  fees = 0,
  overrides: Partial<TradeRow> = {},
): TradeRow {
  return {
    id,
    legId,
    action,
    tradeDate: "2026-09-30",
    executedAt: null,
    quantity,
    price: 0,
    cash,
    fees,
    currency: "USD",
    rollId: null,
    source: "manual",
    createdAt: at,
    ...overrides,
  };
}

function realizedRows(rows: TradeRow[]): string[][] {
  return tradesCsv(rows)
    .split("\r\n")
    .slice(1, -1)
    .map((line) => {
      const fields = line.split(",");
      return [fields[0] ?? "", fields.at(-1) ?? ""];
    });
}

test.each([
  ["MUU", 10, 15_000_000, -66_000, "expire", 0, 0, "1493.4000"],
  ["SPXL", 2, 6_200_000, -13_000, "close", -800_000, -13_000, "537.4000"],
  ["DRAM", 15, 30_000_000, -99_000, "assign", 0, 0, "2990.1000"],
] as const)(
  "CSV reproduces T3 %s per-close net P/L without realizing the opening row",
  (_name, quantity, cash, fees, action, closingCash, closingFees, expected) => {
    expect(
      realizedRows([
        tradeRow("open", "open", quantity, cash, fees, { tradeDate: "2026-09-01" }),
        tradeRow("done", action, quantity, closingCash, closingFees),
      ]),
    ).toEqual([
      ["open", ""],
      ["done", expected],
    ]);
  },
);

test("CSV realizes only the closed half of MUU, leaving the other five contracts unrealized", () => {
  expect(
    realizedRows([
      tradeRow("a-open", "open", 10, 15_000_000, -66_000),
      tradeRow("b-half", "close", 5, -2_000_000, -33_000),
    ]),
  ).toEqual([
    ["a-open", ""],
    ["b-half", "543.4000"],
  ]);
});

test("CSV keeps independent leg pools while retaining interleaved raw row order", () => {
  expect(
    realizedRows([
      tradeRow("a-muu", "open", 10, 15_000_000, -66_000),
      tradeRow("b-spxl", "open", 2, 6_200_000, -13_000, { legId: "spxl" }),
      tradeRow("c-muu", "expire", 10, 0),
      tradeRow("d-spxl", "close", 2, -800_000, -13_000, { legId: "spxl" }),
    ]),
  ).toEqual([
    ["a-muu", ""],
    ["b-spxl", ""],
    ["c-muu", "1493.4000"],
    ["d-spxl", "537.4000"],
  ]);
});

test("CSV allocates chronologically, starts a fresh pool after full close and does not mutate input", () => {
  const rows = [
    tradeRow("a-reopen", "open", 2, -9, -3, { tradeDate: "2026-10-01" }),
    tradeRow("b-close-new", "close", 1, 7, -1, { tradeDate: "2026-10-01" }),
    tradeRow("old", "open", 3, 10, -5, { tradeDate: "2026-09-01" }),
    tradeRow("a-old-half", "close", 1, 0),
    tradeRow("b-old-final", "expire", 2, 0),
  ];
  const before = structuredClone(rows);
  expect(realizedRows(rows)).toEqual([
    ["a-reopen", ""],
    ["b-close-new", "0.0001"],
    ["old", ""],
    ["a-old-half", "0.0002"],
    ["b-old-final", "0.0003"],
  ]);
  expect(rows).toEqual(before);
});

test("CSV breaks same-date ties by createdAt then id, never executedAt", () => {
  const rows = [
    tradeRow("a-third", "close", 1, 5, -3, {
      createdAt: "2026-10-01T03:00:00.000Z",
      executedAt: "2026-09-30T13:00:00.000Z",
    }),
    tradeRow("z-open", "open", 3, -10, -5, {
      createdAt: "2026-10-01T01:00:00.000Z",
      executedAt: "2026-09-30T16:00:00.000Z",
    }),
    tradeRow("c-second", "exercise", 1, 5, -2, {
      createdAt: "2026-10-01T02:00:00.000Z",
      executedAt: "2026-09-30T14:00:00.000Z",
    }),
    tradeRow("b-first", "close", 1, 5, -1, {
      createdAt: "2026-10-01T02:00:00.000Z",
      executedAt: "2026-09-30T15:00:00.000Z",
    }),
  ];
  expect(realizedRows(rows)).toEqual([
    ["a-third", "-0.0004"],
    ["z-open", ""],
    ["c-second", "-0.0002"],
    ["b-first", "0.0000"],
  ]);
});

test("CSV pools multiple opens and only remaining cash and fees with interleaved opens", () => {
  expect(
    realizedRows([
      tradeRow("1-one", "open", 2, 10, -3),
      tradeRow("2-two", "open", 1, 7, -2),
      tradeRow("3-partial", "close", 1, -2, -1),
      tradeRow("4-three", "open", 2, 20, -3),
      tradeRow("5-next", "close", 2, -4, -2),
      tradeRow("6-final", "expire", 2, 0),
    ]),
  ).toEqual([
    ["1-one", ""],
    ["2-two", ""],
    ["3-partial", "0.0001"],
    ["4-three", ""],
    ["5-next", "0.0007"],
    ["6-final", "0.0012"],
  ]);
});

test("CSV truncates debit cash and fees separately and consumes final remainders, including zero and losses", () => {
  expect(
    realizedRows([
      tradeRow("1-open", "open", 3, -10, -5),
      tradeRow("2-first", "close", 1, 5, -1),
      tradeRow("3-second", "exercise", 1, 5, -2),
      tradeRow("4-third", "close", 1, 5, -3),
    ]),
  ).toEqual([
    ["1-open", ""],
    ["2-first", "0.0000"],
    ["3-second", "-0.0002"],
    ["4-third", "-0.0004"],
  ]);
});

test("CSV fails loudly when a close has no preceding opens on its own leg", () => {
  expect(() =>
    tradesCsv([
      tradeRow("a-open", "open", 10, 15_000_000, -66_000),
      tradeRow("b-close", "close", 1, 0, 0, { legId: "other-leg" }),
    ]),
  ).toThrow(RangeError);
});

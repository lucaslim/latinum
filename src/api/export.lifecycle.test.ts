import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { LifecycleResponse } from "../contracts/lifecycle.ts";
import { readJournalExport } from "../db/export.ts";
import type { JournalExport } from "../db/export.types.ts";
import { type NewTrade, repository } from "../db/repository.ts";
import * as s from "../db/schema.ts";
import { testDatabase } from "../db/test/database.ts";
import { restoreExport } from "../db/test/restore-export.ts";
import type { CampaignResponse } from "../domain/campaign.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { createApp } from "./app.ts";
import { noSession } from "./testGuard.ts";

const rawColumns = [
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
];
let database: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let accountId: string;
beforeAll(async () => {
  database = await testDatabase();
  const [account] = await database.db
    .insert(s.accounts)
    .values({ label: "Export lifecycle", broker: "manual" })
    .returning();
  assert(account);
  accountId = account.id;
  app = createApp({
    guard: noSession,
    withDb: (use) => use(database.db),
    now: () => new Date("2026-10-17T03:30:00Z"),
  });
}, 20_000);
afterAll(async () => {
  await database.client.close();
});

async function put(underlying: string, strike: string, trades: NewTrade[]) {
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
        trades,
      },
    ],
  });
  return { campaignId: campaign.id, positionId, legId };
}

async function post(fixture: Awaited<ReturnType<typeof put>>, action: string, body: object) {
  const read = await app.request(`/api/campaigns/${fixture.campaignId}`);
  expect(read.status).toBe(200);
  const campaign = (await read.json()) as CampaignResponse;
  const position = campaign.positions.find((row) => row.id === fixture.positionId);
  assert(position);
  const response = await app.request(`/api/positions/${fixture.positionId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: position.revision, ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as LifecycleResponse;
}

function csvRecords(csv: string) {
  // These stored fields are UUIDs, enums, dates and numbers, without CSV delimiters.
  const [header, ...rows] = csv
    .trimEnd()
    .split("\r\n")
    .map((line) => line.split(","));
  expect(header).toEqual([...rawColumns, "realizedPnl"]);
  for (const row of rows) expect(row).toHaveLength(14);
  return rows;
}

test("lifecycle exports plan P/L, leaves opens blank and restores unchanged raw JSON", async () => {
  const expected = new Map<string, string[]>();
  for (const [
    underlying,
    strike,
    quantity,
    price,
    cash,
    fees,
    action,
    closeCash,
    closeFees,
    pnl,
  ] of [
    ["MUU", "25", 10, "1.50", "1500", "-6.60", "expire", "0.0000", "0.0000", "1493.4000"],
    ["SPXL", "240", 2, "3.10", "620", "-1.30", "close", "-80.0000", "-1.3000", "537.4000"],
    ["DRAM", "55", 15, "2.00", "3000", "-9.90", "assign", "0.0000", "0.0000", "2990.1000"],
  ] as const) {
    const fixture = await put(underlying, strike, [
      {
        action: "open",
        tradeDate: "2026-09-15",
        quantity,
        price: m(price),
        cash: m(cash),
        fees: m(fees),
      },
    ]);
    const result = await post(
      fixture,
      action,
      action === "close"
        ? {
            tradeDate: "2026-10-16",
            fills: [{ legId: fixture.legId, quantity, price: "0.40", fees: "-1.30" }],
          }
        : action === "assign"
          ? { legId: fixture.legId }
          : {},
    );
    assert(result.tradeIds[0]);
    expected.set(result.tradeIds[0], [
      action,
      String(quantity),
      action === "close" ? "0.4000" : "0.0000",
      closeCash,
      closeFees,
      pnl,
    ]);
    if (action === "assign") {
      assert(result.assignment);
      expected.set(result.assignment.stockTradeId, [
        "open",
        "1500",
        "55.0000",
        "-82500.0000",
        "0.0000",
        "",
      ]);
    }
  }
  const partial = await put("MUU", "25", [
    {
      action: "open",
      tradeDate: "2026-09-15",
      quantity: 10,
      price: m("1.50"),
      cash: m("1500"),
      fees: m("-6.60"),
    },
  ]);
  const half = await post(partial, "close", {
    tradeDate: "2026-09-30",
    fills: [{ legId: partial.legId, quantity: 5, price: "0.40", fees: "-1.30" }],
  });
  expect(half.closedOn).toBeNull();
  assert(half.tradeIds[0]);
  expected.set(half.tradeIds[0], ["close", "5", "0.4000", "-200.0000", "-1.3000", "545.4000"]);
  const remainder = await post(partial, "expire", {});
  assert(remainder.tradeIds[0]);
  expected.set(remainder.tradeIds[0], ["expire", "5", "0.0000", "0.0000", "0.0000", "746.7000"]);

  const jsonResponse = await app.request("/api/export?format=json");
  expect(jsonResponse.status).toBe(200);
  const backup = (await jsonResponse.json()) as JournalExport;
  expect(backup).toEqual(await readJournalExport(database.db));
  for (const row of backup.tables.trades) {
    expect(Object.keys(row).sort()).toEqual([...rawColumns].sort());
  }
  const csvResponse = await app.request("/api/export?format=csv");
  expect(csvResponse.status).toBe(200);
  const csv = await csvResponse.text();
  const restored = await testDatabase();
  try {
    await restoreExport(restored.db, backup);
    const restoredApp = createApp({
      guard: noSession,
      withDb: (use) => use(restored.db),
      now: () => new Date("2026-10-17T03:30:00Z"),
    });
    const restoredJson = await restoredApp.request("/api/export?format=json");
    expect(restoredJson.status).toBe(200);
    expect(await restoredJson.json()).toEqual(backup);
    const restoredCsv = await restoredApp.request("/api/export?format=csv");
    expect(restoredCsv.status).toBe(200);
    expect(await restoredCsv.text()).toBe(csv);
  } finally {
    await restored.client.close();
  }

  const rows = csvRecords(csv);
  expect(rows.map((row) => row[0])).toEqual(backup.tables.trades.map((row) => row.id));
  for (const row of rows) {
    if (row[2] === "open") expect(row[13]).toBe("");
    const fields = expected.get(row[0] ?? "");
    if (fields) expect([row[2], row[5], row[6], row[7], row[8], row[13]]).toEqual(fields);
    else expect(row[2]).toBe("open");
  }
  expect(expected.size).toBe(6);
});

test.each([
  {
    name: "weighted pools, interleaved opens and final cash/fee remainders ordered by createdAt",
    rows: [
      [6, "open", 2, "0.0010", "-0.0003", "2026-09-30", "00:00:00", ""],
      [2, "open", 1, "0.0007", "-0.0002", "2026-09-30", "00:00:01", ""],
      [3, "close", 1, "-0.0002", "-0.0001", "2026-09-30", "00:00:02", "0.0001"],
      [5, "open", 2, "0.0020", "-0.0003", "2026-09-30", "00:00:03", ""],
      [1, "close", 2, "-0.0004", "-0.0002", "2026-09-30", "00:00:04", "0.0007"],
      [4, "expire", 2, "0", "0", "2026-09-30", "00:00:05", "0.0012"],
    ],
  },
  {
    name: "separate debit/fee truncation, zero, exercise and final remainders ordered by id",
    rows: [
      [14, "close", 1, "0.0005", "-0.0003", "2026-09-30", "00:00:00", "-0.0004"],
      [13, "exercise", 1, "0.0005", "-0.0002", "2026-09-30", "00:00:00", "-0.0002"],
      [12, "close", 1, "0.0005", "-0.0001", "2026-09-30", "00:00:00", "0.0000"],
      [11, "open", 3, "-0.0010", "-0.0005", "2026-09-30", "00:00:00", ""],
    ],
  },
  {
    name: "chronological tradeDate allocation and a fresh pool after full close",
    rows: [
      [25, "open", 2, "-0.0009", "-0.0003", "2026-10-01", "00:00:00", ""],
      [22, "close", 1, "0.0007", "-0.0001", "2026-10-01", "00:00:01", "0.0001"],
      [21, "open", 3, "0.0010", "-0.0005", "2026-09-01", "00:00:02", ""],
      [24, "close", 1, "0", "0", "2026-09-30", "00:00:03", "0.0002"],
      [23, "expire", 2, "0", "0", "2026-09-30", "00:00:04", "0.0003"],
    ],
  },
] as const)("CSV uses T8 $name but preserves raw ID order", async ({ rows }) => {
  const trades = rows.map(([id, action, quantity, cash, fees, tradeDate, time]) => ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    action,
    quantity,
    cash: m(cash),
    fees: m(fees),
    tradeDate,
    price: m("0"),
    createdAt: new Date(`2026-10-01T${time}Z`),
  }));
  const fixture = await put("MUU", "25", trades);
  const response = await app.request("/api/export?format=csv");
  expect(response.status).toBe(200);
  const actual = csvRecords(await response.text()).filter((row) => row[1] === fixture.legId);
  expect(actual.map((row) => [row[0], row[13]])).toEqual(
    rows
      .map(([id, , , , , , , pnl]) => [
        `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
        pnl,
      ])
      .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
  );
});

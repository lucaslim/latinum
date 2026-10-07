import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { exportRoute } from "../api/export.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { bookTotals } from "../domain/totals.ts";
import { toBookPosition } from "./book.ts";
import { readJournalExport } from "./export.ts";
import type { JournalExport } from "./export.types.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";
import { restoreExport } from "./test/restore-export.ts";

const account = "10000000-0000-4000-8000-000000000001";
const campaign = "10000000-0000-4000-8000-000000000002";
const chain = "10000000-0000-4000-8000-000000000003";
const position = "10000000-0000-4000-8000-000000000004";
const option = "10000000-0000-4000-8000-000000000005";
const stock = "10000000-0000-4000-8000-000000000006";
const roll = "10000000-0000-4000-8000-000000000007";
const optionTrade = "10000000-0000-4000-8000-000000000008";
const stockTrade = "10000000-0000-4000-8000-000000000009";
const assignment = "10000000-0000-4000-8000-000000000010";
const at = "2026-10-01T01:00:00.123Z";

async function download(db: Awaited<ReturnType<typeof testDatabase>>["db"]) {
  const app = new Hono().get("/api/export", exportRoute({ withDb: (use) => use(db) }));
  const res = await app.request("/api/export?format=json");
  expect(res.status).toBe(200);
  return (await res.json()) as JournalExport;
}

test("JSON preserves every table and reproduces the literal plan seed totals after restore", async () => {
  const source = await testDatabase();
  const target = await testDatabase();
  try {
    const accountId = await seedBook(source.db);
    await source.db.insert(s.accounts).values({
      id: account,
      label: 'Closed, "fixture"',
      broker: "manual",
      createdAt: new Date(at),
    });
    await source.db.insert(s.campaigns).values({
      id: campaign,
      accountId: account,
      title: "Closed fixture",
      openedOn: "2026-09-01",
      closedOn: "2026-10-01",
      notes: "preserve\nnotes",
    });
    await source.db.insert(s.rollChains).values({ id: chain, campaignId: campaign });
    await source.db.insert(s.positions).values({
      id: position,
      campaignId: campaign,
      rollChainId: chain,
      underlying: "NVDL",
      strategy: "csp",
      role: "income",
      openedOn: "2026-09-01",
      closedOn: "2026-10-01",
      tags: ["wheel", "raw"],
      notes: null,
    });
    await source.db.insert(s.legs).values([
      {
        id: stock,
        positionId: position,
        kind: "stock",
        side: "long",
        underlying: "NVDL",
        strike: null,
        expiry: null,
        multiplier: 1,
      },
      {
        id: option,
        positionId: position,
        kind: "put",
        side: "short",
        underlying: "NVDL",
        strike: m("26.67"),
        expiry: "2026-10-16",
        adjusted: true,
      },
    ]);
    await source.db.insert(s.rolls).values({
      id: roll,
      rollChainId: chain,
      rolledOn: "2026-10-01",
      detectedBy: "timestamp",
    });
    await source.db.insert(s.trades).values([
      {
        id: stockTrade,
        legId: stock,
        action: "open",
        tradeDate: "2026-09-30",
        quantity: 100,
        price: m("26.67"),
        cash: m("-2667"),
        fees: m("0"),
        createdAt: new Date(at),
      },
      {
        id: optionTrade,
        legId: option,
        action: "assign",
        tradeDate: "2026-09-30",
        executedAt: new Date(at),
        quantity: 1,
        price: m("1.0850"),
        cash: m("108.50"),
        fees: m("-0.6527"),
        rollId: roll,
        source: "ibkr_upload",
        createdAt: new Date(at),
      },
    ]);
    await source.db.insert(s.assignments).values({
      id: assignment,
      optionTradeId: optionTrade,
      stockTradeId: stockTrade,
      shares: 100,
      premiumPerShare: m("1.0850"),
    });
    await source.db.insert(s.marks).values([
      { legId: stock, asOf: "2026-10-02", price: m("26.67"), source: "manual" },
      { legId: option, asOf: "2026-10-02", price: m("1.0850"), source: "manual" },
      { legId: option, asOf: "2026-10-01", price: m("1.0850"), source: "manual" },
      { legId: option, asOf: "2026-10-01", price: m("1.0850"), source: "feed" },
    ]);
    await source.client.query(
      "insert into platform_heartbeat (id, at, source) overriding system value values (42, $1, 'export-test'), (7, $1, 'earlier-id')",
      [at],
    );

    const runTransaction = source.db.transaction.bind(source.db);
    const settings: unknown[] = [];
    const selectCounts: number[] = [];
    const transaction = vi.spyOn(source.db, "transaction").mockImplementation((use, config) =>
      runTransaction(async (tx) => {
        const result = await tx.execute(sql`
          select current_setting('transaction_isolation') as isolation,
                 current_setting('transaction_read_only') as readonly
        `);
        settings.push(result.rows);
        const select = vi.spyOn(tx, "select");
        const backup = await use(tx);
        selectCounts.push(select.mock.calls.length);
        select.mockRestore();
        return backup;
      }, config),
    );
    const original = await download(source.db);
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(settings).toEqual([[{ isolation: "repeatable read", readonly: "on" }]]);
    expect(selectCounts).toEqual([10]);
    transaction.mockRestore();
    expect(await readJournalExport(source.db)).toEqual(original);

    expect(Object.keys(original.tables)).toEqual([
      "accounts",
      "campaigns",
      "roll_chains",
      "positions",
      "legs",
      "rolls",
      "trades",
      "assignments",
      "marks",
      "platform_heartbeat",
    ]);
    for (const [name, rows] of Object.entries(original.tables)) {
      expect(rows.length, name).toBeGreaterThan(0);
      if (name !== "marks") {
        const ids = rows.map((row) => {
          assert("id" in row);
          return row.id;
        });
        expect(ids, name).toEqual(
          [...ids].sort((a, b) =>
            typeof a === "number" && typeof b === "number"
              ? a - b
              : String(a).localeCompare(String(b)),
          ),
        );
      }
    }
    expect(original.tables.marks).toEqual([
      { legId: option, asOf: "2026-10-01", price: 10850, source: "feed" },
      { legId: option, asOf: "2026-10-01", price: 10850, source: "manual" },
      { legId: option, asOf: "2026-10-02", price: 10850, source: "manual" },
      { legId: stock, asOf: "2026-10-02", price: 266700, source: "manual" },
    ]);
    expect(original.tables.platform_heartbeat).toEqual([
      { id: 7, at, source: "earlier-id" },
      { id: 42, at, source: "export-test" },
    ]);
    expect(original.tables.trades.find((row) => row.id === optionTrade)).toEqual({
      id: optionTrade,
      legId: option,
      action: "assign",
      tradeDate: "2026-09-30",
      executedAt: at,
      quantity: 1,
      price: 10850,
      cash: 1085000,
      fees: -6527,
      currency: "USD",
      rollId: roll,
      source: "ibkr_upload",
      createdAt: at,
    });
    expect(original.tables.trades.find((row) => row.id === stockTrade)?.executedAt).toBeNull();
    expect(original.tables.positions.find((row) => row.id === position)).toMatchObject({
      closedOn: "2026-10-01",
      rollChainId: chain,
      tags: ["wheel", "raw"],
      notes: null,
    });
    expect(original.tables.legs.find((row) => row.id === stock)).toMatchObject({
      strike: null,
      expiry: null,
      multiplier: 1,
    });
    expect(original.tables.legs.find((row) => row.id === option)).toMatchObject({
      strike: 266700,
      adjusted: true,
    });
    expect(original.tables.assignments).toEqual([
      {
        id: assignment,
        optionTradeId: optionTrade,
        stockTradeId: stockTrade,
        shares: 100,
        premiumPerShare: 10850,
      },
    ]);

    await restoreExport(target.db, original);
    expect(await download(target.db)).toEqual(original);
    const loaded = await repository(target.db).readOpenPositions(accountId);
    expect(loaded).toHaveLength(12);
    const totals = bookTotals(loaded.map(toBookPosition));
    expect(totals).toMatchObject({
      contracts: 77,
      premium: 144500000,
      incomeCollateral: 4345000000,
      hedgeCost: 3580000,
      swingCapital: 235400000,
      capitalDeployed: 4583980000,
    });
    expect(((totals.yield ?? 0) * 100).toFixed(2)).toBe("3.33");
    expect(((totals.annualized ?? 0) * 100).toFixed(1)).toBe("47.4");
  } finally {
    await source.client.close();
    await target.client.close();
  }
}, 20_000);

test("an empty JSON backup restores without inserting empty arrays", async () => {
  const source = await testDatabase();
  const target = await testDatabase();
  try {
    const original = await download(source.db);
    await restoreExport(target.db, original);
    expect(await download(target.db)).toEqual(original);
    expect(original.tables.accounts).toEqual([]);
  } finally {
    await source.client.close();
    await target.client.close();
  }
}, 20_000);

test("a failed table read rejects the export and rolls back its read-only transaction", async () => {
  const { db, client } = await testDatabase();
  try {
    await client.exec("drop table marks");
    await expect(readJournalExport(db)).rejects.toThrow(/marks/);
    await db.insert(s.accounts).values({ id: account, label: "After rollback", broker: "manual" });
    expect(await db.select({ id: s.accounts.id }).from(s.accounts)).toEqual([{ id: account }]);
  } finally {
    await client.close();
  }
});

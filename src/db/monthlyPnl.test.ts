import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { parseMoney4 as m } from "../domain/money.ts";
import type { Database } from "./database.ts";
import { readMonthlyPnl } from "./monthlyPnl.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";

const accountId = "10000000-0000-4000-8000-000000000001";
const campaignId = "10000000-0000-4000-8000-000000000002";
const chainId = "10000000-0000-4000-8000-000000000003";
const rollId = "10000000-0000-4000-8000-000000000004";
const legId = "10000000-0000-4000-8000-000000000005";
const positionId = "10000000-0000-4000-8000-000000000006";

async function account(db: Database) {
  await db.insert(s.accounts).values({ id: accountId, label: "Monthly", broker: "manual" });
  await db
    .insert(s.campaigns)
    .values({ id: campaignId, accountId, title: "Monthly", openedOn: "2026-09-01" });
}

describe("readMonthlyPnl", () => {
  it("returns empty months for no account and for an account with only open positions", async () => {
    const { db, client } = await testDatabase();
    try {
      expect(await readMonthlyPnl(db)).toEqual({ months: [] });
      await account(db);
      await repository(db).createPosition({
        campaignId,
        underlying: "MUU",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-01",
        legs: [
          {
            kind: "put",
            side: "short",
            underlying: "MUU",
            strike: m("25"),
            expiry: "2026-10-16",
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-01",
                quantity: 10,
                price: m("1.50"),
                cash: m("1500"),
                fees: m("-6.60"),
              },
            ],
          },
        ],
      });
      expect(await readMonthlyPnl(db)).toEqual({ months: [] });
    } finally {
      await client.close();
    }
  });

  it("refuses to silently merge multiple accounts", async () => {
    const { db, client } = await testDatabase();
    try {
      await db.insert(s.accounts).values([
        { label: "one", broker: "manual" },
        { label: "two", broker: "manual" },
      ]);
      await expect(readMonthlyPnl(db)).rejects.toThrow("More than one account");
    } finally {
      await client.close();
    }
  });

  it("reads still-open pools in tradeDate/createdAt/id order inside a repeatable-read read-only transaction", async () => {
    const { db, client } = await testDatabase();
    try {
      await account(db);
      await repository(db).createPosition({
        id: positionId,
        campaignId,
        underlying: "MUU",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-01",
        legs: [
          {
            id: legId,
            kind: "put",
            side: "short",
            underlying: "MUU",
            strike: m("25"),
            expiry: "2026-10-16",
            trades: [
              {
                id: "20000000-0000-4000-8000-000000000002",
                action: "close",
                tradeDate: "2026-10-01",
                quantity: 1,
                price: m("0"),
                cash: m("0.0007"),
                fees: m("-0.0001"),
                createdAt: new Date("2026-10-01T12:00:00Z"),
              },
              {
                id: "20000000-0000-4000-8000-000000000001",
                action: "open",
                tradeDate: "2026-10-01",
                quantity: 2,
                price: m("0"),
                cash: m("-0.0009"),
                fees: m("-0.0003"),
                createdAt: new Date("2026-10-01T12:00:00Z"),
              },
              {
                id: "20000000-0000-4000-8000-000000000003",
                action: "expire",
                tradeDate: "2026-09-30",
                quantity: 2,
                price: m("0"),
                cash: m("0"),
                createdAt: new Date("2026-09-30T12:00:01Z"),
              },
              {
                id: "20000000-0000-4000-8000-000000000004",
                action: "close",
                tradeDate: "2026-09-30",
                quantity: 1,
                price: m("0"),
                cash: m("0"),
                createdAt: new Date("2026-09-30T12:00:00Z"),
              },
              {
                id: "20000000-0000-4000-8000-000000000005",
                action: "open",
                tradeDate: "2026-09-01",
                quantity: 3,
                price: m("0"),
                cash: m("0.0010"),
                fees: m("-0.0005"),
              },
            ],
          },
        ],
      });
      const run = db.transaction.bind(db);
      const settings: unknown[] = [];
      const transaction = vi.spyOn(db, "transaction").mockImplementation((use, config) =>
        run(async (tx) => {
          const result = await tx.execute(
            sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as readonly`,
          );
          settings.push(result.rows);
          return use(tx);
        }, config),
      );
      const response = await readMonthlyPnl(db);
      expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      expect(settings).toEqual([[{ isolation: "repeatable read", readonly: "on" }]]);
      transaction.mockRestore();
      expect(
        response.months.map(({ month, pnl, cumulativePnl, closed }) => ({
          month,
          pnl,
          cumulativePnl,
          closed,
        })),
      ).toEqual([
        { month: "2026-09", pnl: 5, cumulativePnl: 5, closed: 2 },
        { month: "2026-10", pnl: 1, cumulativePnl: 6, closed: 1 },
      ]);
      expect(
        response.months.flatMap((month) =>
          month.trades.map(({ action, pnl }) => ({ action, pnl })),
        ),
      ).toEqual([
        { action: "close", pnl: 2 },
        { action: "expire", pnl: 3 },
        { action: "close", pnl: 1 },
      ]);
      expect(await db.select({ closedOn: s.positions.closedOn }).from(s.positions)).toEqual([
        { closedOn: null },
      ]);
    } finally {
      await client.close();
    }
  });

  it("books an October TQQQ roll close, not the new position's opening credit", async () => {
    const { db, client } = await testDatabase();
    try {
      await account(db);
      await db.insert(s.rollChains).values({ id: chainId, campaignId });
      await db.insert(s.rolls).values({ id: rollId, rollChainId: chainId, rolledOn: "2026-10-01" });
      await repository(db).createPosition({
        id: positionId,
        campaignId,
        rollChainId: chainId,
        underlying: "TQQQ",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-15",
        legs: [
          {
            id: legId,
            kind: "put",
            side: "short",
            underlying: "TQQQ",
            strike: m("55"),
            expiry: "2026-10-16",
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-15",
                quantity: 20,
                price: m("2.45"),
                cash: m("4900"),
                fees: m("-13.20"),
              },
              {
                action: "close",
                tradeDate: "2026-10-01",
                quantity: 20,
                price: m("3.19"),
                cash: m("-6380"),
                fees: m("-13.20"),
                rollId,
              },
            ],
          },
        ],
      });
      await repository(db).createPosition({
        campaignId,
        rollChainId: chainId,
        underlying: "TQQQ",
        strategy: "csp",
        role: "income",
        openedOn: "2026-10-01",
        legs: [
          {
            kind: "put",
            side: "short",
            underlying: "TQQQ",
            strike: m("55"),
            expiry: "2026-11-06",
            trades: [
              {
                action: "open",
                tradeDate: "2026-10-01",
                quantity: 20,
                price: m("3.54"),
                cash: m("7080"),
                fees: m("-13.20"),
                rollId,
              },
            ],
          },
        ],
      });
      const response = await readMonthlyPnl(db);
      expect(response.months).toHaveLength(1);
      expect(response.months[0]).toMatchObject({
        month: "2026-10",
        pnl: -15_064_000,
        cumulativePnl: -15_064_000,
        closed: 1,
        wins: 0,
        winRate: 0,
        grossWins: 0,
        grossLosses: 15_064_000,
        profitFactor: 0,
        trades: [
          {
            positionId,
            underlying: "TQQQ",
            action: "close",
            rollId,
            date: "2026-10-01",
            pnl: -15_064_000,
          },
        ],
        byStrategy: [{ strategy: "csp", pnl: -15_064_000, closed: 1 }],
      });
      expect(
        (await repository(db).readOpenBook()).map(({ underlying, closedOn }) => ({
          underlying,
          closedOn,
        })),
      ).toEqual([{ underlying: "TQQQ", closedOn: null }]);
    } finally {
      await client.close();
    }
  });

  it("reproduces the prototype September seed's net outcomes", async () => {
    const { db, client } = await testDatabase();
    try {
      await seedBook(db);
      const response = await readMonthlyPnl(db);
      expect(response.months).toHaveLength(1);
      expect(response.months[0]).toMatchObject({
        month: "2026-09",
        pnl: 66_246_700,
        cumulativePnl: 66_246_700,
        closed: 14,
        wins: 9,
        grossWins: 95_169_700,
        grossLosses: 28_923_000,
      });
      expect(response.months[0]?.trades).toHaveLength(14);
    } finally {
      await client.close();
    }
  }, 20_000);
});

import { expect, it } from "vitest";
import type { Money4 } from "../domain/money.ts";
import { bookTotals } from "../domain/totals.ts";
import { toBookPosition, toBookPositions } from "./book.ts";
import type { Database } from "./database.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { testDatabase } from "./test/database.ts";

async function seedHeldCover(db: Database) {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const campaignId = "00000000-0000-4000-8000-000000000002";
  await db.insert(s.accounts).values({ id: accountId, label: "Held cover", broker: "manual" });
  await db.insert(s.campaigns).values({
    id: campaignId,
    accountId,
    title: "DRAM held shares",
    openedOn: "2026-09-18",
  });
  await repository(db).createPosition({
    campaignId,
    underlying: "DRAM",
    strategy: "cc",
    role: "income",
    openedOn: "2026-09-18",
    legs: [
      {
        kind: "stock",
        side: "long",
        underlying: "DRAM",
        multiplier: 1,
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-18",
            quantity: 1500,
            price: 530000 as Money4,
            cash: -795000000 as Money4,
          },
        ],
      },
      {
        kind: "call",
        side: "short",
        underlying: "DRAM",
        strike: 550000 as Money4,
        expiry: "2026-10-16",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-18",
            quantity: 15,
            price: 11000 as Money4,
            cash: 16500000 as Money4,
          },
        ],
      },
    ],
  });
  return accountId;
}

it("partial held CC close retains500 uncovered shares and81500 deployed with real position ids", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedHeldCover(db);
    const repo = repository(db);
    const position = (await repo.readOpenPositions(accountId)).find(
      (p) => p.strategy === "cc" && p.underlying === "DRAM",
    );
    if (!position) throw new Error("Missing DRAM seed");
    const call = position.legs.find((l) => l.kind === "call");
    if (!call) throw new Error("Missing DRAM call");
    await repo.appendTrades(position.id, [
      {
        legId: call.id,
        action: "close",
        tradeDate: "2026-10-16",
        quantity: 5,
        price: 4000 as Money4,
        cash: -2000000 as Money4,
        fees: 0 as Money4,
      },
    ]);
    const rows = (await repo.readOpenPositions(accountId)).filter((p) => p.id === position.id);
    const book = toBookPositions(rows);
    expect(book).toMatchObject([
      { id: position.id, campaignId: position.campaignId, strategy: "cc", qty: 10, basis: 530000 },
      {
        id: position.id,
        campaignId: position.campaignId,
        strategy: "stock",
        role: "swing",
        shares: 500,
        price: 530000,
      },
    ]);
    expect(bookTotals(book)).toMatchObject({
      contracts: 10,
      incomeCollateral: 550000000,
      swingCapital: 265000000,
      capitalDeployed: 815000000,
    });
  } finally {
    await client.close();
  }
}, 20000);

it.each(["close", "expire"] as const)(
  "renders surviving held CC cover as stock after option %s, including partial stock closes",
  async (action) => {
    const { db, client } = await testDatabase();
    try {
      const accountId = await seedHeldCover(db);
      const repo = repository(db);
      const position = (await repo.readOpenPositions(accountId)).find(
        (p) => p.strategy === "cc" && p.underlying === "DRAM",
      );
      if (!position) throw new Error("Missing DRAM held-cover seed");
      const call = position.legs.find((l) => l.kind === "call");
      const stock = position.legs.find((l) => l.kind === "stock");
      if (!call || !stock) throw new Error("Missing seeded cover legs");
      expect(
        await repo.appendTrades(position.id, [
          {
            legId: call.id,
            action,
            tradeDate: "2026-10-16",
            quantity: 15,
            price: (action === "close" ? 4_000 : 0) as Money4,
            cash: (action === "close" ? -6_000_000 : 0) as Money4,
            fees: 0 as Money4,
          },
        ]),
      ).toBe(null);
      const read = async () => {
        const row = (await repo.readOpenPositions(accountId)).find((p) => p.id === position.id);
        if (!row) throw new Error("Held shares disappeared from open book");
        return row;
      };
      const remaining = await read();
      expect(remaining.strategy).toBe("cc");
      expect(toBookPosition(remaining)).toEqual({
        underlying: "DRAM",
        openedOn: "2026-09-18",
        strategy: "stock",
        role: "swing",
        shares: 1500,
        price: 530_000,
      });
      await repo.appendTrades(position.id, [
        {
          legId: stock.id,
          action: "close",
          tradeDate: "2026-10-19",
          quantity: 500,
          price: 550_000 as Money4,
          cash: 275_000_000 as Money4,
          fees: 0 as Money4,
        },
      ]);
      expect(toBookPosition(await read())).toEqual({
        underlying: "DRAM",
        openedOn: "2026-09-18",
        strategy: "stock",
        role: "swing",
        shares: 1000,
        price: 530_000,
      });
      expect(
        await repo.appendTrades(position.id, [
          {
            legId: stock.id,
            action: "close",
            tradeDate: "2026-10-20",
            quantity: 1000,
            price: 550_000 as Money4,
            cash: 550_000_000 as Money4,
            fees: 0 as Money4,
          },
        ]),
      ).toBe("2026-10-20");
      expect((await repo.readOpenPositions(accountId)).filter((p) => p.id === position.id)).toEqual(
        [],
      );
    } finally {
      await client.close();
    }
  },
  20_000,
);

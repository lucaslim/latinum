import { expect, it } from "vitest";
import type { Money4 } from "../domain/money.ts";
import { toBookPosition } from "./book.ts";
import { repository } from "./repository.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";

it.each(["close", "expire"] as const)(
  "renders surviving seeded CC cover as stock after option %s, including partial stock closes",
  async (action) => {
    const { db, client } = await testDatabase();
    try {
      const accountId = await seedBook(db);
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

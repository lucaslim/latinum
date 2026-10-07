import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { prototypeBook } from "../domain/test/fixtures.ts";
import { bookTotals } from "../domain/totals.ts";
import { toBookPosition } from "./book.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";

test("rerunnable open-book seed reconstructs basis, net debit and domain totals", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedBook(db);
    await seedBook(db);
    const rows = await repository(db).readOpenPositions(accountId);
    const loaded = rows.map(toBookPosition);
    expect(rows).toHaveLength(prototypeBook.length);
    const nvdlCampaign = rows.filter(
      (row) => row.underlying === "NVDL" || row.underlying === "NVDA",
    );
    expect(new Set(nvdlCampaign.map((row) => row.campaignId)).size).toBe(1);
    expect(nvdlCampaign.map((row) => row.underlying).sort()).toEqual(["NVDA", "NVDL", "NVDL"]);
    expect(bookTotals(loaded)).toEqual(bookTotals(prototypeBook));
    expect(bookTotals(loaded)).toMatchObject({
      contracts: 77,
      premium: 144_500_000,
      incomeCollateral: 4_345_000_000,
      capitalDeployed: 4_583_980_000,
    });
    expect(
      loaded.sort((a, b) => a.underlying.localeCompare(b.underlying) || a.price - b.price),
    ).toEqual(
      [...prototypeBook].sort(
        (a, b) => a.underlying.localeCompare(b.underlying) || a.price - b.price,
      ),
    );
    expect(await db.select().from(s.accounts).where(eq(s.accounts.id, accountId))).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 20_000);

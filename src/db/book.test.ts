import { expect, it } from "vitest";
import { parseMoney4 } from "../domain/money.ts";
import { positionMetrics } from "../domain/positions.ts";
import { toBookPosition } from "./book.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { testDatabase } from "./test/database.ts";

it("bridges an opening call debit spread using actual leg fills", async () => {
  const { db, client } = await testDatabase();
  try {
    const [account] = await db
      .insert(s.accounts)
      .values({ label: "Manual", broker: "manual" })
      .returning();
    if (!account) throw new Error("Missing account");
    const [campaign] = await db
      .insert(s.campaigns)
      .values({ accountId: account.id, title: "TQQQ", openedOn: "2026-09-25" })
      .returning();
    if (!campaign) throw new Error("Missing campaign");
    await repository(db).createPosition({
      campaignId: campaign.id,
      underlying: "TQQQ",
      strategy: "call_debit_spread",
      role: "hedge",
      openedOn: "2026-09-25",
      legs: [
        {
          kind: "call",
          side: "long",
          underlying: "TQQQ",
          strike: parseMoney4("55"),
          expiry: "2026-10-09",
          trades: [
            {
              action: "open",
              tradeDate: "2026-09-25",
              quantity: 3,
              price: parseMoney4("1.56"),
              cash: parseMoney4("-468"),
            },
          ],
        },
        {
          kind: "call",
          side: "short",
          underlying: "TQQQ",
          strike: parseMoney4("60"),
          expiry: "2026-10-09",
          trades: [
            {
              action: "open",
              tradeDate: "2026-09-25",
              quantity: 3,
              price: parseMoney4("0"),
              cash: parseMoney4("0"),
            },
          ],
        },
      ],
    });
    const [stored] = await repository(db).readOpenBook();
    if (!stored) throw new Error("Missing position");
    expect(positionMetrics(toBookPosition(stored))).toMatchObject({
      kind: "debit",
      debit: 4680000,
      maxProfit: 10320000,
      maxLoss: 4680000,
    });
  } finally {
    await client.close();
  }
});

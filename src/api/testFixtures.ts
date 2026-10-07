import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/database.ts";
import { repository } from "../db/repository.ts";
import * as s from "../db/schema.ts";
import { seedBook } from "../db/seed.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import type { createApp } from "./app.ts";

/** Local Playwright book only. Never registered by the deployed createApp. */
export function installTestFixtures(app: ReturnType<typeof createApp>, db: Database) {
  async function reset() {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`truncate assignments, marks, trades, rolls, legs, positions, roll_chains, campaigns, accounts cascade`,
      );
      await seedBook(tx);
    });
  }
  app.post("/test/reset", async (c) => {
    await reset();
    return c.json({ ok: true });
  });
  app.post("/test/lifecycle-fixture", async (c) => {
    await reset();
    const result = await db.transaction(async (tx) => {
      const accounts = await tx.select().from(s.accounts);
      const account = accounts[0];
      if (!account) throw new Error("Missing fixture account");
      const accountId = account.id;
      async function put(
        underlying: string,
        quantity: number,
        price: string,
        cash: string,
        fees: string,
        strike: string,
      ) {
        const campaignId = randomUUID();
        await tx.insert(s.campaigns).values({
          id: campaignId,
          accountId,
          title: `${underlying} lifecycle`,
          openedOn: "2026-09-15",
        });
        const legId = randomUUID();
        const positionId = await repository(tx).createPosition({
          campaignId,
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
              trades: [
                {
                  action: "open",
                  tradeDate: "2026-09-15",
                  quantity,
                  price: m(price),
                  cash: m(cash),
                  fees: m(fees),
                },
              ],
            },
          ],
        });
        return { campaignId, positionId, legId };
      }
      const muu = await put("MUU", 10, "1.50", "1500", "-6.60", "25");
      const spxl = await put("SPXL", 2, "3.10", "620", "-1.30", "240");
      const dram = await put("DRAM", 15, "2", "3000", "-9.90", "55");
      const campaignId = randomUUID();
      await tx.insert(s.campaigns).values({
        id: campaignId,
        accountId,
        title: "NVDA lifecycle hedge",
        openedOn: "2026-09-15",
      });
      const positionId = await repository(tx).createPosition({
        campaignId,
        underlying: "NVDA",
        strategy: "put_debit_spread",
        role: "hedge",
        openedOn: "2026-09-15",
        legs: [
          {
            kind: "put",
            side: "long",
            underlying: "NVDA",
            strike: m("10"),
            expiry: "2026-10-16",
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-15",
                quantity: 1,
                price: m("2.18"),
                cash: m("-218"),
              },
            ],
          },
          {
            kind: "put",
            side: "short",
            underlying: "NVDA",
            strike: m("8"),
            expiry: "2026-10-16",
            trades: [
              { action: "open", tradeDate: "2026-09-15", quantity: 1, price: m("0"), cash: m("0") },
            ],
          },
        ],
      });
      return {
        muu,
        spxl,
        dram,
        hedge: { positionId, campaignId },
        targetCampaignId: muu.campaignId,
      };
    });
    return c.json(result);
  });
}

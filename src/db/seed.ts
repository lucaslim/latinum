import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mulMoney4, negMoney4, parseMoney4 } from "../domain/money.ts";
import { prototypeBook } from "../domain/test/fixtures.ts";
import { type NewLeg, repository } from "./repository.ts";
import * as s from "./schema.ts";

const accountId = "00000000-0000-4000-8000-000000000001";

export async function seedBook<HKT extends PgQueryResultHKT>(db: PgDatabase<HKT>) {
  return db.transaction(async (tx) => {
    await tx
      .insert(s.accounts)
      .values({ id: accountId, label: "Prototype open book", broker: "manual" })
      .onConflictDoNothing({ target: s.accounts.id });
    const existing = await tx
      .select()
      .from(s.campaigns)
      .where(eq(s.campaigns.accountId, accountId));
    for (const campaign of existing) {
      await tx.delete(s.positions).where(eq(s.positions.campaignId, campaign.id));
      await tx.delete(s.campaigns).where(eq(s.campaigns.id, campaign.id));
    }
    for (const [index, p] of prototypeBook.entries()) {
      const campaignId = randomUUID();
      await tx
        .insert(s.campaigns)
        .values({ id: campaignId, accountId, title: p.underlying, openedOn: p.openedOn });
      function leg(
        kind: NewLeg["kind"],
        side: NewLeg["side"],
        price: NewLeg["trades"][number]["price"],
        strike: NewLeg["strike"] = null,
      ): NewLeg {
        const stock = kind === "stock";
        const quantity = p.strategy === "stock" ? p.shares : stock ? p.qty * 100 : p.qty;
        const cash = mulMoney4(price, quantity * (stock ? 1 : 100));
        return {
          kind,
          side,
          underlying: p.underlying,
          strike,
          expiry: stock || p.strategy === "stock" ? null : p.expiry,
          multiplier: stock ? 1 : 100,
          adjusted: p.strategy === "stock" ? false : p.adjusted,
          trades: [
            {
              action: "open",
              tradeDate: p.openedOn,
              quantity,
              price,
              cash: side === "short" ? cash : negMoney4(cash),
            },
          ],
        };
      }
      let legs: NewLeg[];
      switch (p.strategy) {
        case "stock":
          legs = [leg("stock", "long", p.price)];
          break;
        case "csp":
          legs = [leg("put", "short", p.price, p.strike)];
          break;
        case "cc":
          legs = [leg("stock", "long", p.basis), leg("call", "short", p.price, p.strike)];
          break;
        case "put_debit_spread":
          // Synthetic opening allocations preserve the net debit without inventing history.
          legs = [
            leg("put", "long", p.price, p.longStrike),
            leg("put", "short", parseMoney4("0"), p.shortStrike),
          ];
          break;
        case "long_call":
          legs = [leg("call", "long", p.price, p.strike)];
          break;
        default:
          throw new Error(`Unsupported seed strategy: ${p.strategy}`);
      }
      await repository(tx).createPosition({
        id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
        campaignId,
        underlying: p.underlying,
        strategy: p.strategy,
        role: p.role,
        openedOn: p.openedOn,
        legs,
      });
    }
    return accountId;
  });
}

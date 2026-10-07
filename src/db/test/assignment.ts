import { randomUUID } from "node:crypto";
import { parseMoney4 } from "../../domain/money.ts";
import type { Database } from "../database.ts";
import * as s from "../schema.ts";

export async function assignmentFixture(db: Database) {
  const ids = {
    accountId: randomUUID(),
    campaignId: randomUUID(),
    putPositionId: randomUUID(),
    putLegId: randomUUID(),
    putOpenTradeId: randomUUID(),
    optionTradeId: randomUUID(),
    stockPositionId: randomUUID(),
    stockLegId: randomUUID(),
    stockTradeId: randomUUID(),
    assignmentId: randomUUID(),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(s.accounts)
      .values({ id: ids.accountId, label: "Assignment fixture", broker: "manual" });
    await tx.insert(s.campaigns).values({
      id: ids.campaignId,
      accountId: ids.accountId,
      title: "DRAM wheel",
      openedOn: "2026-09-15",
    });
    await tx.insert(s.positions).values([
      {
        id: ids.putPositionId,
        campaignId: ids.campaignId,
        underlying: "DRAM",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-15",
        closedOn: "2026-09-25",
        tags: ["wheel", "assigned"],
      },
      {
        id: ids.stockPositionId,
        campaignId: ids.campaignId,
        underlying: "DRAM",
        strategy: "stock",
        role: "swing",
        openedOn: "2026-09-25",
        tags: ["wheel"],
      },
    ]);
    await tx.insert(s.legs).values([
      {
        id: ids.putLegId,
        positionId: ids.putPositionId,
        underlying: "DRAM",
        kind: "put",
        side: "short",
        strike: parseMoney4("55"),
        expiry: "2026-09-25",
      },
      {
        id: ids.stockLegId,
        positionId: ids.stockPositionId,
        underlying: "DRAM",
        kind: "stock",
        side: "long",
        multiplier: 1,
      },
    ]);
    await tx.insert(s.trades).values([
      {
        id: ids.putOpenTradeId,
        legId: ids.putLegId,
        action: "open",
        tradeDate: "2026-09-15",
        quantity: 15,
        price: parseMoney4("2"),
        cash: parseMoney4("3000"),
        fees: parseMoney4("-9.90"),
      },
      {
        id: ids.optionTradeId,
        legId: ids.putLegId,
        action: "assign",
        tradeDate: "2026-09-25",
        quantity: 15,
        price: parseMoney4("0"),
        cash: parseMoney4("0"),
      },
      {
        id: ids.stockTradeId,
        legId: ids.stockLegId,
        action: "open",
        tradeDate: "2026-09-25",
        quantity: 1500,
        price: parseMoney4("55"),
        cash: parseMoney4("-82500"),
      },
    ]);
    await tx.insert(s.assignments).values({
      id: ids.assignmentId,
      optionTradeId: ids.optionTradeId,
      stockTradeId: ids.stockTradeId,
      shares: 1500,
      premiumPerShare: parseMoney4("2"),
    });
  });
  return ids;
}

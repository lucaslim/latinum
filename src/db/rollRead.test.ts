import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { parseIsoDate } from "../domain/dates.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import { toBookPositions } from "./book.ts";
import { campaignRepository } from "./campaigns.ts";
import { repository } from "./repository.ts";
import * as s from "./schema.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";

const chainId = "90000000-0000-4000-8000-000000000001";
const rollId = "90000000-0000-4000-8000-000000000002";

test("campaign and Sheet reads expose persisted chain and trade roll links", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedBook(db);
    const source = (await repository(db).readOpenBook()).find((p) => p.underlying === "QQQ");
    assert(source);
    await db.insert(s.rollChains).values({ id: chainId, campaignId: source.campaignId });
    await db.insert(s.rolls).values({ id: rollId, rollChainId: chainId, rolledOn: "2026-10-01" });
    await db.update(s.positions).set({ rollChainId: chainId }).where(eq(s.positions.id, source.id));
    const events = source.legs.map((leg) => ({
      legId: leg.id,
      action: "close" as const,
      tradeDate: "2026-10-01",
      quantity: 2,
      price: m(leg.side === "long" ? "0.42" : "0"),
      cash: m(leg.side === "long" ? "84" : "0"),
      rollId,
    }));
    await repository(db).appendTrades(source.id, events);
    const nextId = await repository(db).createPosition({
      campaignId: source.campaignId,
      rollChainId: chainId,
      underlying: "QQQ",
      strategy: "put_debit_spread",
      role: "hedge",
      openedOn: "2026-10-01",
      legs: source.legs.map((leg) => ({
        kind: leg.kind,
        side: leg.side,
        underlying: "QQQ",
        strike: leg.strike,
        expiry: "2026-11-06",
        trades: [
          {
            action: "open",
            tradeDate: "2026-10-01",
            quantity: 2,
            price: m(leg.side === "long" ? "0.77" : "0"),
            cash: m(leg.side === "long" ? "-154" : "0"),
            rollId,
          },
        ],
      })),
    });
    const campaign = await campaignRepository(db).readCampaign(
      source.campaignId,
      parseIsoDate("2026-10-01"),
    );
    assert(campaign);
    expect(campaign.rolls).toEqual([{ id: rollId, rollChainId: chainId, rolledOn: "2026-10-01" }]);
    expect(campaign.positions.map((p) => p.rollChainId)).toEqual([chainId, chainId]);
    expect(
      campaign.positions
        .flatMap((p) => p.legs.flatMap((l) => l.trades))
        .map((t) => t.rollId)
        .sort(),
    ).toEqual([rollId, rollId, rollId, rollId, null, null].sort());
    expect(toBookPositions(await repository(db).readOpenPositions(accountId))).toContainEqual(
      expect.objectContaining({ id: nextId, rollChainId: chainId }),
    );
    expect(campaign.positions[0]?.closedOn).toBe("2026-10-01");
  } finally {
    await client.close();
  }
}, 20000);

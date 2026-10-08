import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Money4 } from "../../domain/money.ts";
import type { Database } from "../database.ts";
import { positionRevision } from "../positionRevision.ts";
import { repository } from "../repository.ts";
import * as s from "../schema.ts";

const m = (value: number) => value as Money4;

export async function revision(db: Database, positionId: string) {
  const [position] = await db.select().from(s.positions).where(eq(s.positions.id, positionId));
  assert(position);
  const legs = await db.select().from(s.legs).where(eq(s.legs.positionId, positionId));
  const trades = legs.length
    ? await db
        .select()
        .from(s.trades)
        .where(
          inArray(
            s.trades.legId,
            legs.map((l) => l.id),
          ),
        )
    : [];
  return positionRevision(position, legs, trades);
}

async function campaign(db: Database, underlying: string) {
  const [account] = await db
    .insert(s.accounts)
    .values({ label: "Roll fixture", broker: "manual" })
    .returning();
  assert(account);
  const [campaign] = await db
    .insert(s.campaigns)
    .values({ accountId: account.id, title: underlying, openedOn: "2026-08-28" })
    .returning();
  assert(campaign);
  return { accountId: account.id, campaignId: campaign.id };
}

export async function qqqFixture(db: Database) {
  const ids = await campaign(db, "QQQ");
  const longId = randomUUID();
  const shortId = randomUUID();
  const positionId = await repository(db).createPosition({
    campaignId: ids.campaignId,
    underlying: "QQQ",
    strategy: "put_debit_spread",
    role: "hedge",
    openedOn: "2026-09-01",
    tags: ["hedge"],
    notes: "Keep notes",
    legs: [
      {
        id: longId,
        kind: "put",
        side: "long",
        underlying: "QQQ",
        strike: m(6700000),
        expiry: "2026-10-16",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-01",
            quantity: 2,
            price: m(7000),
            cash: m(-1400000),
          },
        ],
      },
      {
        id: shortId,
        kind: "put",
        side: "short",
        underlying: "QQQ",
        strike: m(6650000),
        expiry: "2026-10-16",
        trades: [{ action: "open", tradeDate: "2026-09-01", quantity: 2, price: m(0), cash: m(0) }],
      },
    ],
  });
  return {
    ...ids,
    positionId,
    longId,
    shortId,
    raw: {
      positionId,
      expectedRevision: await revision(db, positionId),
      tradeDate: "2026-10-01",
      expiry: "2026-11-06",
      fills: [
        { legId: shortId, closePrice: "0", strike: "665", openPrice: "0" },
        { legId: longId, closePrice: "0.42", strike: "670", openPrice: "0.77" },
      ],
    },
  };
}

export async function tqqqFixture(db: Database) {
  const ids = await campaign(db, "TQQQ");
  const chainId = randomUUID();
  const priorRollId = randomUUID();
  const priorPositionId = randomUUID();
  const priorLegId = randomUUID();
  await db.insert(s.rollChains).values({ id: chainId, campaignId: ids.campaignId });
  await db
    .insert(s.rolls)
    .values({ id: priorRollId, rollChainId: chainId, rolledOn: "2026-09-24" });
  await db.insert(s.positions).values({
    id: priorPositionId,
    campaignId: ids.campaignId,
    rollChainId: chainId,
    underlying: "TQQQ",
    strategy: "csp",
    role: "income",
    openedOn: "2026-08-28",
    closedOn: "2026-09-24",
  });
  await db.insert(s.legs).values({
    id: priorLegId,
    positionId: priorPositionId,
    underlying: "TQQQ",
    kind: "put",
    side: "short",
    strike: m(580000),
    expiry: "2026-09-25",
  });
  await db.insert(s.trades).values([
    {
      legId: priorLegId,
      action: "open",
      tradeDate: "2026-08-28",
      quantity: 20,
      price: m(17000),
      cash: m(34000000),
      fees: m(-66000),
      createdAt: new Date("2026-08-28T12:00:00Z"),
    },
    {
      legId: priorLegId,
      action: "close",
      tradeDate: "2026-09-24",
      quantity: 20,
      price: m(21000),
      cash: m(-42000000),
      fees: m(-66000),
      rollId: priorRollId,
      createdAt: new Date("2026-09-24T12:00:00Z"),
    },
  ]);
  const legId = randomUUID();
  const positionId = await repository(db).createPosition({
    campaignId: ids.campaignId,
    rollChainId: chainId,
    underlying: "TQQQ",
    strategy: "csp",
    role: "income",
    openedOn: "2026-09-24",
    legs: [
      {
        id: legId,
        kind: "put",
        side: "short",
        underlying: "TQQQ",
        strike: m(550000),
        expiry: "2026-10-23",
        trades: [
          {
            action: "open",
            tradeDate: "2026-09-24",
            quantity: 20,
            price: m(24500),
            cash: m(49000000),
            rollId: priorRollId,
          },
        ],
      },
    ],
  });
  return {
    ...ids,
    positionId,
    legId,
    chainId,
    priorRollId,
    priorLegId,
    raw: {
      positionId,
      expectedRevision: await revision(db, positionId),
      tradeDate: "2026-10-01",
      expiry: "2026-11-06",
      fills: [{ legId, closePrice: "3.19", strike: "55", openPrice: "3.54" }],
    },
  };
}

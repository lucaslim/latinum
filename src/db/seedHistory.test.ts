import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { parseIsoDate } from "../domain/dates.ts";
import { allocateRealizedTrades } from "../domain/lifecyclePnl.ts";
import { sumMoney4 } from "../domain/money.ts";
import * as s from "./schema.ts";
import { seedBook } from "./seed.ts";
import { assignmentFixture } from "./test/assignment.ts";
import { testDatabase } from "./test/database.ts";

async function history(db: Awaited<ReturnType<typeof testDatabase>>["db"], accountId: string) {
  const positions = await db
    .select({ position: s.positions })
    .from(s.positions)
    .innerJoin(s.campaigns, eq(s.positions.campaignId, s.campaigns.id))
    .where(eq(s.campaigns.accountId, accountId));
  const legs = await db.select().from(s.legs);
  const trades = await db
    .select()
    .from(s.trades)
    .orderBy(s.trades.tradeDate, s.trades.createdAt, s.trades.id);
  return positions
    .flatMap(({ position }) => {
      if (position.closedOn === null) return [];
      const allocations = legs
        .filter((leg) => leg.positionId === position.id)
        .flatMap((leg) =>
          allocateRealizedTrades(
            trades
              .filter((t) => t.legId === leg.id)
              .map((t) => ({
                id: t.id,
                action: t.action,
                date: parseIsoDate(t.tradeDate),
                quantity: t.quantity,
                cash: t.cash,
                fees: t.fees,
              })),
          ),
        );
      return [
        {
          date: position.closedOn,
          underlying: position.underlying,
          strategy: position.strategy,
          pnl: sumMoney4(allocations.map((a) => a.pnl)),
          months: [...new Set(allocations.map((a) => a.bookedMonth))],
          fills: allocations.length,
        },
      ];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.underlying.localeCompare(b.underlying));
}

test("seedBook records the fourteen CLOSED outcomes, not unrelated HISTORY aggregates", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedBook(db);
    await seedBook(db);
    const outcomes = await history(db, accountId);
    expect(outcomes).toHaveLength(14);
    expect(outcomes.map(({ months: _months, fills: _fills, ...row }) => row)).toEqual([
      { date: "2026-09-03", underlying: "TSLA", strategy: "day_trade", pnl: 3_180_000 },
      { date: "2026-09-08", underlying: "NVDA", strategy: "day_trade", pnl: -1_810_000 },
      { date: "2026-09-11", underlying: "MUU", strategy: "csp", pnl: 14_934_000 },
      { date: "2026-09-11", underlying: "SPXL", strategy: "csp", pnl: 5_374_000 },
      { date: "2026-09-12", underlying: "SMCI", strategy: "stock", pnl: -12_420_000 },
      { date: "2026-09-15", underlying: "SPY", strategy: "day_trade", pnl: 4_054_000 },
      { date: "2026-09-18", underlying: "AVGX", strategy: "csp", pnl: 17_434_000 },
      { date: "2026-09-18", underlying: "DRAM", strategy: "csp", pnl: 29_901_000 },
      { date: "2026-09-19", underlying: "COIN", strategy: "long_call", pnl: -5_613_000 },
      { date: "2026-09-22", underlying: "QQQ", strategy: "put_debit_spread", pnl: 2_371_700 },
      { date: "2026-09-24", underlying: "TQQQ", strategy: "csp", pnl: -8_132_000 },
      { date: "2026-09-25", underlying: "MRVL", strategy: "csp", pnl: 8_987_000 },
      { date: "2026-09-25", underlying: "NVDL", strategy: "csp", pnl: 8_934_000 },
      { date: "2026-09-29", underlying: "AMD", strategy: "day_trade", pnl: -948_000 },
    ]);
    expect(sumMoney4(outcomes.map((row) => row.pnl))).toBe(66_246_700);
    expect(outcomes.filter((row) => row.pnl > 0)).toHaveLength(9);
    expect(sumMoney4(outcomes.filter((row) => row.pnl > 0).map((row) => row.pnl))).toBe(95_169_700);
    expect(sumMoney4(outcomes.filter((row) => row.pnl < 0).map((row) => row.pnl))).toBe(
      -28_923_000,
    );
    expect(outcomes.map((row) => row.months)).toEqual(
      Array.from({ length: 14 }, () => ["2026-09"]),
    );
    expect(outcomes.find((row) => row.underlying === "QQQ")?.fills).toBe(2);

    const stored = await db
      .select({ trade: s.trades, leg: s.legs })
      .from(s.trades)
      .innerJoin(s.legs, eq(s.trades.legId, s.legs.id));
    expect(stored.filter(({ trade }) => trade.fees > 0)).toEqual([]);
    expect(
      stored.filter(
        ({ trade, leg }) =>
          trade.cash !==
          trade.price *
            trade.quantity *
            leg.multiplier *
            (trade.action === "open"
              ? leg.side === "short"
                ? 1
                : -1
              : leg.side === "short"
                ? -1
                : 1),
      ),
    ).toEqual([]);
  } finally {
    await client.close();
  }
}, 20_000);

test("failed history replacement restores the prior book and assignment/roll references", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedBook(db);
    const [assignment] = await db.select().from(s.assignments);
    const [roll] = await db.select().from(s.rolls);
    if (!assignment || !roll) throw new Error("Missing seeded relationships");
    await client.exec(`
      CREATE FUNCTION reject_seed_roll() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'history insert rejected'; END $$;
      CREATE TRIGGER reject_seed_roll BEFORE INSERT ON rolls
      FOR EACH ROW EXECUTE FUNCTION reject_seed_roll();
    `);
    await expect(seedBook(db)).rejects.toMatchObject({
      cause: { message: "history insert rejected" },
    });
    expect(await db.select().from(s.assignments)).toEqual([assignment]);
    expect(await db.select().from(s.rolls)).toEqual([roll]);
    expect(await history(db, accountId)).toHaveLength(14);
    expect(await db.select().from(s.positions)).toHaveLength(27);
  } finally {
    await client.close();
  }
}, 20_000);

test("the single-account lifecycle boundary rolls back replacement without deleting foreign history", async () => {
  const { db, client } = await testDatabase();
  try {
    const accountId = await seedBook(db);
    const foreign = await assignmentFixture(db);
    await expect(seedBook(db)).rejects.toThrow("Lifecycle requires a single account");
    expect(await db.select().from(s.assignments)).toHaveLength(2);
    expect(
      await db.select().from(s.assignments).where(eq(s.assignments.id, foreign.assignmentId)),
    ).toEqual([
      {
        id: foreign.assignmentId,
        optionTradeId: foreign.optionTradeId,
        stockTradeId: foreign.stockTradeId,
        shares: 1500,
        premiumPerShare: 20_000,
      },
    ]);
    expect(
      await db.select().from(s.campaigns).where(eq(s.campaigns.id, foreign.campaignId)),
    ).toMatchObject([
      { accountId: foreign.accountId, title: "DRAM wheel", openedOn: "2026-09-15" },
    ]);
    expect(
      await db.select().from(s.positions).where(eq(s.positions.campaignId, foreign.campaignId)),
    ).toHaveLength(2);
    expect(await history(db, accountId)).toHaveLength(14);
    expect(await db.select().from(s.rolls)).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 20_000);

test("seedBook reruns retain the DRAM assignment/coverage and TQQQ roll relationships", async () => {
  const { db, client } = await testDatabase();
  try {
    await seedBook(db);
    await seedBook(db);
    const assignments = await db.select().from(s.assignments);
    expect(assignments).toHaveLength(1);
    const assignment = assignments[0];
    if (!assignment) throw new Error("Missing assignment");
    expect(assignment).toMatchObject({ shares: 1500, premiumPerShare: 20_000 });
    const [optionTrade] = await db
      .select()
      .from(s.trades)
      .where(eq(s.trades.id, assignment.optionTradeId));
    const [stockTrade] = await db
      .select()
      .from(s.trades)
      .where(eq(s.trades.id, assignment.stockTradeId));
    expect(optionTrade).toMatchObject({
      action: "assign",
      tradeDate: "2026-09-18",
      quantity: 15,
      cash: 0,
      fees: 0,
    });
    expect(stockTrade).toMatchObject({
      action: "open",
      tradeDate: "2026-09-18",
      quantity: 1500,
      price: 550_000,
      cash: -825_000_000,
      fees: 0,
    });
    if (!optionTrade || !stockTrade) throw new Error("Missing assignment trades");
    const [stockLeg] = await db.select().from(s.legs).where(eq(s.legs.id, stockTrade.legId));
    const [callLeg] = await db
      .select()
      .from(s.legs)
      .where(eq(s.legs.coveredLegId, stockTrade.legId));
    expect(stockLeg).toMatchObject({ kind: "stock", multiplier: 1 });
    expect(callLeg).toMatchObject({
      kind: "call",
      side: "short",
      strike: 550_000,
      coveredLegId: stockTrade.legId,
    });
    if (!stockLeg || !callLeg) throw new Error("Missing wheel legs");
    const [stockPosition] = await db
      .select()
      .from(s.positions)
      .where(eq(s.positions.id, stockLeg.positionId));
    const [callPosition] = await db
      .select()
      .from(s.positions)
      .where(eq(s.positions.id, callLeg.positionId));
    expect(callPosition).toMatchObject({
      campaignId: stockPosition?.campaignId,
      openedOn: "2026-09-18",
    });
    if (!callPosition) throw new Error("Missing call position");
    const [campaign] = await db
      .select()
      .from(s.campaigns)
      .where(eq(s.campaigns.id, callPosition.campaignId));
    expect(campaign).toMatchObject({ openedOn: "2026-08-21" });
    expect(
      await db
        .select()
        .from(s.legs)
        .where(and(eq(s.legs.positionId, callPosition.id), eq(s.legs.kind, "stock"))),
    ).toEqual([]);
    const [putOpen] = await db
      .select()
      .from(s.trades)
      .where(and(eq(s.trades.legId, optionTrade.legId), eq(s.trades.action, "open")));
    expect(putOpen).toMatchObject({
      tradeDate: "2026-08-21",
      price: 20_000,
      quantity: 15,
      cash: 30_000_000,
      fees: -99_000,
    });

    const chains = await db.select().from(s.rollChains);
    const rolls = await db.select().from(s.rolls);
    expect(chains).toHaveLength(1);
    expect(rolls).toHaveLength(1);
    const chain = chains[0];
    const roll = rolls[0];
    if (!chain || !roll) throw new Error("Missing roll");
    expect(roll).toMatchObject({
      rollChainId: chain.id,
      rolledOn: "2026-09-24",
      detectedBy: "manual",
    });
    const linkedPositions = await db
      .select()
      .from(s.positions)
      .where(eq(s.positions.rollChainId, chain.id))
      .orderBy(s.positions.openedOn);
    expect(
      linkedPositions.map((p) => ({
        openedOn: p.openedOn,
        closedOn: p.closedOn,
        underlying: p.underlying,
        campaignId: p.campaignId,
      })),
    ).toEqual([
      {
        openedOn: "2026-08-28",
        closedOn: "2026-09-24",
        underlying: "TQQQ",
        campaignId: chain.campaignId,
      },
      { openedOn: "2026-09-24", closedOn: null, underlying: "TQQQ", campaignId: chain.campaignId },
    ]);
    expect(
      (
        await db.select().from(s.trades).where(eq(s.trades.rollId, roll.id)).orderBy(s.trades.cash)
      ).map((t) => ({
        action: t.action,
        tradeDate: t.tradeDate,
        price: t.price,
        quantity: t.quantity,
        cash: t.cash,
      })),
    ).toEqual([
      { action: "close", tradeDate: "2026-09-24", price: 21_000, quantity: 20, cash: -42_000_000 },
      { action: "open", tradeDate: "2026-09-24", price: 24_500, quantity: 20, cash: 49_000_000 },
    ]);
  } finally {
    await client.close();
  }
}, 20_000);

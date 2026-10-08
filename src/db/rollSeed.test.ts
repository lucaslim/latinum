import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { parseIsoDate } from "../domain/dates.ts";
import { allocateRealizedTrades } from "../domain/lifecyclePnl.ts";
import { parseMoney4 as m, sumMoney4 } from "../domain/money.ts";
import { campaignRepository } from "./campaigns.ts";
import { repository } from "./repository.ts";
import { rollRepository } from "./rolls.ts";
import { seedBook } from "./seed.ts";
import { testDatabase } from "./test/database.ts";

test("seedBook's historical TQQQ chain rolls from4100 to4800 gross without rewriting prior links", async () => {
  const { db, client } = await testDatabase();
  try {
    await seedBook(db);
    const source = (await repository(db).readOpenBook()).find((p) => p.underlying === "TQQQ");
    assert(source);
    const campaign = await campaignRepository(db).readCampaign(
      source.campaignId,
      parseIsoDate("2026-10-01"),
    );
    assert(campaign);
    const current = campaign.positions.find((p) => p.id === source.id);
    assert(current);
    expect(typeof current.rollChainId).toBe("string");
    const history = campaign.positions
      .filter((p) => p.rollChainId === current.rollChainId)
      .flatMap((p) => p.legs.flatMap((l) => l.trades));
    expect(sumMoney4(history.map((t) => t.cash))).toBe(41000000);
    const previous = campaign.positions.find((p) => p.closedOn === "2026-09-24");
    assert(previous);
    const realized = previous.legs.flatMap((l) =>
      allocateRealizedTrades(l.trades.map((t) => ({ ...t, date: t.tradeDate }))),
    );
    expect(realized.map((r) => r.pnl)).toEqual([-8132000]);
    const result = await rollRepository(db).rollPosition({
      positionId: current.id,
      expectedRevision: current.revision,
      tradeDate: parseIsoDate("2026-10-01"),
      expiry: parseIsoDate("2026-11-06"),
      fills: current.legs.map((l) => ({
        legId: l.id,
        closePrice: m("3.19"),
        closeFees: m("0"),
        strike: m("55"),
        openPrice: m("3.54"),
        openFees: m("0"),
      })),
    });
    expect(result?.metrics).toMatchObject({
      realizedGross: -14800000,
      rollCashGross: 7000000,
      chainCashGross: 48000000,
    });
    expect(result?.realized.map((r) => r.bookedMonth)).toEqual(["2026-10"]);
    const after = await campaignRepository(db).readCampaign(
      source.campaignId,
      parseIsoDate("2026-10-01"),
    );
    expect(
      after?.positions.find((p) => p.id === previous.id)?.legs.flatMap((l) => l.trades),
    ).toEqual(previous.legs.flatMap((l) => l.trades));
  } finally {
    await client.close();
  }
}, 20000);

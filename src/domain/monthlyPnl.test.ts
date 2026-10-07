import { describe, expect, it } from "vitest";
import type { IsoDate } from "./dates.ts";
import type { Money4 } from "./money.ts";
import { aggregateMonthlyPnl } from "./monthlyPnl.ts";
import type { MonthlyPnlLeg, MonthlyPnlTrade } from "./monthlyPnlTypes.ts";

function trade(
  id: string,
  action: MonthlyPnlTrade["action"],
  quantity: number,
  cash: number,
  fees = 0,
  date = "2026-09-30",
  rollId: string | null = null,
): MonthlyPnlTrade {
  return {
    id,
    action,
    quantity,
    cash: cash as Money4,
    fees: fees as Money4,
    date: date as IsoDate,
    rollId,
  };
}

function leg(
  positionId: string,
  trades: MonthlyPnlTrade[],
  strategy: MonthlyPnlLeg["strategy"] = "csp",
  legId = positionId,
): MonthlyPnlLeg {
  return { legId, positionId, campaignId: "campaign", underlying: "MUU", strategy, trades };
}

describe("aggregateMonthlyPnl", () => {
  it("books partial closes on still-open positions using net allocator P/L", () => {
    expect(
      aggregateMonthlyPnl([
        leg("partial", [
          trade("open", "open", 10, 15_000_000, -66_000, "2026-09-01"),
          trade("half", "close", 5, -2_000_000, -33_000),
        ]),
      ]),
    ).toEqual({
      months: [
        {
          month: "2026-09",
          pnl: 5_434_000,
          cumulativePnl: 5_434_000,
          closed: 1,
          wins: 1,
          winRate: 1,
          grossWins: 5_434_000,
          grossLosses: 0,
          profitFactor: null,
          trades: [
            {
              id: '["partial","2026-09-30","close",null]',
              positionId: "partial",
              campaignId: "campaign",
              underlying: "MUU",
              strategy: "csp",
              date: "2026-09-30",
              action: "close",
              rollId: null,
              tradeIds: ["half"],
              pnl: 5_434_000,
            },
          ],
          byStrategy: [
            {
              strategy: "csp",
              pnl: 5_434_000,
              closed: 1,
              wins: 1,
              winRate: 1,
              grossWins: 5_434_000,
              grossLosses: 0,
              profitFactor: null,
            },
          ],
        },
      ],
    });
  });

  it("preserves chronological pools and consumes final cash/fee remainders", () => {
    const legs = [
      leg("pool", [
        trade("reopen", "open", 2, -9, -3, "2026-10-01"),
        trade("close-new", "close", 1, 7, -1, "2026-10-01"),
        trade("old", "open", 3, 10, -5, "2026-09-01"),
        trade("old-half", "close", 1, 0, 0),
        trade("old-final", "expire", 2, 0, 0),
      ]),
    ];
    const before = structuredClone(legs);
    const response = aggregateMonthlyPnl(legs);
    expect(
      response.months.map(({ month, pnl, cumulativePnl, closed }) => ({
        month,
        pnl,
        cumulativePnl,
        closed,
      })),
    ).toEqual([
      { month: "2026-09", pnl: 5, cumulativePnl: 5, closed: 2 },
      { month: "2026-10", pnl: 1, cumulativePnl: 6, closed: 1 },
    ]);
    expect(response.months.flatMap((month) => month.trades.map((outcome) => outcome.pnl))).toEqual([
      2, 3, 1,
    ]);
    expect(legs).toEqual(before);
  });

  it("groups same-day fills and spread legs before counting wins or gross amounts", () => {
    const response = aggregateMonthlyPnl([
      leg(
        "spread",
        [
          trade("s-open", "open", 2, 100),
          trade("s-close-1", "close", 1, 0, -5),
          trade("s-close-2", "close", 1, 0, -5),
        ],
        "put_credit_spread",
        "short",
      ),
      leg(
        "spread",
        [trade("l-open", "open", 2, -120), trade("l-close", "close", 2, 0, -10)],
        "put_credit_spread",
        "long",
      ),
      leg("winner", [trade("w-open", "open", 1, 70, -10), trade("w-close", "close", 1, 0)]),
      leg("flat", [trade("f-open", "open", 1, 10, -10), trade("f-close", "expire", 1, 0)], "cc"),
    ]);
    expect(response.months[0]).toMatchObject({
      pnl: 20,
      cumulativePnl: 20,
      closed: 3,
      wins: 1,
      winRate: 0.3333333333333333,
      grossWins: 60,
      grossLosses: 40,
      profitFactor: 1.5,
      byStrategy: [
        {
          strategy: "cc",
          pnl: 0,
          closed: 1,
          wins: 0,
          winRate: 0,
          grossWins: 0,
          grossLosses: 0,
          profitFactor: null,
        },
        {
          strategy: "csp",
          pnl: 60,
          closed: 1,
          wins: 1,
          winRate: 1,
          grossWins: 60,
          grossLosses: 0,
          profitFactor: null,
        },
        {
          strategy: "put_credit_spread",
          pnl: -40,
          closed: 1,
          wins: 0,
          winRate: 0,
          grossWins: 0,
          grossLosses: 40,
          profitFactor: 0,
        },
      ],
    });
    expect(
      response.months[0]?.trades.map(({ positionId, pnl, tradeIds }) => ({
        positionId,
        pnl,
        tradeIds,
      })),
    ).toEqual([
      { positionId: "flat", pnl: 0, tradeIds: ["f-close"] },
      { positionId: "spread", pnl: -40, tradeIds: ["l-close", "s-close-1", "s-close-2"] },
      { positionId: "winner", pnl: 60, tradeIds: ["w-close"] },
    ]);
  });

  it("keeps distinct dates, actions and rolls as separate outcomes", () => {
    const response = aggregateMonthlyPnl([
      leg("separate", [
        trade("open", "open", 5, 50),
        trade("ordinary", "close", 1, 0),
        trade("roll-a", "close", 1, 0, 0, "2026-09-30", "roll-a"),
        trade("roll-b", "close", 1, 0, 0, "2026-09-30", "roll-b"),
        trade("expire", "expire", 1, 0),
        trade("next-day", "close", 1, 0, 0, "2026-10-01"),
      ]),
    ]);
    expect(response.months.map(({ closed, pnl }) => ({ closed, pnl }))).toEqual([
      { closed: 4, pnl: 40 },
      { closed: 1, pnl: 10 },
    ]);
    expect(response.months[0]?.trades.map(({ action, rollId }) => ({ action, rollId }))).toEqual([
      { action: "close", rollId: null },
      { action: "close", rollId: "roll-a" },
      { action: "close", rollId: "roll-b" },
      { action: "expire", rollId: null },
    ]);
  });

  it("includes zero gap months across years, but no unrealized boundary months", () => {
    const response = aggregateMonthlyPnl([
      leg("late", [
        trade("late-open", "open", 1, 10, 0, "2026-11-01"),
        trade("late-close", "close", 1, -30, 0, "2027-02-01"),
      ]),
      leg("early", [
        trade("early-open", "open", 1, 30, 0, "2026-08-01"),
        trade("early-close", "expire", 1, 0, 0, "2026-12-01"),
      ]),
      leg("still-open", [trade("future-open", "open", 1, 500, 0, "2027-03-01")]),
    ]);
    expect(
      response.months.map(({ month, pnl, cumulativePnl }) => ({ month, pnl, cumulativePnl })),
    ).toEqual([
      { month: "2026-12", pnl: 30, cumulativePnl: 30 },
      { month: "2027-01", pnl: 0, cumulativePnl: 30 },
      { month: "2027-02", pnl: -20, cumulativePnl: 10 },
    ]);
    expect(response.months[1]).toEqual({
      month: "2027-01",
      pnl: 0,
      cumulativePnl: 30,
      closed: 0,
      wins: 0,
      winRate: null,
      grossWins: 0,
      grossLosses: 0,
      profitFactor: null,
      trades: [],
      byStrategy: [],
    });
  });

  it.each([
    ["MUU", 10, 15_000_000, -66_000, "expire", 0, 0, 14_934_000],
    ["SPXL", 2, 6_200_000, -13_000, "close", -800_000, -13_000, 5_374_000],
    ["DRAM", 15, 30_000_000, -99_000, "assign", 0, 0, 29_901_000],
  ] as const)(
    "books T8 %s net in the closing month",
    (name, qty, cash, fees, action, closeCash, closeFees, pnl) => {
      const response = aggregateMonthlyPnl([
        leg(name, [
          trade("open", "open", qty, cash, fees, "2026-09-01"),
          trade("done", action, qty, closeCash, closeFees, "2026-10-01"),
        ]),
      ]);
      expect(response.months).toHaveLength(1);
      expect(response.months[0]).toMatchObject({
        month: "2026-10",
        pnl,
        cumulativePnl: pnl,
        closed: 1,
        wins: 1,
      });
    },
  );

  it("returns no months for an empty book or only open pools", () => {
    expect(aggregateMonthlyPnl([])).toEqual({ months: [] });
    expect(
      aggregateMonthlyPnl([leg("open", [trade("open", "open", 10, 15_000_000, -66_000)])]),
    ).toEqual({ months: [] });
  });
});

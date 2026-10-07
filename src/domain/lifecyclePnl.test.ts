import { describe, expect, it } from "vitest";
import type { IsoDate } from "./dates.ts";
import { allocateRealizedTrades } from "./lifecyclePnl.ts";
import type { QuantityTrade } from "./lifecycleTypes.ts";
import { type Money4, prorateMoney4 } from "./money.ts";

/** Build a quantity-trade fixture from literal Money4 units without applying production calculations. */
function trade(
  id: string,
  action: QuantityTrade["action"],
  quantity: number,
  cash: number,
  fees = 0,
  date = "2026-09-30",
): QuantityTrade {
  return {
    id,
    action,
    quantity,
    cash: cash as Money4,
    fees: fees as Money4,
    date: date as IsoDate,
  };
}

describe("prorateMoney4 integer boundary", () => {
  it.each([
    [0.5, 1, 2],
    [9_007_199_254_740_992, 1, 2],
    [10, 0.5, 2],
    [10, 1, 2.5],
    [10, -1, 2],
    [10, 1, 0],
    [10, 3, 2],
  ])("rejects invalid apportionment (%s, %s, %s)", (amount, quantity, total) => {
    expect(() => prorateMoney4(amount as Money4, quantity, total)).toThrow(RangeError);
  });

  it("supports zero quantity without a negative zero amount", () => {
    expect(prorateMoney4(-10 as Money4, 0, 3)).toBe(0);
  });
});

describe("allocateRealizedTrades", () => {
  it.each([
    ["MUU", 10, 15_000_000, -66_000, "expire", 0, 0, 14_934_000],
    ["SPXL", 2, 6_200_000, -13_000, "close", -800_000, -13_000, 5_374_000],
    ["DRAM", 15, 30_000_000, -99_000, "assign", 0, 0, 29_901_000],
  ] as const)(
    "reproduces T3 %s net P/L",
    (_name, quantity, cash, fees, action, closeCash, closeFees, pnl) => {
      expect(
        allocateRealizedTrades([
          trade("open", "open", quantity, cash, fees, "2026-09-01"),
          trade("done", action, quantity, closeCash, closeFees, "2026-10-01"),
        ]),
      ).toEqual([
        {
          tradeId: "done",
          quantity,
          openingCash: cash,
          openingFees: fees,
          pnl,
          bookedMonth: "2026-10",
        },
      ]);
    },
  );

  it("allocates a 5/10 close pro rata, leaving the rest unrealized", () => {
    expect(
      allocateRealizedTrades([
        trade("open", "open", 10, 15_000_000, -66_000),
        trade("half", "close", 5, -2_000_000, -33_000),
      ]),
    ).toEqual([
      {
        tradeId: "half",
        quantity: 5,
        openingCash: 7_500_000,
        openingFees: -33_000,
        pnl: 5_434_000,
        bookedMonth: "2026-09",
      },
    ]);
  });

  it("pools multiple opens, then only remaining cash and fees with interleaved opens", () => {
    expect(
      allocateRealizedTrades([
        trade("one", "open", 2, 10, -3),
        trade("two", "open", 1, 7, -2),
        trade("partial", "close", 1, -2, -1),
        trade("three", "open", 2, 20, -3),
        trade("next", "close", 2, -4, -2),
        trade("final", "expire", 2, 0),
      ]),
    ).toEqual([
      {
        tradeId: "partial",
        quantity: 1,
        openingCash: 5,
        openingFees: -1,
        pnl: 1,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "next",
        quantity: 2,
        openingCash: 16,
        openingFees: -3,
        pnl: 7,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "final",
        quantity: 2,
        openingCash: 16,
        openingFees: -4,
        pnl: 12,
        bookedMonth: "2026-09",
      },
    ]);
  });

  it("truncates debit cash and fees separately toward zero, consuming both final remainders", () => {
    const allocations = allocateRealizedTrades([
      trade("open", "open", 3, -10, -5),
      trade("first", "close", 1, 5, -1),
      trade("second", "exercise", 1, 5, -2),
      trade("third", "close", 1, 5, -3),
    ]);
    expect(allocations).toEqual([
      {
        tradeId: "first",
        quantity: 1,
        openingCash: -3,
        openingFees: -1,
        pnl: 0,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "second",
        quantity: 1,
        openingCash: -3,
        openingFees: -2,
        pnl: -2,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "third",
        quantity: 1,
        openingCash: -4,
        openingFees: -2,
        pnl: -4,
        bookedMonth: "2026-09",
      },
    ]);
    expect(allocations.reduce((sum, a) => sum + a.openingCash, 0)).toBe(-10);
    expect(allocations.reduce((sum, a) => sum + a.openingFees, 0)).toBe(-5);
    expect(allocations.reduce((sum, a) => sum + a.pnl, 0)).toBe(-6);
  });

  it("sorts chronologically, preserves same-day input order and starts a fresh pool after reopening", () => {
    const events = [
      trade("reopen", "open", 2, -9, -3, "2026-10-01"),
      trade("close-new", "close", 1, 7, -1, "2026-10-01"),
      trade("old", "open", 3, 10, -5, "2026-09-01"),
      trade("old-half", "close", 1, 0, 0, "2026-09-30"),
      trade("old-final", "expire", 2, 0, 0, "2026-09-30"),
    ];
    const before = structuredClone(events);
    expect(allocateRealizedTrades(events)).toEqual([
      {
        tradeId: "old-half",
        quantity: 1,
        openingCash: 3,
        openingFees: -1,
        pnl: 2,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "old-final",
        quantity: 2,
        openingCash: 7,
        openingFees: -4,
        pnl: 3,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "close-new",
        quantity: 1,
        openingCash: -4,
        openingFees: -1,
        pnl: 1,
        bookedMonth: "2026-10",
      },
    ]);
    expect(events).toEqual(before);
  });

  it("keeps exact truncated allocation when the intermediate product exceeds safe integers", () => {
    expect(
      allocateRealizedTrades([
        trade("open", "open", 3, 9_007_199_254_740_991, -3),
        trade("partial", "close", 2, 0),
        trade("last", "expire", 1, 0),
      ]),
    ).toEqual([
      {
        tradeId: "partial",
        quantity: 2,
        openingCash: 6_004_799_503_160_660,
        openingFees: -2,
        pnl: 6_004_799_503_160_658,
        bookedMonth: "2026-09",
      },
      {
        tradeId: "last",
        quantity: 1,
        openingCash: 3_002_399_751_580_331,
        openingFees: -1,
        pnl: 3_002_399_751_580_330,
        bookedMonth: "2026-09",
      },
    ]);
  });

  it.each([
    [trade("close", "close", 1, 0), trade("future", "open", 1, 1, 0, "2026-10-01")],
    [trade("close", "close", 1, 0), trade("same-day-future", "open", 1, 1)],
    [trade("open", "open", 2, 2), trade("close", "close", 3, 0)],
    [trade("open", "open", 1, 2), trade("close", "close", 1, 0), trade("extra", "close", 1, 0)],
  ])("rejects a close without sufficient preceding opens %#", (...events) => {
    expect(() => allocateRealizedTrades(events)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 9_007_199_254_740_992])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(() => allocateRealizedTrades([trade("bad", "open", quantity, 0)])).toThrow(RangeError);
      expect(() =>
        allocateRealizedTrades([trade("ok", "open", 2, 1), trade("bad", "close", quantity, 0)]),
      ).toThrow(RangeError);
    },
  );

  it.each([0.5, NaN, Infinity, 9_007_199_254_740_992])(
    "rejects unsafe/noninteger money %s on opens and closes",
    (amount) => {
      expect(() => allocateRealizedTrades([trade("bad", "open", 1, amount)])).toThrow(RangeError);
      expect(() => allocateRealizedTrades([trade("bad", "open", 1, 0, -amount)])).toThrow(
        RangeError,
      );
      expect(() =>
        allocateRealizedTrades([trade("ok", "open", 1, 0), trade("bad", "close", 1, amount)]),
      ).toThrow(RangeError);
      expect(() =>
        allocateRealizedTrades([trade("ok", "open", 1, 0), trade("bad", "close", 1, 0, -amount)]),
      ).toThrow(RangeError);
    },
  );

  it.each([
    [trade("a", "open", 1, 0, 1)],
    [trade("a", "open", 1, 0), trade("b", "close", 1, 0, 1)],
    [trade("a", "open", 9_007_199_254_740_991, 0), trade("b", "open", 1, 0)],
    [trade("a", "open", 1, 9_007_199_254_740_991), trade("b", "open", 1, 1)],
    [trade("a", "open", 1, 0, -9_007_199_254_740_991), trade("b", "open", 1, 0, -1)],
    [trade("a", "open", 1, 9_007_199_254_740_991), trade("b", "close", 1, 1)],
  ])("rejects positive fees and overflowing pool/result %#", (...events) => {
    expect(() => allocateRealizedTrades(events)).toThrow(RangeError);
  });

  it("emits no realized rows for an empty or still-open leg", () => {
    expect(allocateRealizedTrades([])).toEqual([]);
    expect(allocateRealizedTrades([trade("open", "open", 10, 15_000_000, -66_000)])).toEqual([]);
  });
});

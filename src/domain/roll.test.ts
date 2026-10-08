import { describe, expect, it } from "vitest";
import type { CampaignLeg, CampaignPosition, CampaignResponse, CampaignTrade } from "./campaign.ts";
import type { IsoDate } from "./dates.ts";
import { allocateRealizedTrades } from "./lifecyclePnl.ts";
import type { Money4 } from "./money.ts";
import { previewRoll, rollExpiryChips, rollMetrics } from "./roll.ts";

const m = (units: number) => units as Money4;
const d = (date: string) => date as IsoDate;
function trade(
  id: string,
  action: CampaignTrade["action"],
  quantity: number,
  cash: number,
  fees: number,
  tradeDate = "2026-09-24",
): CampaignTrade {
  return {
    id,
    action,
    quantity,
    cash: m(cash),
    fees: m(fees),
    tradeDate: d(tradeDate),
    price: m(0),
  };
}
function leg(
  id: string,
  side: CampaignLeg["side"],
  trades: CampaignTrade[],
  extra: Partial<CampaignLeg> = {},
): CampaignLeg {
  return {
    id,
    side,
    kind: "put",
    underlying: "TQQQ",
    strike: m(550_000),
    expiry: d("2026-10-23"),
    multiplier: 100,
    adjusted: false,
    mark: null,
    trades,
    ...extra,
  };
}
function position(
  id: string,
  legs: CampaignLeg[],
  rollChainId: string | null = null,
): CampaignPosition {
  return {
    id,
    legs,
    rollChainId,
    revision: "v1",
    underlying: "TQQQ",
    strategy: "csp",
    role: "income",
    openedOn: d("2026-09-24"),
    closedOn: null,
    notes: null,
    tags: [],
  };
}
function campaign(positions: CampaignPosition[]): CampaignResponse {
  return {
    id: "campaign",
    title: "Roll fixtures",
    positions,
    openedOn: d("2026-08-28"),
    closedOn: null,
    notes: null,
    asOf: d("2026-10-01"),
    assignments: [],
  };
}
function fill(legId: string, closePrice: number, openPrice: number, closeFees = 0, openFees = 0) {
  return {
    legId,
    closePrice: m(closePrice),
    openPrice: m(openPrice),
    closeFees: m(closeFees),
    openFees: m(openFees),
    strike: m(550_000),
  };
}
function input(positionId: string, fills: ReturnType<typeof fill>[]) {
  return { positionId, fills, tradeDate: d("2026-10-01"), expiry: d("2026-11-06") };
}

// T9's prior-leg $13.20 total is split equally between open and close. Current
// and proposed fills use T6's $0.65/contract default ($13.00 for twenty contracts).
function tqqq() {
  const prior = position(
    "prior",
    [
      leg(
        "58p",
        "short",
        [
          trade("prior-open", "open", 20, 34_000_000, -66_000, "2026-08-28"),
          trade("prior-close", "close", 20, -42_000_000, -66_000),
        ],
        { strike: m(580_000), expiry: d("2026-09-25") },
      ),
    ],
    "chain",
  );
  prior.openedOn = d("2026-08-28");
  prior.closedOn = d("2026-09-24");
  const current = position(
    "current",
    [leg("55p", "short", [trade("current-open", "open", 20, 49_000_000, -130_000)])],
    "chain",
  );
  const unrelated = position(
    "unrelated",
    [leg("other", "short", [trade("other-open", "open", 1, 9_000_000, -6_500)])],
    "other-chain",
  );
  return campaign([prior, current, unrelated]);
}

describe("rollMetrics", () => {
  it("matches allocated fees to closing trade IDs, not array order", () => {
    const realized = allocateRealizedTrades([
      { id: "open", action: "open", quantity: 3, cash: m(-10), fees: m(-5), date: d("2026-09-24") },
      { id: "first", action: "close", quantity: 1, cash: m(5), fees: m(-1), date: d("2026-10-01") },
      {
        id: "second",
        action: "close",
        quantity: 2,
        cash: m(10),
        fees: m(-3),
        date: d("2026-10-01"),
      },
    ]);
    expect(
      rollMetrics(
        realized,
        [
          { id: "second", cash: m(10), fees: m(-3) },
          { id: "first", cash: m(5), fees: m(-1) },
        ],
        [{ cash: m(-20), fees: m(-2) }],
        [
          { cash: m(-10), fees: m(-5) },
          { cash: m(15), fees: m(-4) },
          { cash: m(-20), fees: m(-2) },
        ],
      ),
    ).toEqual({
      realizedGross: 5,
      realizedNet: -4,
      rollCashGross: -5,
      rollCashNet: -11,
      chainCashGross: -15,
      chainCashNet: -26,
    });
  });

  it("reproduces the prior TQQQ realized loss with the plan's $13.20 fees", () => {
    const realized = allocateRealizedTrades([
      {
        id: "open",
        action: "open",
        quantity: 20,
        cash: m(34_000_000),
        fees: m(-66_000),
        date: d("2026-08-28"),
      },
      {
        id: "close",
        action: "close",
        quantity: 20,
        cash: m(-42_000_000),
        fees: m(-66_000),
        date: d("2026-09-24"),
      },
    ]);
    expect(
      rollMetrics(
        realized,
        [{ id: "close", cash: m(-42_000_000), fees: m(-66_000) }],
        [{ cash: m(49_000_000), fees: m(-130_000) }],
        [
          { cash: m(34_000_000), fees: m(-66_000) },
          { cash: m(-42_000_000), fees: m(-66_000) },
          { cash: m(49_000_000), fees: m(-130_000) },
        ],
      ),
    ).toEqual({
      realizedGross: -8_000_000,
      realizedNet: -8_132_000,
      rollCashGross: 7_000_000,
      rollCashNet: 6_804_000,
      chainCashGross: 41_000_000,
      chainCashNet: 40_738_000,
    });
  });

  it("rejects missing matching closes and duplicate close IDs", () => {
    const realized = [
      {
        tradeId: "close",
        quantity: 1,
        openingCash: m(10),
        openingFees: m(-1),
        pnl: m(7),
        bookedMonth: "2026-10",
      },
    ];
    expect(() =>
      rollMetrics(realized, [{ id: "foreign", cash: m(-1), fees: m(-1) }], [], []),
    ).toThrow(/Missing closing trade/);
    expect(() =>
      rollMetrics(
        realized,
        [
          { id: "close", cash: m(-1), fees: m(-1) },
          { id: "close", cash: m(-1), fees: m(-1) },
        ],
        [],
        [],
      ),
    ).toThrow(/Duplicate closing trade/);
  });

  it("returns six zero amounts for no events", () => {
    expect(rollMetrics([], [], [], [])).toEqual({
      realizedGross: 0,
      realizedNet: 0,
      rollCashGross: 0,
      rollCashNet: 0,
      chainCashGross: 0,
      chainCashNet: 0,
    });
  });

  it("fails on unsafe aggregate sums and positive fees", () => {
    expect(() =>
      rollMetrics(
        [],
        [],
        [],
        [
          { cash: m(9_007_199_254_740_991), fees: m(0) },
          { cash: m(1), fees: m(0) },
        ],
      ),
    ).toThrow(RangeError);
    expect(() => rollMetrics([], [], [{ cash: m(0), fees: m(1) }], [])).toThrow(/Fees/);
    expect(() => rollMetrics([], [], [], [{ cash: m(0.5), fees: m(0) }])).toThrow(/Unsafe cash/);
    expect(() => rollMetrics([], [], [], [{ cash: m(0), fees: m(-0.5) }])).toThrow(/Fees/);
  });
});

describe("previewRoll", () => {
  it("reproduces QQQ's two-leg hedge and excludes unrelated unchained positions", () => {
    // The literal per-leg decomposition preserves T9's $0.70/$0.42/$0.77 spread
    // prices. Fees are $1.30 per leg/event: two contracts at T6's $0.65 default.
    const hedge = position("qqq", [
      leg("long", "long", [trade("long-open", "open", 2, -2_000_000, -13_000)], {
        underlying: "QQQ",
        strike: m(6_700_000),
      }),
      leg("short", "short", [trade("short-open", "open", 2, 600_000, -13_000)], {
        underlying: "QQQ",
        strike: m(6_650_000),
      }),
    ]);
    hedge.underlying = "QQQ";
    hedge.strategy = "put_debit_spread";
    hedge.role = "hedge";
    const book = campaign([
      hedge,
      position("other", [leg("other", "short", [trade("other-open", "open", 2, 9_000_000, 0)])]),
    ]);
    const before = structuredClone(book);
    const request = input("qqq", [
      { ...fill("short", 3_800, 3_300, -13_000, -13_000), strike: m(6_650_000) },
      { ...fill("long", 8_000, 11_000, -13_000, -13_000), strike: m(6_700_000) },
    ]);
    const requestBefore = structuredClone(request);
    expect(previewRoll(book, request)).toEqual({
      realizedGross: -560_000,
      realizedNet: -612_000,
      rollCashGross: -700_000,
      rollCashNet: -752_000,
      chainCashGross: -2_100_000,
      chainCashNet: -2_178_000,
    });
    expect(book).toEqual(before);
    expect(request).toEqual(requestBefore);
  });

  it("uses the complete TQQQ chain but only the proposed close's realization", () => {
    expect(
      previewRoll(tqqq(), input("current", [fill("55p", 31_900, 35_400, -130_000, -130_000)])),
    ).toEqual({
      realizedGross: -14_800_000,
      realizedNet: -15_060_000,
      rollCashGross: 7_000_000,
      rollCashNet: 6_740_000,
      chainCashGross: 48_000_000,
      chainCashNet: 47_478_000,
    });
  });

  it("consumes the remaining allocator pool after partial closes and same-day interleaved opens", () => {
    const book = campaign([
      position("partial", [
        leg(
          "leg",
          "short",
          [
            trade("z-first", "open", 2, 10, -3),
            trade("y-second", "open", 1, 7, -2),
            trade("a-partial", "close", 1, -2, -1),
            trade("b-later", "open", 2, 20, -3),
          ],
          { multiplier: 1 },
        ),
      ]),
    ]);
    expect(previewRoll(book, input("partial", [fill("leg", 1, 2, -2, -3)]))).toEqual({
      realizedGross: 28,
      realizedNet: 19,
      rollCashGross: 4,
      rollCashNet: -1,
      chainCashGross: 39,
      chainCashNet: 25,
    });
  });

  it("excludes held CC stock cash from every chain position", () => {
    const book = campaign([
      position(
        "old",
        [
          leg(
            "old-call",
            "short",
            [
              trade("old-open", "open", 1, 1_000_000, -6_500),
              trade("old-close", "close", 1, -400_000, -6_500),
            ],
            { kind: "call" },
          ),
          leg("old-stock", "long", [trade("stock-open", "open", 100, -500_000_000, -1_000)], {
            kind: "stock",
            multiplier: 1,
            strike: null,
            expiry: null,
          }),
        ],
        "cc-chain",
      ),
      position(
        "cc",
        [
          leg("call", "short", [trade("call-open", "open", 1, 2_000_000, -6_500)], {
            kind: "call",
            coveredLegId: "stock",
          }),
          leg("stock", "long", [trade("stock-2-open", "open", 100, -600_000_000, -1_000)], {
            kind: "stock",
            multiplier: 1,
            strike: null,
            expiry: null,
          }),
        ],
        "cc-chain",
      ),
    ]);
    expect(previewRoll(book, input("cc", [fill("call", 10_000, 30_000, -6_500, -6_500)]))).toEqual({
      realizedGross: 1_000_000,
      realizedNet: 987_000,
      rollCashGross: 2_000_000,
      rollCashNet: 1_987_000,
      chainCashGross: 4_600_000,
      chainCashNet: 4_567_500,
    });
    expect(() =>
      previewRoll(book, input("cc", [fill("call", 10_000, 30_000), fill("stock", 1, 1)])),
    ).toThrow(/Foreign or closed option leg/);
  });

  it("includes every option leg of a multi-leg chain's history", () => {
    const book = campaign([
      position(
        "old",
        [
          leg("old-long", "long", [
            trade("ol-open", "open", 1, -1_000_000, 0),
            trade("ol-close", "close", 1, 500_000, 0),
          ]),
          leg("old-short", "short", [
            trade("os-open", "open", 1, 300_000, 0),
            trade("os-close", "close", 1, -100_000, 0),
          ]),
        ],
        "spread-chain",
      ),
      position(
        "new",
        [
          leg("long", "long", [trade("l-open", "open", 1, -1_100_000, 0)]),
          leg("short", "short", [trade("s-open", "open", 1, 400_000, 0)]),
        ],
        "spread-chain",
      ),
    ]);
    expect(
      previewRoll(book, input("new", [fill("long", 6_000, 12_000), fill("short", 2_000, 4_000)])),
    ).toEqual({
      realizedGross: -300_000,
      realizedNet: -300_000,
      rollCashGross: -400_000,
      rollCashNet: -400_000,
      chainCashGross: -1_400_000,
      chainCashNet: -1_400_000,
    });
  });

  it.each([
    ["missing position", input("missing", [fill("55p", 1, 1)]), /Position not found/],
    ["missing leg", input("current", []), /Every open option leg/],
    ["duplicate leg", input("current", [fill("55p", 1, 1), fill("55p", 1, 1)]), /Duplicate leg/],
    ["foreign leg", input("current", [fill("other", 1, 1)]), /Foreign or closed option leg/],
    ["positive close fees", input("current", [fill("55p", 1, 1, 1)]), /Fees/],
    ["positive open fees", input("current", [fill("55p", 1, 1, 0, 1)]), /Fees/],
    ["negative close price", input("current", [fill("55p", -1, 1)]), /Price/],
    ["negative open price", input("current", [fill("55p", 1, -1)]), /Price/],
    ["fractional price", input("current", [fill("55p", 0.5, 1)]), /Price/],
    ["cash storage overflow", input("current", [fill("55p", 999_999_999_999, 1)]), /Cash.*storage/],
    ["price storage overflow", input("current", [fill("55p", 1_000_000_000_000, 1)]), /Price/],
    ["fee storage overflow", input("current", [fill("55p", 1, 1, -100_000_000_000_000)]), /Fees/],
    [
      "nonpositive strike",
      { ...input("current", [fill("55p", 1, 1)]), fills: [{ ...fill("55p", 1, 1), strike: m(0) }] },
      /Strike/,
    ],
    [
      "expiry not later",
      { ...input("current", [fill("55p", 1, 1)]), expiry: d("2026-10-23") },
      /Expiry/,
    ],
    [
      "backdated close",
      { ...input("current", [fill("55p", 1, 1)]), tradeDate: d("2026-09-23") },
      /Trade date/,
    ],
  ] as const)("rejects %s", (_label, request, message) => {
    expect(() => previewRoll(tqqq(), request)).toThrow(message);
  });

  it("rejects a closed source and invalid contract units", () => {
    expect(() => previewRoll(tqqq(), input("prior", [fill("58p", 1, 1)]))).toThrow(
      /No open option quantity/,
    );
    const book = campaign([
      position("invalid", [
        leg("leg", "short", [trade("open", "open", 1, 1, 0)], { multiplier: 0 }),
      ]),
    ]);
    expect(() => previewRoll(book, input("invalid", [fill("leg", 1, 1)]))).toThrow(
      /Quantity or multiplier/,
    );
  });

  it("rejects a source with no option legs", () => {
    const book = campaign([
      position("stock", [
        leg("stock", "long", [trade("open", "open", 100, -10_000, 0)], {
          kind: "stock",
          multiplier: 1,
          strike: null,
          expiry: null,
        }),
      ]),
    ]);
    expect(() => previewRoll(book, input("stock", []))).toThrow(/No open option quantity/);
  });
});

describe("rollExpiryChips", () => {
  it("returns six expiries strictly after the current expiry", () => {
    expect(rollExpiryChips(d("2026-10-23"))).toEqual([
      { date: "2026-10-30", monthly: false },
      { date: "2026-11-06", monthly: false },
      { date: "2026-11-13", monthly: false },
      { date: "2026-11-20", monthly: true },
      { date: "2026-11-27", monthly: false },
      { date: "2026-12-04", monthly: false },
    ]);
  });
  it("uses the existing holiday adjustment and monthly marker", () => {
    expect(rollExpiryChips(d("2026-06-12"))).toEqual([
      { date: "2026-06-18", monthly: true },
      { date: "2026-06-26", monthly: false },
      { date: "2026-07-02", monthly: false },
      { date: "2026-07-10", monthly: false },
      { date: "2026-07-17", monthly: true },
      { date: "2026-07-24", monthly: false },
    ]);
  });
  it("propagates calendar horizon failures", () => {
    expect(() => rollExpiryChips(d("2029-01-02"))).toThrow(/NYSE calendar covers 2026-2028/);
  });
});

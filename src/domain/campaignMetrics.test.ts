import { describe, expect, it } from "vitest";
import type { CampaignLeg, CampaignResponse, CampaignTrade } from "./campaign.ts";
import { buildCampaignView, openLegQuantity } from "./campaignMetrics.ts";
import { parseIsoDate as d } from "./dates.ts";
import { formatMoney4, parseMoney4 as m } from "./money.ts";
import {
  aaplCampaign,
  crwdCampaign,
  dramAssignedCampaign,
  dramCampaign,
  nvdlCampaign,
} from "./test/campaignFixtures.ts";

function leg(c: CampaignResponse, position = 0, index = 0): CampaignLeg {
  const result = c.positions[position]?.legs[index];
  if (!result) throw new Error("Missing test leg");
  return result;
}

function closing(quantity: number, action: CampaignTrade["action"] = "close"): CampaignTrade {
  return {
    id: "closing",
    action,
    quantity,
    tradeDate: d("2026-10-01"),
    price: m("1"),
    cash: m("0"),
    fees: m("0"),
  };
}

function clone(c: CampaignResponse): CampaignResponse {
  return structuredClone(c);
}

function onlyHedge(): CampaignResponse {
  const c = clone(nvdlCampaign);
  c.positions = c.positions.slice(2);
  return c;
}

describe("buildCampaignView T3 fixtures", () => {
  it("builds every NVDL scenario number without changing the recorded campaign", () => {
    const campaign = clone(nvdlCampaign);
    const view = buildCampaignView(campaign);
    expect(view.csp).toMatchObject({
      premium: m("2350"),
      capital: m("72500"),
      hedgeDebit: m("218"),
      hedgePayout: m("1000"),
      noAssignment: { netProfit: m("2132"), term: 31 },
      assigned: {
        cash: m("3132"),
        shares: 1000,
        basisBeforeHedge: [m("72.20"), m("68.10")],
        hedgeCut: m("0.782"),
        effectiveBasis: [m("71.418"), m("67.318")],
      },
    });
    expect(view.csp?.noAssignment.periodYield).toBeCloseTo(0.029406896551724137, 12);
    expect(view.csp?.noAssignment.annualized).toBeCloseTo(0.3462424916573971, 12);
    expect(view.csp?.assigned.cashYield).toBeCloseTo(0.0432, 12);
    expect(view.csp && formatMoney4(view.csp.assigned.hedgeCut, 2)).toBe("0.78");
    expect(view.csp?.assigned.effectiveBasis.map((x) => formatMoney4(x, 2))).toEqual([
      "71.42",
      "67.32",
    ]);
    expect(view.hedges).toMatchObject([
      {
        positionId: "nvda-hedge",
        underlying: "NVDA",
        maxPayout: m("1000"),
        metrics: { debit: m("218"), maxProfit: m("782"), breakeven: m("178.91"), contracts: 2 },
      },
    ]);
    expect(view.timeline.map((e) => e.trade.id)).toEqual([
      "nvdl-75-open",
      "nvdl-70-open",
      "nvda-long-open",
      "nvda-short-open",
    ]);
    expect(campaign).toEqual(nvdlCampaign);
  });

  it("shows synthetic DRAM opening basis without inventing assignment events", () => {
    const view = buildCampaignView(dramCampaign);
    expect(view.coveredCalls).toEqual([
      {
        positionId: "dram-call",
        underlying: "DRAM",
        collateral: m("82500"),
        shares: 1500,
        basis: m("53"),
        basisSource: "opening",
        adjustedBasis: m("51.9"),
        premium: m("1650"),
        strike: m("55"),
        calledAwayGain: m("4650"),
      },
    ]);
    expect(view.timeline.map((e) => [e.trade.action, e.assignment])).toEqual([
      ["open", null],
      ["open", null],
    ]);
    expect(view.csp).toBe(null);
    expect(view.unsupportedPositionIds).toEqual([]);
  });

  it("links actual assignment to both trades and derives basis from the stock opening", () => {
    const view = buildCampaignView(dramAssignedCampaign);
    expect(view.coveredCalls).toMatchObject([
      {
        basis: m("53"),
        basisSource: "assignment",
        adjustedBasis: m("51.9"),
        calledAwayGain: m("4650"),
      },
    ]);
    expect(view.csp).toBe(null);
    expect(view.timeline.map((e) => [e.trade.id, e.assignment?.id ?? null])).toEqual([
      ["dram-put-open", null],
      ["dram-put-assign", "dram-assignment"],
      ["dram-assigned-stock-open", "dram-assignment"],
      ["dram-assigned-call-open", null],
    ]);
  });

  it("computes AAPL -270 and CRWD +805 from their marks and actual multipliers", () => {
    expect(buildCampaignView(aaplCampaign).swings).toEqual([
      {
        positionId: "aapl-call",
        legId: "aapl-call-leg",
        underlying: "AAPL",
        kind: "call",
        quantity: 1,
        entry: m("7.80"),
        mark: leg(aaplCampaign).mark,
        unrealized: m("-270"),
      },
    ]);
    expect(buildCampaignView(crwdCampaign).swings).toEqual([
      {
        positionId: "crwd-stock",
        legId: "crwd-stock-leg",
        underlying: "CRWD",
        kind: "stock",
        quantity: 50,
        entry: m("455.20"),
        mark: leg(crwdCampaign).mark,
        unrealized: m("805"),
      },
    ]);
  });
});

describe("open balances and basis", () => {
  it("exports current leg quantity for capital formulas", () => {
    const c = clone(aaplCampaign);
    leg(c).trades.push({ ...closing(3), action: "open" }, closing(2));
    expect(openLegQuantity(leg(c))).toBe(2);
    expect(openLegQuantity(leg(nvdlCampaign))).toBe(5);
  });

  it("uses weighted opening fills and excludes closing prices from entry", () => {
    const c = clone(aaplCampaign);
    leg(c).trades.push(
      {
        id: "second-fill",
        action: "open",
        quantity: 3,
        tradeDate: d("2026-09-11"),
        price: m("6.20"),
        cash: m("-1860"),
        fees: m("-1"),
      },
      closing(2),
    );
    expect(buildCampaignView(c).swings).toMatchObject([
      { quantity: 2, entry: m("6.60"), unrealized: m("-300") },
    ]);
  });

  it("preserves exact opening cash when weighted entry requires Money4 rounding", () => {
    const c = clone(aaplCampaign);
    leg(c).trades.push({
      id: "mixed-opening-fill",
      action: "open",
      quantity: 2,
      tradeDate: d("2026-09-11"),
      price: m("1.09"),
      cash: m("-218"),
      fees: m("0"),
    });
    expect(buildCampaignView(c).swings).toMatchObject([
      { quantity: 3, entry: m("3.3267"), unrealized: m("532") },
    ]);
    leg(c).trades.push(closing(1));
    expect(buildCampaignView(c).swings).toMatchObject([
      { quantity: 2, entry: m("3.3267"), unrealized: m("354.6667") },
    ]);
  });

  it("supports nonstandard option multipliers in CSP, spread and swing math", () => {
    const c = clone(nvdlCampaign);
    for (const p of c.positions) for (const l of p.legs) l.multiplier = 10;
    expect(buildCampaignView(c).csp).toMatchObject({
      premium: m("235"),
      capital: m("7250"),
      hedgeDebit: m("21.8"),
      hedgePayout: m("100"),
      assigned: { shares: 100, hedgeCut: m("0.782") },
    });
    expect(buildCampaignView(c).hedges).toMatchObject([
      { metrics: { contracts: 2, debit: m("21.8") } },
    ]);
    const a = clone(aaplCampaign);
    leg(a).multiplier = 10;
    expect(buildCampaignView(a).swings).toMatchObject([{ unrealized: m("-27") }]);
  });

  it("sizes CSP scenarios from remaining balances rather than original cash", () => {
    const c = clone(nvdlCampaign);
    c.positions = c.positions.slice(0, 1);
    leg(c).trades.push(closing(3));
    expect(buildCampaignView(c).csp).toMatchObject({
      premium: m("560"),
      capital: m("15000"),
      hedgeDebit: m("0"),
      assigned: { shares: 200, effectiveBasis: [m("72.20")] },
    });
  });

  it.each(["close", "expire", "assign", "exercise"] as const)(
    "keeps exhausted %s legs timeline-only",
    (action) => {
      const c = clone(aaplCampaign);
      leg(c).trades.push(closing(1, action));
      expect(buildCampaignView(c)).toMatchObject({
        swings: [],
        hedges: [],
        csp: null,
        unsupportedPositionIds: [],
        timeline: [{ trade: { action: "open" } }, { trade: { action } }],
      });
    },
  );

  it("ignores closed positions even when legacy balances remain, and empty legs", () => {
    const c = clone(nvdlCampaign);
    for (const p of c.positions) p.closedOn = d("2026-10-01");
    expect(buildCampaignView(c)).toMatchObject({
      csp: null,
      hedges: [],
      timeline: [
        { trade: { id: "nvdl-75-open" } },
        { trade: { id: "nvdl-70-open" } },
        { trade: { id: "nvda-long-open" } },
        { trade: { id: "nvda-short-open" } },
      ],
    });
    const empty = clone(aaplCampaign);
    leg(empty).trades = [];
    expect(buildCampaignView(empty)).toEqual({
      csp: null,
      coveredCalls: [],
      hedges: [],
      swings: [],
      timeline: [],
      unsupportedPositionIds: [],
    });
  });

  it("returns null unrealized when there is no mark", () => {
    const c = clone(crwdCampaign);
    leg(c).mark = null;
    expect(buildCampaignView(c).swings).toMatchObject([
      { entry: m("455.20"), unrealized: null, mark: null },
    ]);
  });

  it("leaves a CC unsupported after a partial stock close removes full backing", () => {
    const c = clone(dramCampaign);
    const close = { ...closing(50), id: "dram-stock-close", price: m("53"), cash: m("2650") };
    leg(c).trades.push(close);
    const recorded = clone(c);
    const view = buildCampaignView(c);
    expect(openLegQuantity(leg(c))).toBe(1450);
    expect(view.coveredCalls).toEqual([]);
    expect(view.unsupportedPositionIds).toEqual(["dram-call"]);
    expect(view.swings).toMatchObject([{ positionId: "dram-stock", quantity: 1450 }]);
    expect(view.timeline.map((e) => [e.legId, e.trade])).toEqual([
      ["dram-stock-leg", leg(dramCampaign).trades[0]],
      ["dram-call-leg", leg(dramCampaign, 1).trades[0]],
      ["dram-stock-leg", close],
    ]);
    expect(c).toEqual(recorded);
  });

  it("does not guess legacy backing across multiple stock legs", () => {
    const c = clone(dramCampaign);
    leg(c).trades.push({ ...closing(50), price: m("53"), cash: m("2650") });
    const extraStock = clone(dramCampaign).positions[0];
    if (!extraStock) throw new Error("Missing stock fixture");
    extraStock.id = "dram-extra-stock";
    extraStock.legs = [
      {
        ...leg(dramCampaign),
        id: "dram-extra-stock-leg",
        trades: [
          {
            id: "dram-extra-stock-open",
            action: "open",
            quantity: 50,
            tradeDate: d("2026-10-01"),
            price: m("53"),
            cash: m("-2650"),
            fees: m("0"),
          },
        ],
      },
    ];
    c.positions.push(extraStock);
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
    leg(c, 2).trades.push({ ...closing(1), price: m("53"), cash: m("53") });
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
  });

  it("checks backing against remaining calls with their actual multiplier", () => {
    const c = clone(dramCampaign);
    leg(c, 1).trades.push(closing(5));
    leg(c, 1).multiplier = 50;
    leg(c).trades.push({ ...closing(1000), price: m("53"), cash: m("53000") });
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [{ shares: 500, basis: m("53"), premium: m("550"), calledAwayGain: m("1550") }],
      unsupportedPositionIds: [],
    });
    leg(c).trades.push({ ...closing(1), id: "stock-close-one", price: m("53"), cash: m("53") });
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
  });

  it("does not treat standard share backing as sufficient for a larger call multiplier", () => {
    const c = clone(dramCampaign);
    leg(c, 1).multiplier = 200;
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
  });

  it("uses partial CC premium and its real multiplier", () => {
    const c = clone(dramCampaign);
    leg(c, 1).trades.push(closing(5));
    leg(c, 1).multiplier = 50;
    expect(buildCampaignView(c).coveredCalls).toMatchObject([
      {
        shares: 500,
        collateral: m("27500"),
        premium: m("550"),
        adjustedBasis: m("52.6333"),
        calledAwayGain: m("1550"),
      },
    ]);
  });

  it("aggregates stock opening basis across campaign positions, matching the underlying", () => {
    const c = clone(dramAssignedCampaign);
    const stock = clone(crwdCampaign).positions[0];
    if (!stock) throw new Error("Missing stock fixture");
    c.positions.push(stock);
    leg(c, 1).trades.push({
      id: "extra-stock",
      action: "open",
      quantity: 500,
      tradeDate: d("2026-08-01"),
      price: m("57"),
      cash: m("-28500"),
      fees: m("0"),
    });
    expect(buildCampaignView(c).coveredCalls).toMatchObject([
      {
        basis: m("54"),
        adjustedBasis: m("53.175"),
        basisSource: "assignment",
        calledAwayGain: m("3150"),
      },
    ]);
  });

  it("adjusts stock basis for all open calls but never historical premiums", () => {
    const c = clone(dramCampaign);
    const historical = clone(dramCampaign).positions[1];
    const another = clone(dramCampaign).positions[1];
    if (!historical || !another) throw new Error("Missing call fixture");
    historical.id = "closed-call";
    historical.closedOn = d("2026-09-19");
    another.id = "another-call";
    another.legs[0] = {
      ...leg(c, 1),
      trades: [
        {
          ...(leg(c, 1).trades[0] as CampaignTrade),
          id: "another-open",
          quantity: 5,
          price: m("0.90"),
          cash: m("450"),
        },
      ],
    };
    c.positions.push(historical, another);
    expect(buildCampaignView(c).coveredCalls).toMatchObject([
      { adjustedBasis: m("51.60"), premium: m("1650") },
      { adjustedBasis: m("51.60"), premium: m("450") },
    ]);
  });

  it("retains per-leg DTO ordering on tied dates after chronological sort", () => {
    const c = clone(aaplCampaign);
    leg(c).trades.push({ ...closing(1), id: "z-close", tradeDate: d("2026-09-10") });
    c.positions.push(...clone(crwdCampaign).positions);
    leg(c, 1).trades[0] = { ...(leg(c, 1).trades[0] as CampaignTrade), tradeDate: d("2026-09-01") };
    expect(buildCampaignView(c).timeline.map((e) => e.trade.id)).toEqual([
      "crwd-stock-open",
      "aapl-call-open",
      "z-close",
    ]);
  });
});

describe("explicit covered leg and residual capital", () => {
  it("references the exact assigned leg despite another same-underlying stock basis", () => {
    const c = clone(dramAssignedCampaign);
    leg(c, 2).coveredLegId = "dram-assigned-stock-leg";
    const extra = clone(dramCampaign).positions[0];
    if (!extra) throw new Error("Missing stock fixture");
    extra.id = "other-stock";
    extra.legs[0] = {
      ...leg(dramCampaign),
      id: "other-stock-leg",
      trades: [
        {
          ...(leg(dramCampaign).trades[0] as CampaignTrade),
          id: "other-open",
          price: m("60"),
          cash: m("-90000"),
        },
      ],
    };
    c.positions.push(extra);
    const view = buildCampaignView(c);
    expect(view.coveredCalls).toMatchObject([
      { basis: 530000, adjustedBasis: 519000, collateral: 825000000 },
    ]);
    expect(view.swings).toMatchObject([
      { legId: "other-stock-leg", quantity: 1500, entry: 600000 },
    ]);
    expect(view.swings).toHaveLength(1);
  });

  it("does not duplicate assigned coverage; a partial call close releases500 shares at cash55 and wheel53", () => {
    const c = clone(dramAssignedCampaign);
    leg(c, 2).coveredLegId = "dram-assigned-stock-leg";
    expect(buildCampaignView(c).swings).toEqual([]);
    leg(c, 2).trades.push(closing(5));
    leg(c, 1).mark = { asOf: d("2026-10-01"), source: "manual", price: m("57") };
    expect(buildCampaignView(c).swings).toMatchObject([
      {
        legId: "dram-assigned-stock-leg",
        quantity: 500,
        entry: 550000,
        assignmentBasis: 530000,
        unrealized: 10000000,
      },
    ]);
  });

  it("held calls use only local stock and expose500 residual shares at53", () => {
    const c = clone(dramCampaign);
    const stock = c.positions[0];
    const call = c.positions[1];
    if (!stock || !call) throw new Error("Missing held fixture");
    call.legs.unshift(...stock.legs);
    c.positions = [call];
    leg(c, 0, 1).coveredLegId = null;
    leg(c, 0, 1).trades.push(closing(5));
    leg(c).mark = { asOf: d("2026-10-01"), source: "manual", price: m("55") };
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [{ shares: 1000, basis: 530000, collateral: 550000000 }],
      swings: [
        {
          positionId: "dram-call",
          legId: "dram-stock-leg",
          quantity: 500,
          entry: 530000,
          unrealized: 10000000,
        },
      ],
    });
  });

  it("explicit null or missing referenced backing cannot borrow a matching campaign stock", () => {
    const c = clone(dramCampaign);
    leg(c, 1).coveredLegId = null;
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
    leg(c, 1).coveredLegId = "missing-stock";
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
  });
});

describe("lifecycle stock display", () => {
  it.each(["close", "expire"] as const)(
    "shows held-cover shares after a seeded CC option %s",
    (action) => {
      const c = clone(dramCampaign);
      const stock = c.positions[0];
      const call = c.positions[1];
      if (!stock || !call) throw new Error("Missing DRAM cover fixture");
      // The seed keeps share cover and the call in the same income position.
      call.legs.unshift(...stock.legs);
      c.positions = [call];
      leg(c, 0, 1).trades.push(closing(15, action));
      leg(c).mark = { asOf: d("2026-10-01"), source: "manual", price: m("55") };
      expect(buildCampaignView(c)).toMatchObject({
        coveredCalls: [],
        unsupportedPositionIds: [],
        swings: [
          {
            positionId: "dram-call",
            legId: "dram-stock-leg",
            quantity: 1500,
            entry: 530_000,
            unrealized: 30_000_000,
          },
        ],
      });
      leg(c).trades.push({
        ...closing(500),
        id: "stock-partial",
        price: m("55"),
        cash: m("27500"),
      });
      expect(buildCampaignView(c).swings).toMatchObject([
        { quantity: 1000, entry: 530_000, unrealized: 20_000_000 },
      ]);
    },
  );

  it("shows assigned stock basis separately without crediting premium twice in unrealized P/L", () => {
    const c = clone(dramAssignedCampaign);
    c.positions = c.positions.slice(0, 2);
    leg(c, 1).mark = { asOf: d("2026-10-01"), source: "manual", price: m("55") };
    expect(buildCampaignView(c).swings).toMatchObject([
      {
        entry: 550_000,
        assignmentBasis: 530_000,
        quantity: 1500,
        unrealized: 0,
      },
    ]);
    leg(c, 1).trades.push({
      ...closing(500),
      id: "stock-partial",
      price: m("55"),
      cash: m("27500"),
    });
    expect(buildCampaignView(c).swings).toMatchObject([
      {
        entry: 550_000,
        assignmentBasis: 530_000,
        quantity: 1000,
        unrealized: 0,
      },
    ]);
    leg(c, 1).mark = { asOf: d("2026-10-01"), source: "manual", price: m("57") };
    expect(buildCampaignView(c).swings).toMatchObject([
      { entry: 550_000, assignmentBasis: 530_000, unrealized: 20_000_000 },
    ]);
  });

  it("omits assignmentBasis from ordinary stock and long option swings", () => {
    expect(buildCampaignView(crwdCampaign).swings[0]).not.toHaveProperty("assignmentBasis");
    expect(buildCampaignView(aaplCampaign).swings[0]).not.toHaveProperty("assignmentBasis");
  });
});

describe("hedges and safe unsupported records", () => {
  it("builds a standalone hedge even without CSP puts", () => {
    expect(buildCampaignView(onlyHedge())).toMatchObject({
      csp: null,
      hedges: [{ maxPayout: m("1000"), metrics: { debit: m("218"), maxProfit: m("782") } }],
    });
  });

  it("supports call debit spreads and ignores swing debit spreads for scenario hedges", () => {
    const c = onlyHedge();
    const p = c.positions[0];
    if (!p) throw new Error("Missing hedge fixture");
    p.strategy = "call_debit_spread";
    leg(c).kind = "call";
    leg(c).strike = m("175");
    leg(c, 0, 1).kind = "call";
    leg(c, 0, 1).strike = m("180");
    expect(buildCampaignView(c).hedges).toMatchObject([
      { maxPayout: m("1000"), metrics: { breakeven: m("176.09") } },
    ]);
    p.role = "swing";
    expect(buildCampaignView(c)).toMatchObject({
      hedges: [],
      swings: [],
      unsupportedPositionIds: ["nvda-hedge"],
    });
  });

  it.each(["long_call", "long_put"] as const)(
    "shows %s hedge metrics and finite or unlimited payout",
    (strategy) => {
      const c = clone(aaplCampaign);
      const p = c.positions[0];
      if (!p) throw new Error("Missing option fixture");
      p.strategy = strategy;
      p.role = "hedge";
      leg(c).kind = strategy === "long_call" ? "call" : "put";
      expect(buildCampaignView(c).hedges).toMatchObject([
        {
          maxPayout: strategy === "long_call" ? null : m("25000"),
          metrics: {
            debit: m("780"),
            maxProfit: strategy === "long_call" ? "unlimited" : m("24220"),
          },
        },
      ]);
      expect(buildCampaignView(c).swings).toEqual([]);
    },
  );

  it("supports swing long puts", () => {
    const c = clone(aaplCampaign);
    const p = c.positions[0];
    if (!p) throw new Error("Missing option fixture");
    p.strategy = "long_put";
    leg(c).kind = "put";
    expect(buildCampaignView(c).swings).toMatchObject([{ kind: "put", unrealized: m("-270") }]);
  });

  it.each(["put_credit_spread", "call_credit_spread", "day_trade"] as const)(
    "leaves %s recorded, without guessed metrics",
    (strategy) => {
      const c = onlyHedge();
      const p = c.positions[0];
      if (!p) throw new Error("Missing hedge fixture");
      p.strategy = strategy;
      expect(buildCampaignView(c)).toMatchObject({
        hedges: [],
        csp: null,
        swings: [],
        unsupportedPositionIds: ["nvda-hedge"],
        timeline: [{ trade: { id: "nvda-long-open" } }, { trade: { id: "nvda-short-open" } }],
      });
    },
  );

  it("does not calculate an uncovered call or a short stock swing", () => {
    const c = clone(dramCampaign);
    c.positions = c.positions.slice(1);
    expect(buildCampaignView(c)).toMatchObject({
      coveredCalls: [],
      unsupportedPositionIds: ["dram-call"],
    });
    const s = clone(crwdCampaign);
    leg(s).side = "short";
    expect(buildCampaignView(s)).toMatchObject({
      swings: [],
      unsupportedPositionIds: ["crwd-stock"],
    });
  });

  it("does not guess spread math for asymmetric remaining units or invalid option legs", () => {
    const c = onlyHedge();
    leg(c, 0, 1).trades.push(closing(1));
    expect(buildCampaignView(c)).toMatchObject({
      hedges: [],
      unsupportedPositionIds: ["nvda-hedge"],
    });
    const missing = clone(aaplCampaign);
    leg(missing).strike = null;
    expect(buildCampaignView(missing)).toMatchObject({
      swings: [],
      unsupportedPositionIds: ["aapl-call"],
    });
  });
});

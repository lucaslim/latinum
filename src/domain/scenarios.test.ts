import { describe, expect, it } from "vitest";
import { formatMoney4 } from "./money.ts";
import type { CashSecuredPut } from "./positions.ts";
import { cspScenarios } from "./scenarios.ts";
import { csp, m, putDebitSpread } from "./test/fixtures.ts";

const nvdlPuts: [CashSecuredPut, ...CashSecuredPut[]] = [
  csp("NVDL", "75", "2026-10-16", 5, "2.80", "2026-09-15"),
  csp("NVDL", "70", "2026-10-16", 5, "1.90", "2026-09-15"),
];
const nvdaHedge = putDebitSpread("NVDA", "180", "175", "2026-10-16", 2, "1.09", "2026-09-15");

describe("NVDL breakdown", () => {
  const s = cspScenarios({ puts: nvdlPuts, hedges: [nvdaHedge] });

  it("no assignment: net +2,132, 2.94% for the period, 34.6% annualized over 31 days", () => {
    expect(s.premium).toBe(m("2350"));
    expect(s.capital).toBe(m("72500"));
    expect(s.hedgeDebit).toBe(m("218"));
    expect(s.hedgePayout).toBe(m("1000"));
    expect(s.noAssignment.netProfit).toBe(m("2132"));
    expect(s.noAssignment.periodYield).toBeCloseTo(0.029406896551724137, 12);
    expect((s.noAssignment.periodYield * 100).toFixed(2)).toBe("2.94");
    expect(s.noAssignment.term).toBe(31);
    expect(s.noAssignment.annualized).toBeCloseTo(0.3462424916573971, 12);
    expect((s.noAssignment.annualized * 100).toFixed(1)).toBe("34.6");
  });

  it("assigned plus hedge: cash 3,132 is 4.32% on 1,000 shares bought for 72,500", () => {
    expect(s.assigned.cash).toBe(m("3132"));
    expect(s.assigned.cashYield).toBeCloseTo(0.0432, 12);
    expect(s.assigned.shares).toBe(1000);
  });

  it("basis 72.20 / 68.10; hedge cut is 0.78/sh, not the sample's 0.86; effective 71.42 / 67.32", () => {
    expect(s.assigned.basisBeforeHedge).toEqual([m("72.20"), m("68.10")]);
    expect(s.assigned.hedgeCut).toBe(m("0.782"));
    expect(formatMoney4(s.assigned.hedgeCut, 2)).toBe("0.78");
    expect(formatMoney4(s.assigned.hedgeCut, 2)).not.toBe("0.86");
    expect(s.assigned.effectiveBasis).toEqual([m("71.418"), m("67.318")]);
    expect(s.assigned.effectiveBasis.map((b) => formatMoney4(b, 2))).toEqual(["71.42", "67.32"]);
  });
});

describe("no hedge", () => {
  it("cash is the premium and the basis is not cut", () => {
    const s = cspScenarios({ puts: nvdlPuts, hedges: [] });
    expect(s.noAssignment.netProfit).toBe(m("2350"));
    expect(s.assigned.cash).toBe(m("2350"));
    expect(s.assigned.hedgeCut).toBe(0);
    expect(s.assigned.effectiveBasis).toEqual([m("72.20"), m("68.10")]);
  });
});

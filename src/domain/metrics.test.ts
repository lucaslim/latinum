import { describe, expect, it } from "vitest";
import { formatMoney4 } from "./money.ts";
import {
  annualize,
  annualizeByDte,
  type DebitSpread,
  positionMetrics,
  spreadMaxPayout,
} from "./positions.ts";
import { cc, csp, d, longCall, m, putDebitSpread, stock } from "./test/fixtures.ts";

const pct1 = (x: number) => (x * 100).toFixed(1);

describe("Discord rows", () => {
  it("AVGX 4,135 / 67,500 = 6.1%", () => {
    const x = positionMetrics(csp("AVGX", "45", "2026-09-18", 15, "2.7567", "2026-09-01"));
    expect(x.premium).toBe(m("4135.05")); // the screenshot rounds to whole dollars
    expect(formatMoney4(x.premium, 0)).toBe("4135");
    expect(x.collateral).toBe(m("67500"));
    expect(pct1(x.yield)).toBe("6.1");
    expect(x.contracts).toBe(15);
  });

  it("MRVL 900 / 40,000 = 2.2%", () => {
    const x = positionMetrics(csp("MRVL", "200", "2026-09-25", 2, "4.50", "2026-09-01"));
    expect(x.premium).toBe(m("900"));
    expect(x.collateral).toBe(m("40000"));
    // exactly 2.25%: a tie, which the sample shows as 2.2 (round half to even); no formatter here
    expect(x.yield).toBeCloseTo(0.0225, 12);
  });

  it("MUU 1,500 / 25,000 = 6.0%", () => {
    const x = positionMetrics(csp("MUU", "25", "2026-10-09", 10, "1.50", "2026-09-01"));
    expect(x.premium).toBe(m("1500"));
    expect(x.collateral).toBe(m("25000"));
    expect(pct1(x.yield)).toBe("6.0");
  });

  it("SPY 730/725 x1 debit 52 gives collateral 52 'risk', role hedge", () => {
    const p = putDebitSpread("SPY", "730", "725", "2026-10-09", 1, "0.52", "2026-09-01");
    const x = positionMetrics(p);
    expect(p.role).toBe("hedge");
    expect(x.debit).toBe(m("52"));
    expect(x.collateral).toBe(m("52"));
    expect(x.maxLoss).toBe(m("52"));
  });
});

describe("Covered rows", () => {
  it("MRVL 220C x2 = 44,000 at 5.9%", () => {
    const x = positionMetrics(cc("MRVL", "220", "2026-08-21", 2, "13.00", "2026-07-20", "200.00"));
    expect(x.premium).toBe(m("2600"));
    expect(x.collateral).toBe(m("44000"));
    expect(pct1(x.yield)).toBe("5.9");
  });

  it("DRAM 55C x15 = 82,500 at 7.5%", () => {
    const x = positionMetrics(cc("DRAM", "55", "2026-08-28", 15, "4.10", "2026-07-20", "53.00"));
    expect(x.premium).toBe(m("6150"));
    expect(x.collateral).toBe(m("82500"));
    expect(pct1(x.yield)).toBe("7.5");
  });

  it("TSMG 36C x10 = 36,000 at 10.8%", () => {
    const x = positionMetrics(cc("TSMG", "36", "2026-08-21", 10, "3.90", "2026-07-20", "30.00"));
    expect(x.premium).toBe(m("3900"));
    expect(x.collateral).toBe(m("36000"));
    expect(pct1(x.yield)).toBe("10.8");
  });

  it("TQQQ 60/55 put spread x3, debit 468: payout 1,500, profit 1,032, return on risk 220.5%", () => {
    const p = putDebitSpread("TQQQ", "60", "55", "2026-08-28", 3, "1.56", "2026-07-20");
    const x = positionMetrics(p);
    expect(x.debit).toBe(m("468"));
    expect(spreadMaxPayout(p)).toBe(m("1500"));
    expect(x.maxProfit).toBe(m("1032"));
    expect(x.maxLoss).toBe(m("468"));
    expect(x.collateral).toBe(m("468"));
    expect(x.returnOnRisk === null ? null : pct1(x.returnOnRisk)).toBe("220.5");
    expect(x.breakeven).toBe(m("58.44"));
  });
});

describe("CSP rows", () => {
  it("NVDL 26.67 x15 = 40,005, flagged adjusted", () => {
    const x = positionMetrics(csp("NVDL", "26.67", "2026-07-31", 15, "0.80", "2026-07-01", true));
    expect(x.collateral).toBe(m("40005"));
    expect(x.adjusted).toBe(true);
    expect(pct1(x.yield)).toBe("3.0");
  });

  it("a standard contract is not flagged", () => {
    const x = positionMetrics(csp("DRAM", "50", "2026-08-07", 10, "2.00", "2026-07-01"));
    expect(x.adjusted).toBe(false);
  });

  it("breakeven is strike less credit; max profit is the premium; max loss is collateral less premium", () => {
    const x = positionMetrics(csp("NVDL", "75", "2026-10-16", 5, "2.80", "2026-09-15"));
    expect(x.breakeven).toBe(m("72.20"));
    expect(x.maxProfit).toBe(m("1400"));
    expect(x.maxLoss).toBe(m("36100"));
  });
});

describe("covered call extras", () => {
  it("breakeven is basis less credit; max profit includes the share gain; max loss is basis less credit to zero", () => {
    const x = positionMetrics(cc("DRAM", "55", "2026-10-16", 15, "1.10", "2026-09-18", "53.00"));
    expect(x.breakeven).toBe(m("51.90"));
    expect(x.maxProfit).toBe(m("4650"));
    expect(x.maxLoss).toBe(m("77850"));
    const mrvl = positionMetrics(
      cc("MRVL", "210", "2026-10-23", 2, "4.75", "2026-09-25", "196.40"),
    );
    expect(mrvl.breakeven).toBe(m("191.65"));
  });
});

describe("annualized", () => {
  it("D5 a: yield x 365 / term (NVDL 75P, 31-day term)", () => {
    const x = positionMetrics(csp("NVDL", "75", "2026-10-16", 5, "2.80", "2026-09-15"));
    expect(x.term).toBe(31);
    expect(x.annualized).toBeCloseTo((1400 / 37500) * (365 / 31), 12);
  });

  it("D5 a on the prototype DRAM 50P: 14-day term gives 96.5%", () => {
    const x = positionMetrics(csp("DRAM", "50", "2026-10-09", 10, "1.85", "2026-09-25"));
    expect(x.term).toBe(14);
    expect(x.annualized).toBeCloseTo(0.964642857142857, 12);
  });

  it("D5 b: yield x 365 / DTE left, for the Stats toggle", () => {
    const x = positionMetrics(csp("DRAM", "50", "2026-10-09", 10, "1.85", "2026-09-25"));
    expect(annualizeByDte(x.yield, 8)).toBeCloseTo(0.037 * (365 / 8), 12);
    // pipeline sample: Jul 17, 10,153 / 236,800 = 4.29%, 8 DTE left -> 196%
    expect(Math.round(annualizeByDte(10153 / 236800, 8) * 100)).toBe(196);
  });

  it("annualize and annualizeByDte throw below one day", () => {
    expect(() => annualize(0.03, 0)).toThrow(RangeError);
    expect(() => annualizeByDte(0.03, 0)).toThrow(RangeError);
  });

  it("an income position opened on its expiry day throws instead of dividing by zero", () => {
    expect(() => positionMetrics(csp("DRAM", "50", "2026-10-09", 1, "1", "2026-10-09"))).toThrow(
      RangeError,
    );
  });
});

describe("other strategies", () => {
  it("put credit spread: collateral is width less credit; breakeven is short strike less credit", () => {
    const x = positionMetrics({
      strategy: "put_credit_spread",
      role: "income",
      underlying: "SPY",
      shortStrike: m("60"),
      longStrike: m("55"),
      price: m("1.50"),
      qty: 3,
      openedOn: d("2026-09-01"),
      expiry: d("2026-09-18"),
      adjusted: false,
    });
    expect(x.premium).toBe(m("450"));
    expect(x.collateral).toBe(m("1050"));
    expect(x.breakeven).toBe(m("58.50"));
    expect(x.maxProfit).toBe(m("450"));
    expect(x.maxLoss).toBe(m("1050"));
  });

  it("call credit spread: breakeven is short strike plus credit", () => {
    const x = positionMetrics({
      strategy: "call_credit_spread",
      role: "income",
      underlying: "SPY",
      shortStrike: m("100"),
      longStrike: m("105"),
      price: m("1.20"),
      qty: 1,
      openedOn: d("2026-09-01"),
      expiry: d("2026-09-18"),
      adjusted: false,
    });
    expect(x.collateral).toBe(m("380"));
    expect(x.breakeven).toBe(m("101.20"));
  });

  it("call debit spread: breakeven is long strike plus debit", () => {
    const p: DebitSpread = {
      strategy: "call_debit_spread",
      role: "swing",
      underlying: "SPY",
      longStrike: m("100"),
      shortStrike: m("105"),
      price: m("2.00"),
      qty: 1,
      openedOn: d("2026-09-01"),
      expiry: d("2026-09-18"),
      adjusted: false,
    };
    const x = positionMetrics(p);
    expect(spreadMaxPayout(p)).toBe(m("500"));
    expect(x.maxProfit).toBe(m("300"));
    expect(x.breakeven).toBe(m("102"));
    expect(x.returnOnRisk).toBeCloseTo(1.5, 12);
  });

  it("put debit spread breakeven is the high strike less debit (QQQ 670/665)", () => {
    const x = positionMetrics(
      putDebitSpread("QQQ", "670", "665", "2026-10-30", 2, "0.70", "2026-09-22"),
    );
    expect(x.breakeven).toBe(m("669.30"));
    expect(x.maxProfit).toBe(m("860"));
  });

  it("long call: debit is the risk, breakeven strike plus debit, profit unlimited", () => {
    const x = positionMetrics(longCall("AAPL", "250", "2026-11-20", 1, "7.80", "2026-09-10"));
    expect(x.debit).toBe(m("780"));
    expect(x.collateral).toBe(m("780"));
    expect(x.breakeven).toBe(m("257.80"));
    expect(x.maxProfit).toBe("unlimited");
    expect(x.returnOnRisk).toBeNull();
    expect(x.maxLoss).toBe(m("780"));
  });

  it("long put: profit is strike value less debit, breakeven strike less debit", () => {
    const x = positionMetrics({
      strategy: "long_put",
      role: "hedge",
      underlying: "SPY",
      strike: m("50"),
      price: m("2.00"),
      qty: 1,
      openedOn: d("2026-09-01"),
      expiry: d("2026-09-18"),
      adjusted: false,
    });
    expect(x.maxProfit).toBe(m("4800"));
    expect(x.breakeven).toBe(m("48"));
    expect(x.returnOnRisk).toBeCloseTo(24, 12);
  });

  it("stock: collateral is shares x entry and it carries no contracts", () => {
    const x = positionMetrics(stock("CRWD", 50, "455.20", "2026-09-21"));
    expect(x).toEqual({ kind: "stock", contracts: 0, collateral: m("22760") });
  });
});

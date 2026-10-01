import { describe, expect, it } from "vitest";
import { formatMoney4 } from "./money.ts";
import { m } from "./test/fixtures.ts";
import { adjustedBasis, assignedShareBasis, calledAwayGain } from "./wheel.ts";

describe("wheel", () => {
  it("DRAM put 55 with 2.00 premium gives basis 53.00", () => {
    expect(assignedShareBasis(m("55"), m("2.00"))).toBe(m("53.00"));
  });

  it("NVDL breakdown: 75 - 2.80 = 72.20", () => {
    expect(assignedShareBasis(m("75"), m("2.80"))).toBe(m("72.20"));
  });

  it("after the 55C at 1.10, adjusted basis is 51.90", () => {
    expect(adjustedBasis(m("53.00"), [m("1.10")])).toBe(m("51.90"));
    expect(formatMoney4(adjustedBasis(m("53.00"), [m("1.10")]), 2)).toBe("51.90");
  });

  it("adjusted basis subtracts every call premium and is unchanged with none", () => {
    expect(adjustedBasis(m("53.00"), [m("1.10"), m("0.90")])).toBe(m("51.00"));
    expect(adjustedBasis(m("53.00"), [])).toBe(m("53.00"));
  });

  it("called-away gain is (55 - 53) x 1,500 + 1,650 = 4,650", () => {
    expect(
      calledAwayGain({ strike: m("55"), basis: m("53.00"), shares: 1500, callPremium: m("1650") }),
    ).toBe(m("4650"));
  });
});

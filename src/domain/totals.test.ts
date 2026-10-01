import { describe, expect, it } from "vitest";
import { formatMoney4 } from "./money.ts";
import { coveredBook, cspBook, discordBook, m, prototypeBook } from "./test/fixtures.ts";
import { bookTotals } from "./totals.ts";

const pct2 = (x: number | null) => (x === null ? null : (x * 100).toFixed(2));

describe("book totals", () => {
  it("Discord: 82 contracts, 14,455 premium, 421,000 income collateral, 3.43%, hedge risk 192", () => {
    const t = bookTotals(discordBook);
    expect(t.contracts).toBe(82);
    // AVGX 4,135 is 4,135.05 at 4 decimals (see fixtures); the sample shows whole dollars
    expect(formatMoney4(t.premium, 0)).toBe("14455");
    expect(t.incomeCollateral).toBe(m("421000"));
    expect(pct2(t.yield)).toBe("3.43");
    expect(t.hedgeCost).toBe(m("192"));
    expect(t.swingCapital).toBe(0);
  });

  it("Covered: 77 contracts, 25,633 premium, 404,500 income collateral, 6.34%, capital deployed 404,968", () => {
    const t = bookTotals(coveredBook);
    expect(t.contracts).toBe(77);
    expect(t.premium).toBe(m("25633"));
    expect(t.incomeCollateral).toBe(m("404500"));
    expect(pct2(t.yield)).toBe("6.34");
    expect(t.capitalDeployed).toBe(m("404968"));
  });

  it("CSP: 82 contracts, 15,250 premium, 414,505 collateral, 3.68%", () => {
    const t = bookTotals(cspBook);
    expect(t.contracts).toBe(82);
    expect(t.premium).toBe(m("15250"));
    expect(t.incomeCollateral).toBe(m("414505"));
    expect(pct2(t.yield)).toBe("3.68");
    expect(t.hedgeCost).toBe(0);
  });

  it("prototype book: 77 contracts, 14,450 premium, 434,500 collateral, 3.33%, annualized 47.4%", () => {
    const t = bookTotals(prototypeBook);
    expect(t.contracts).toBe(77);
    expect(t.premium).toBe(m("14450"));
    expect(t.incomeCollateral).toBe(m("434500"));
    expect(t.yield).toBeCloseTo(0.033256616800920596, 12);
    expect(pct2(t.yield)).toBe("3.33");
    expect(t.annualized).toBeCloseTo(0.4737957055687023, 12);
    expect(((t.annualized ?? 0) * 100).toFixed(1)).toBe("47.4");
    expect(t.hedgeCost).toBe(m("358"));
    expect(t.swingCapital).toBe(m("23540"));
    expect(t.capitalDeployed).toBe(m("458398"));
  });

  it("a book with no income rows has no blended yield", () => {
    const t = bookTotals(discordBook.filter((p) => p.role === "hedge"));
    expect(t.contracts).toBe(3);
    expect(t.premium).toBe(0);
    expect(t.yield).toBeNull();
    expect(t.annualized).toBeNull();
    expect(t.capitalDeployed).toBe(m("192"));
  });
});

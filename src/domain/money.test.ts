import { describe, expect, it } from "vitest";
import {
  addMoney4,
  divMoney4,
  formatMoney4,
  mulMoney4,
  negMoney4,
  parseMoney4,
  ratio,
  subMoney4,
  sumMoney4,
} from "./money.ts";
import { m } from "./test/fixtures.ts";

describe("parseMoney4", () => {
  it.each([
    ["1.0850", 10850],
    ["26.67", 266700],
    ["-0.6527", -6527],
    ["1.09", 10900],
    ["55", 550000],
    ["0", 0],
  ])("parses %s to %d", (input, expected) => {
    expect(parseMoney4(input)).toBe(expected);
  });

  it.each(["", "abc", "1.23456", "1,000.00", "1.", ".5", "--1", " 1.00"])("rejects %j", (input) => {
    expect(() => parseMoney4(input)).toThrow(RangeError);
  });
});

describe("parseMoney4 range", () => {
  it("rejects an amount beyond Number.MAX_SAFE_INTEGER of 1/10,000 USD", () => {
    expect(() => parseMoney4("900719925474.1")).toThrow(RangeError);
  });

  it("normalizes negative zero", () => {
    expect(parseMoney4("-0.0000")).toBe(0);
  });
});

describe("formatMoney4", () => {
  it("formats at four decimals by default", () => {
    expect(formatMoney4(m("218"))).toBe("218.0000");
    expect(formatMoney4(m("-0.6527"))).toBe("-0.6527");
    expect(formatMoney4(m("1.085"))).toBe("1.0850");
  });

  it("rounds half away from zero at cents and whole dollars", () => {
    expect(formatMoney4(m("71.418"), 2)).toBe("71.42");
    expect(formatMoney4(m("0.782"), 2)).toBe("0.78");
    expect(formatMoney4(m("1.005"), 2)).toBe("1.01");
    expect(formatMoney4(m("-1.005"), 2)).toBe("-1.01");
    expect(formatMoney4(m("14455.05"), 0)).toBe("14455");
    expect(formatMoney4(m("0.5"), 0)).toBe("1");
  });

  it("does not print a negative zero", () => {
    expect(formatMoney4(m("-0.001"), 2)).toBe("0.00");
  });
});

describe("arithmetic", () => {
  it("float guard: 1.09 x 100 x 2 sums to exactly 218.0000", () => {
    // the prototype's float math gives 218.00000000000003
    const debit = mulMoney4(mulMoney4(m("1.09"), 100), 2);
    expect(formatMoney4(sumMoney4([debit]))).toBe("218.0000");
    expect(debit).toBe(m("218"));
  });

  it("adds, subtracts and negates exactly", () => {
    expect(addMoney4(m("0.1"), m("0.2"))).toBe(m("0.3"));
    expect(subMoney4(m("2350"), m("218"))).toBe(m("2132"));
    expect(negMoney4(m("1.5"))).toBe(m("-1.5"));
  });

  it("sums a list and an empty list", () => {
    expect(sumMoney4([m("1500"), m("-6.60")])).toBe(m("1493.40"));
    expect(sumMoney4([])).toBe(0);
  });

  it("divides rounding half away from zero to 1/10,000", () => {
    expect(divMoney4(m("782"), 1000)).toBe(m("0.782"));
    expect(divMoney4(m("0.0001"), 2)).toBe(m("0.0001"));
    expect(divMoney4(m("-0.0001"), 2)).toBe(m("-0.0001"));
    expect(divMoney4(m("1"), 3)).toBe(m("0.3333"));
  });

  it("takes a ratio as a plain number", () => {
    expect(ratio(m("4135"), m("67500"))).toBeCloseTo(0.0613, 4);
  });

  it("throws on a zero denominator", () => {
    expect(() => ratio(m("1"), m("0"))).toThrow(RangeError);
    expect(() => divMoney4(m("1"), 0)).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import {
  businessDte,
  isEarlyClose,
  isTradingDay,
  lastTradingDayOnOrBefore,
  tradingDaysBetween,
} from "./calendar.ts";
import { d } from "./test/fixtures.ts";

describe("isTradingDay", () => {
  it.each([
    ["2026-04-03", "Good Friday"],
    ["2026-09-07", "Labor Day"],
    ["2026-11-26", "Thanksgiving"],
    ["2026-12-25", "Christmas 2026"],
    ["2026-07-03", "Independence Day observed 2026"],
    ["2027-12-24", "Christmas observed 2027"],
    ["2028-07-04", "Independence Day 2028"],
    ["2026-10-03", "a Saturday"],
    ["2026-10-04", "a Sunday"],
  ])("%s is closed (%s)", (date) => {
    expect(isTradingDay(d(date))).toBe(false);
  });

  it.each(["2026-10-01", "2026-10-12", "2026-11-27", "2026-12-24", "2028-07-03"])(
    "%s is open",
    (date) => {
      expect(isTradingDay(d(date))).toBe(true);
    },
  );

  it("throws once queried past the last year of the table", () => {
    expect(() => isTradingDay(d("2029-01-02"))).toThrow(RangeError);
  });

  it("throws before the first year of the table", () => {
    expect(() => isTradingDay(d("2025-12-31"))).toThrow(RangeError);
  });
});

describe("isEarlyClose", () => {
  it.each(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"])(
    "%s is an early close",
    (date) => {
      expect(isEarlyClose(d(date))).toBe(true);
    },
  );

  it("is false on a full day and on a holiday", () => {
    expect(isEarlyClose(d("2026-11-25"))).toBe(false);
    expect(isEarlyClose(d("2026-11-26"))).toBe(false);
  });

  it("throws past the table", () => {
    expect(() => isEarlyClose(d("2029-01-02"))).toThrow(RangeError);
  });
});

describe("business-day DTE", () => {
  it("2026-10-01 to 2026-10-16 is 11", () => {
    expect(businessDte(d("2026-10-16"), d("2026-10-01"))).toBe(11);
  });

  it("2026-11-20 to 2026-11-27 is 4: Thanksgiving closed, the early close counts", () => {
    expect(tradingDaysBetween(d("2026-11-20"), d("2026-11-27"))).toBe(4);
  });

  it("is 0 when expiry is not after today", () => {
    expect(businessDte(d("2026-10-01"), d("2026-10-01"))).toBe(0);
    expect(businessDte(d("2026-09-30"), d("2026-10-01"))).toBe(0);
  });

  it("throws when the range runs past the table", () => {
    expect(() => tradingDaysBetween(d("2028-12-28"), d("2029-01-03"))).toThrow(RangeError);
  });
});

describe("lastTradingDayOnOrBefore", () => {
  it("Friday chip for the week of Good Friday 2026-04-03 shows Thu 2026-04-02", () => {
    expect(lastTradingDayOnOrBefore(d("2026-04-03"))).toBe("2026-04-02");
  });

  it("keeps an ordinary Friday", () => {
    expect(lastTradingDayOnOrBefore(d("2026-04-10"))).toBe("2026-04-10");
  });

  it("walks back over a weekend and a holiday", () => {
    expect(lastTradingDayOnOrBefore(d("2026-09-07"))).toBe("2026-09-04");
  });
});

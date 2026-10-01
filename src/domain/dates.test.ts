import { describe, expect, it } from "vitest";
import { dte, parseIsoDate, term, todayNY } from "./dates.ts";
import { d } from "./test/fixtures.ts";

describe("parseIsoDate", () => {
  it("accepts a real calendar date", () => {
    expect(parseIsoDate("2026-10-01")).toBe("2026-10-01");
    expect(parseIsoDate("2028-02-29")).toBe("2028-02-29");
  });

  it.each([
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-1-1",
    "20261001",
    "",
    "2026-10-01T00:00",
  ])("rejects %j", (input) => {
    expect(() => parseIsoDate(input)).toThrow(RangeError);
  });
});

describe("todayNY", () => {
  it("uses the New York calendar date, not UTC", () => {
    expect(todayNY(new Date("2026-10-02T03:30:00Z"))).toBe("2026-10-01");
    expect(todayNY(new Date("2026-10-02T04:00:00Z"))).toBe("2026-10-02");
  });

  it("DST end: 2026-11-02T04:30:00Z is still 2026-11-01 in New York", () => {
    expect(todayNY(new Date("2026-11-02T04:30:00Z"))).toBe("2026-11-01");
    expect(todayNY(new Date("2026-11-02T05:30:00Z"))).toBe("2026-11-02");
  });

  it("DST start: the offset moves from -5 to -4 on 2026-03-08", () => {
    expect(todayNY(new Date("2026-03-08T04:59:00Z"))).toBe("2026-03-07");
    expect(todayNY(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(todayNY(new Date("2026-03-09T03:59:00Z"))).toBe("2026-03-08");
    expect(todayNY(new Date("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
  });
});

describe("dte and term", () => {
  it("Discord: Sep 18 as of Sep 10 is 8", () => {
    expect(dte(d("2026-09-18"), d("2026-09-10"))).toBe(8);
  });

  it("Covered: Aug 7 as of Jul 31 is 7", () => {
    expect(dte(d("2026-08-07"), d("2026-07-31"))).toBe(7);
  });

  it("DTE from todayNY at 2026-10-02T03:30:00Z to 2026-10-16 is 15", () => {
    expect(dte(d("2026-10-16"), todayNY(new Date("2026-10-02T03:30:00Z")))).toBe(15);
  });

  it("counts calendar days across DST changes and is negative once expired", () => {
    expect(dte(d("2026-11-03"), d("2026-10-30"))).toBe(4);
    expect(dte(d("2026-03-10"), d("2026-03-06"))).toBe(4);
    expect(dte(d("2026-10-01"), d("2026-10-03"))).toBe(-2);
  });

  it("NVDL term: open 2026-09-15 to expiry 2026-10-16 is 31", () => {
    expect(term(d("2026-09-15"), d("2026-10-16"))).toBe(31);
  });
});

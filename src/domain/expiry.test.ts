import { expect, it } from "vitest";
import { parseIsoDate } from "./dates.ts";
import { expiryChips } from "./expiry.ts";

it("returns seven future Fridays with the nominal monthly marked", () => {
  expect(expiryChips(parseIsoDate("2026-09-25"))).toEqual([
    { date: "2026-10-02", monthly: false },
    { date: "2026-10-09", monthly: false },
    { date: "2026-10-16", monthly: true },
    { date: "2026-10-23", monthly: false },
    { date: "2026-10-30", monthly: false },
    { date: "2026-11-06", monthly: false },
    { date: "2026-11-13", monthly: false },
  ]);
});

it("moves Good Friday to April 2 without falsely marking it monthly", () => {
  expect(expiryChips(parseIsoDate("2026-03-27"))).toEqual([
    { date: "2026-04-02", monthly: false },
    { date: "2026-04-10", monthly: false },
    { date: "2026-04-17", monthly: true },
    { date: "2026-04-24", monthly: false },
    { date: "2026-05-01", monthly: false },
    { date: "2026-05-08", monthly: false },
    { date: "2026-05-15", monthly: true },
  ]);
});

it("keeps the monthly marker when the third Friday itself is a holiday", () => {
  expect(expiryChips(parseIsoDate("2026-06-12"))).toEqual([
    { date: "2026-06-18", monthly: true },
    { date: "2026-06-26", monthly: false },
    { date: "2026-07-02", monthly: false },
    { date: "2026-07-10", monthly: false },
    { date: "2026-07-17", monthly: true },
    { date: "2026-07-24", monthly: false },
    { date: "2026-07-31", monthly: false },
  ]);
});

it.each(["2026-04-02", "2026-04-03", "2026-04-04"])(
  "excludes an adjusted expiry at or before %s",
  (asOf) => {
    expect(expiryChips(parseIsoDate(asOf))).toEqual([
      { date: "2026-04-10", monthly: false },
      { date: "2026-04-17", monthly: true },
      { date: "2026-04-24", monthly: false },
      { date: "2026-05-01", monthly: false },
      { date: "2026-05-08", monthly: false },
      { date: "2026-05-15", monthly: true },
      { date: "2026-05-22", monthly: false },
    ]);
  },
);

it("crosses the year in UTC and adjusts New Year's Day", () => {
  expect(expiryChips(parseIsoDate("2026-12-24"))).toEqual([
    { date: "2026-12-31", monthly: false },
    { date: "2027-01-08", monthly: false },
    { date: "2027-01-15", monthly: true },
    { date: "2027-01-22", monthly: false },
    { date: "2027-01-29", monthly: false },
    { date: "2027-02-05", monthly: false },
    { date: "2027-02-12", monthly: false },
  ]);
});

it.each(["2025-12-31", "2029-01-02", "2028-12-01"])(
  "fails loudly for uncovered dates or insufficient calendar horizon: %s",
  (asOf) => {
    expect(() => expiryChips(parseIsoDate(asOf))).toThrow(/NYSE calendar covers 2026-2028/);
  },
);

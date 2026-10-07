import { describe, expect, it } from "vitest";
import { filterPositions, type OpenPosition, sortByExpiry } from "./sheet.ts";
import { prototypeBook } from "./test/fixtures.ts";

const book: OpenPosition[] = prototypeBook.map((p, i) => ({
  ...p,
  id: `p${i}`,
  campaignId: `c${i}`,
}));
const tickers = (positions: readonly OpenPosition[]) => positions.map((p) => p.underlying);

describe("Sheet filters", () => {
  it("All keeps every row", () => {
    expect(filterPositions(book, "all")).toHaveLength(12);
  });

  it("Income, Hedges and Swings follow the position role", () => {
    expect(tickers(filterPositions(book, "income"))).toEqual([
      "DRAM",
      "AVGX",
      "NVDL",
      "NVDL",
      "DRAM",
      "TQQQ",
      "MRVL",
      "GGLL",
    ]);
    expect(tickers(filterPositions(book, "hedges"))).toEqual(["NVDA", "QQQ"]);
    expect(tickers(filterPositions(book, "swings"))).toEqual(["AAPL", "CRWD"]);
  });
});

describe("Sheet order", () => {
  it("sorts by expiry, keeps input order within an expiry, and puts stock last", () => {
    const sorted = sortByExpiry([...book].reverse());

    expect(sorted.map((p) => p.id)).toEqual([
      ...["p0", "p5", "p4", "p3", "p2", "p1", "p7", "p6"],
      ...["p9", "p8", "p10", "p11"],
    ]);
  });
});

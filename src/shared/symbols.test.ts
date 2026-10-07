import { expect, it } from "vitest";
import { tagSuggestions, tickerSuggestions } from "./symbols.ts";

it("puts matching own tickers first, uppercases and deduplicates both sources", () => {
  expect(tickerSuggestions(" aapl ", ["aapl", "AAPL", "DRAM"])).toEqual(["AAPL"]);
  expect(tickerSuggestions(" aa ", ["AAXX", "AAPL", "aaxx"])).toEqual([
    "AAXX",
    "AAPL",
    "AA",
    "AAL",
    "AAP",
  ]);
});
it("works without owned tickers and without a query", () => {
  expect(tickerSuggestions("MSFT", [])).toEqual(["MSFT"]);
  const all = tickerSuggestions("", ["DRAM", "AAPL", "DRAM"]);
  expect(all.slice(0, 2)).toEqual(["DRAM", "AAPL"]);
  expect(all.length).toBeGreaterThan(250);
  expect(new Set(all).size).toBe(all.length);
});
it("does prefix matching rather than contains and leaves unmatched symbols empty", () => {
  expect(tickerSuggestions("ZNOTASYMBOL", ["DRAM"])).toEqual([]);
  expect(tickerSuggestions("RAM", ["DRAM"])).toEqual([]);
});
it("keeps tag spelling and order, matching prefixes case insensitively", () => {
  expect(tagSuggestions(" wh ", ["Wheel", "wheel", "Weekly", "Wheel", "wheelhouse"])).toEqual([
    "Wheel",
    "wheel",
    "wheelhouse",
  ]);
  expect(tagSuggestions("", ["income", "wheel", "income"])).toEqual(["income", "wheel"]);
  expect(tagSuggestions("hed", ["income", "wheel"])).toEqual([]);
});

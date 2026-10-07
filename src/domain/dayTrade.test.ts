import { expect, it } from "vitest";
import { parseIsoDate } from "./dates.ts";
import { parseMoney4 } from "./money.ts";
import { positionMetrics, type StockPosition } from "./positions.ts";
import { bookTotals } from "./totals.ts";

it("values a day-trade long-stock entry without adding option contracts", () => {
  const trade = {
    strategy: "day_trade",
    role: "swing",
    underlying: "CRWD",
    openedOn: parseIsoDate("2026-09-25"),
    shares: 50,
    price: parseMoney4("455.20"),
  } as StockPosition;
  expect(positionMetrics(trade)).toEqual({ kind: "stock", contracts: 0, collateral: 227600000 });
  expect(bookTotals([trade])).toMatchObject({
    contracts: 0,
    swingCapital: 227600000,
    capitalDeployed: 227600000,
  });
});

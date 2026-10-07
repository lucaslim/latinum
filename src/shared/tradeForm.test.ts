import { describe, expect, it } from "vitest";
import { parseIsoDate } from "../domain/dates.ts";
import type { Money4 } from "../domain/money.ts";
import { type AssignedStockOption, createPositionSchema } from "./trade.ts";
import { defaultFee, previewTrade, requestToPosition } from "./tradeForm.ts";

const csp = {
  strategy: "csp",
  underlying: "DRAM",
  openedOn: "2026-09-25",
  expiry: "2026-10-09",
  quantity: 10,
  strike: "50",
  price: "1.85",
  fees: "6.50",
  adjusted: false,
  tags: ["wheel"],
};
const cc = {
  ...csp,
  strategy: "cc",
  strike: "55",
  price: "1.10",
  quantity: 15,
  cover: { kind: "held", basis: "53.00" },
};
const stockLegId = "11111111-1111-4111-8111-111111111111";
const assigned: AssignedStockOption = {
  legId: stockLegId,
  underlying: "DRAM",
  uncoveredShares: 1500,
  basis: 530000 as Money4,
  assignedOn: parseIsoDate("2026-09-18"),
};
const assignedCall = { ...cc, cover: { kind: "assigned", stockLegId } };
const common = {
  underlying: "SPY",
  openedOn: "2026-09-01",
  expiry: "2026-09-18",
  quantity: 1,
  adjusted: true,
  tags: [],
};

it("previews the literal T6 DRAM fixture through domain metrics", () => {
  const result = previewTrade(csp, []);
  expect(result).toMatchObject({
    success: true,
    costBasis: 481500,
    position: { strategy: "csp", role: "income", price: 18500, strike: 500000, qty: 10 },
    metrics: {
      kind: "income",
      contracts: 10,
      term: 14,
      premium: 18500000,
      collateral: 500000000,
      yield: 0.037,
      breakeven: 481500,
      maxProfit: 18500000,
      maxLoss: 481500000,
      adjusted: false,
    },
  });
  if (!result.success || result.metrics.kind !== "income") throw new Error("Expected income");
  expect(result.metrics.annualized).toBeCloseTo(0.964642857142857, 12);
  expect(result.input).toMatchObject({ price: "1.85" });
  expect(result.position.openedOn).toBe("2026-09-25");
});

it.each([cc, assignedCall])("uses held or assigned covered-call basis, not strike", (input) => {
  expect(previewTrade(input, [assigned])).toMatchObject({
    success: true,
    costBasis: 519000,
    position: { strategy: "cc", basis: 530000, qty: 15 },
    metrics: {
      kind: "income",
      premium: 16500000,
      collateral: 825000000,
      breakeven: 519000,
      maxProfit: 46500000,
      maxLoss: 778500000,
    },
  });
});

it("rejects unsafe metrics after resolving the actual assigned basis", () => {
  expect(previewTrade(assignedCall, [{ ...assigned, basis: 9007199254740991 as Money4 }])).toEqual({
    success: false,
    errors: ["Amount exceeds Money4 precision"],
  });
});

it("requires an explicit basis for assigned calls in the request adapter", () => {
  const input = createPositionSchema.parse(assignedCall);
  expect(() => requestToPosition(input)).toThrow("Assigned covered call requires a share basis");
  expect(requestToPosition(input, 530000 as Money4)).toMatchObject({ basis: 530000 });
});

it.each([
  { label: "missing", stocks: [] },
  { label: "wrong ticker", stocks: [{ ...assigned, underlying: "SPY" }] },
  { label: "insufficient shares", stocks: [{ ...assigned, uncoveredShares: 1499 }] },
  { label: "future assignment", stocks: [{ ...assigned, assignedOn: parseIsoDate("2026-09-26") }] },
])("clears assigned CC preview for $label", ({ stocks }) => {
  const result = previewTrade(assignedCall, stocks);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected failure");
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result).not.toHaveProperty("metrics");
});

const strategies = [
  {
    strategy: "put_credit_spread",
    input: {
      ...common,
      strategy: "put_credit_spread",
      quantity: 3,
      short: { strike: "60", price: "2", fees: "1.95" },
      long: { strike: "55", price: "0.50", fees: "1.95" },
    },
    position: { price: 15000, shortStrike: 600000, longStrike: 550000, role: "income" },
    metrics: {
      kind: "income",
      premium: 4500000,
      collateral: 10500000,
      breakeven: 585000,
      maxProfit: 4500000,
      maxLoss: 10500000,
    },
  },
  {
    strategy: "call_credit_spread",
    input: {
      ...common,
      strategy: "call_credit_spread",
      short: { strike: "100", price: "2", fees: "0.65" },
      long: { strike: "105", price: "0.80", fees: "0.65" },
    },
    position: { price: 12000, shortStrike: 1000000, longStrike: 1050000, role: "income" },
    metrics: {
      kind: "income",
      premium: 1200000,
      collateral: 3800000,
      breakeven: 1012000,
      maxProfit: 1200000,
      maxLoss: 3800000,
    },
  },
  {
    strategy: "put_debit_spread",
    input: {
      ...common,
      strategy: "put_debit_spread",
      quantity: 3,
      role: "hedge",
      long: { strike: "60", price: "2", fees: "1.95" },
      short: { strike: "55", price: "0.44", fees: "1.95" },
    },
    position: { price: 15600, longStrike: 600000, shortStrike: 550000, role: "hedge" },
    metrics: {
      kind: "debit",
      debit: 4680000,
      collateral: 4680000,
      breakeven: 584400,
      maxProfit: 10320000,
      maxLoss: 4680000,
      returnOnRisk: 2.2051282051282053,
    },
  },
  {
    strategy: "call_debit_spread",
    input: {
      ...common,
      strategy: "call_debit_spread",
      role: "swing",
      long: { strike: "100", price: "3", fees: "0.65" },
      short: { strike: "105", price: "1", fees: "0.65" },
    },
    position: { price: 20000, longStrike: 1000000, shortStrike: 1050000, role: "swing" },
    metrics: {
      kind: "debit",
      debit: 2000000,
      collateral: 2000000,
      breakeven: 1020000,
      maxProfit: 3000000,
      maxLoss: 2000000,
      returnOnRisk: 1.5,
    },
  },
  {
    strategy: "long_call",
    input: {
      ...common,
      strategy: "long_call",
      underlying: "AAPL",
      role: "swing",
      strike: "250",
      price: "7.80",
      fees: "0.65",
    },
    position: { price: 78000, strike: 2500000, role: "swing" },
    metrics: {
      kind: "debit",
      debit: 7800000,
      collateral: 7800000,
      breakeven: 2578000,
      maxProfit: "unlimited",
      maxLoss: 7800000,
      returnOnRisk: null,
    },
  },
  {
    strategy: "long_put",
    input: {
      ...common,
      strategy: "long_put",
      role: "hedge",
      strike: "50",
      price: "2",
      fees: "0.65",
    },
    position: { price: 20000, strike: 500000, role: "hedge" },
    metrics: {
      kind: "debit",
      debit: 2000000,
      collateral: 2000000,
      breakeven: 480000,
      maxProfit: 48000000,
      maxLoss: 2000000,
      returnOnRisk: 24,
    },
  },
];

it.each(strategies)(
  "adapts $strategy and feeds all metrics to the preview",
  ({ input, position, metrics }) => {
    expect(previewTrade(input, [])).toMatchObject({
      success: true,
      position,
      metrics: { ...metrics, adjusted: true, term: 17 },
      costBasis: null,
    });
  },
);

it.each(["stock", "day_trade"])(
  "previews %s as long stock with a distinct strategy",
  (strategy) => {
    expect(
      previewTrade(
        {
          strategy,
          underlying: "CRWD",
          openedOn: "2026-09-21",
          shares: 50,
          price: "455.20",
          fees: "0",
          tags: [],
        },
        [],
      ),
    ).toMatchObject({
      success: true,
      costBasis: null,
      position: { strategy, role: "swing", shares: 50, price: 4552000 },
      metrics: { kind: "stock", contracts: 0, collateral: 227600000 },
    });
  },
);

it("recomputes when price, quantity or fees are edited without retaining old metrics", () => {
  expect(previewTrade({ ...csp, price: "2.00" }, [])).toMatchObject({
    success: true,
    costBasis: 480000,
    metrics: { premium: 20000000, breakeven: 480000 },
  });
  expect(previewTrade({ ...csp, quantity: 15 }, [])).toMatchObject({
    success: true,
    metrics: { premium: 27750000, collateral: 750000000 },
  });
  expect(previewTrade({ ...csp, fees: "9.90" }, [])).toMatchObject({
    success: true,
    input: { fees: "9.90" },
    metrics: { premium: 18500000 },
  });
});

it.each([
  undefined,
  { ...csp, price: "" },
  { ...csp, price: "1.23456" },
  { ...csp, price: "50" },
  { ...csp, quantity: 0 },
  { ...csp, fees: "-0.65" },
  { ...csp, openedOn: "2026-02-30" },
  { ...csp, expiry: "2026-09-25" },
  { ...strategies[0]?.input, short: { strike: "54", price: "2", fees: "0.65" } },
  { ...strategies[0]?.input, short: { strike: "60", price: "6", fees: "0.65" } },
])("returns only errors for invalid raw input %#", (raw) => {
  expect(previewTrade(csp, []).success).toBe(true);
  const result = previewTrade(raw, []);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected failure");
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result).not.toHaveProperty("position");
  expect(result).not.toHaveProperty("metrics");
});

describe("default fees", () => {
  it.each([
    [0, 0],
    [1, 6500],
    [10, 65000],
    [15, 97500],
  ])("defaults %i contracts to literal Money4 %i", (qty, expected) => {
    expect(defaultFee(qty)).toBe(expected);
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "rejects invalid quantity %s loudly",
    (quantity) => {
      expect(() => defaultFee(quantity)).toThrow(RangeError);
    },
  );
});

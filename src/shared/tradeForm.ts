import { type Money4, mulMoney4, parseMoney4, subMoney4 } from "../domain/money.ts";
import { type Metrics, type Position, positionMetrics } from "../domain/positions.ts";
import { assignedShareBasis } from "../domain/wheel.ts";
import {
  type AssignedStockOption,
  type CreatePositionRequest,
  createPositionSchema,
} from "./trade.ts";

export type TradePreview =
  | {
      success: true;
      input: CreatePositionRequest;
      position: Position;
      metrics: Metrics;
      costBasis: Money4 | null;
    }
  | { success: false; errors: string[] };

export function requestToPosition(input: CreatePositionRequest, assignedBasis?: Money4): Position {
  const common = { underlying: input.underlying, openedOn: input.openedOn };
  if (input.strategy === "stock" || input.strategy === "day_trade") {
    return {
      ...common,
      strategy: input.strategy,
      role: "swing",
      shares: input.shares,
      price: parseMoney4(input.price),
    };
  }
  const option = {
    ...common,
    qty: input.quantity,
    expiry: input.expiry,
    adjusted: input.adjusted,
  };
  switch (input.strategy) {
    case "csp":
      return {
        ...option,
        strategy: input.strategy,
        role: "income",
        strike: parseMoney4(input.strike),
        price: parseMoney4(input.price),
      };
    case "cc": {
      const basis = input.cover.kind === "held" ? parseMoney4(input.cover.basis) : assignedBasis;
      if (basis === undefined) throw new RangeError("Assigned covered call requires a share basis");
      return {
        ...option,
        strategy: input.strategy,
        role: "income",
        strike: parseMoney4(input.strike),
        price: parseMoney4(input.price),
        basis,
      };
    }
    case "put_credit_spread":
    case "call_credit_spread":
      return {
        ...option,
        strategy: input.strategy,
        role: "income",
        shortStrike: parseMoney4(input.short.strike),
        longStrike: parseMoney4(input.long.strike),
        price: subMoney4(parseMoney4(input.short.price), parseMoney4(input.long.price)),
      };
    case "put_debit_spread":
    case "call_debit_spread":
      return {
        ...option,
        strategy: input.strategy,
        role: input.role,
        shortStrike: parseMoney4(input.short.strike),
        longStrike: parseMoney4(input.long.strike),
        price: subMoney4(parseMoney4(input.long.price), parseMoney4(input.short.price)),
      };
    case "long_call":
    case "long_put":
      return {
        ...option,
        strategy: input.strategy,
        role: input.role,
        strike: parseMoney4(input.strike),
        price: parseMoney4(input.price),
      };
  }
}

export function previewTrade(
  raw: unknown,
  assignedStock: readonly AssignedStockOption[],
): TradePreview {
  const parsed = createPositionSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  const input = parsed.data;
  let assignedBasis: Money4 | undefined;
  if (input.strategy === "cc" && input.cover.kind === "assigned") {
    const stockLegId = input.cover.stockLegId;
    const stock = assignedStock.find((candidate) => candidate.legId === stockLegId);
    if (
      !stock ||
      stock.underlying !== input.underlying ||
      stock.uncoveredShares < input.quantity * 100 ||
      stock.assignedOn > input.openedOn
    ) {
      return { success: false, errors: ["Choose assigned shares available for this covered call"] };
    }
    assignedBasis = stock.basis;
  }
  const position = requestToPosition(input, assignedBasis);
  const metrics = positionMetrics(position);
  const costBasis =
    position.strategy === "csp"
      ? assignedShareBasis(position.strike, position.price)
      : position.strategy === "cc" && metrics.kind === "income"
        ? metrics.breakeven
        : null;
  return { success: true, input, position, metrics, costBasis };
}

export function defaultFee(quantity: number): Money4 {
  const fee = mulMoney4(parseMoney4("0.65"), quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(fee)) {
    throw new RangeError("Fee quantity must be a nonnegative integer within Money4 range");
  }
  return fee;
}

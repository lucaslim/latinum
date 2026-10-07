import { type Money4, Money4RangeError, mulMoney4, parseMoney4 } from "../domain/money.ts";
import { type Metrics, type Position, positionMetrics } from "../domain/positions.ts";
import { assignedShareBasis } from "../domain/wheel.ts";
import {
  type AssignedStockOption,
  type CreatePositionRequest,
  createPositionSchema,
} from "./trade.ts";

import { requestToPosition } from "./tradePosition.ts";

export { requestToPosition } from "./tradePosition.ts";

export type TradePreview =
  | {
      success: true;
      input: CreatePositionRequest;
      position: Position;
      metrics: Metrics;
      costBasis: Money4 | null;
    }
  | { success: false; errors: string[] };

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
  let metrics: Metrics;
  try {
    metrics = positionMetrics(position);
  } catch (error) {
    if (error instanceof Money4RangeError) return { success: false, errors: [error.message] };
    throw error;
  }
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

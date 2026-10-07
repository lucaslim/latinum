import { type Money4, parseMoney4, subMoney4 } from "../domain/money.ts";
import type { Position } from "../domain/positions.ts";
import type { CreatePositionRequest } from "./trade.ts";

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

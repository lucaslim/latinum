import { parseIsoDate } from "../domain/dates.ts";
import { absMoney4, divMoney4, mulMoney4, sumMoney4 } from "../domain/money.ts";
import type { Position } from "../domain/positions.ts";
import type { repository } from "./repository.ts";

type StoredPosition = Awaited<
  ReturnType<ReturnType<typeof repository>["readOpenPositions"]>
>[number];
type StoredLeg = StoredPosition["legs"][number];
function quantity(leg: StoredLeg) {
  return leg.trades.reduce(
    (qty, event) => qty + (event.action === "open" ? event.quantity : -event.quantity),
    0,
  );
}
function openingPrice(leg: StoredLeg) {
  const fills = leg.trades.filter((event) => event.action === "open");
  return divMoney4(
    sumMoney4(fills.map((fill) => mulMoney4(fill.price, fill.quantity))),
    fills.reduce((qty, fill) => qty + fill.quantity, 0),
  );
}
function requireLeg(legs: StoredLeg[], kind: StoredLeg["kind"], side: StoredLeg["side"]) {
  const leg = legs.find((leg) => leg.kind === kind && leg.side === side);
  if (!leg) throw new Error(`Missing ${side} ${kind} leg`);
  return leg;
}
function option(leg: StoredLeg) {
  if (leg.strike === null || leg.expiry === null) throw new Error("Incomplete option series");
  return {
    strike: leg.strike,
    expiry: parseIsoDate(leg.expiry),
    qty: quantity(leg),
    adjusted: leg.adjusted,
    price: openingPrice(leg),
  };
}

// This bridge covers the phase-1 open-book seed, not lifecycle/assignment accounting.
export function toBookPosition(p: StoredPosition): Position {
  const base = { underlying: p.underlying, openedOn: parseIsoDate(p.openedOn) };
  switch (p.strategy) {
    case "stock": {
      const leg = requireLeg(p.legs, "stock", "long");
      return {
        ...base,
        strategy: "stock",
        role: "swing",
        shares: quantity(leg),
        price: openingPrice(leg),
      };
    }
    case "csp":
      return {
        ...base,
        ...option(requireLeg(p.legs, "put", "short")),
        strategy: "csp",
        role: "income",
      };
    case "cc":
      return {
        ...base,
        ...option(requireLeg(p.legs, "call", "short")),
        strategy: "cc",
        role: "income",
        basis: openingPrice(requireLeg(p.legs, "stock", "long")),
      };
    case "put_debit_spread": {
      if (p.role === "income") throw new Error("Debit spread cannot have income role");
      const long = option(requireLeg(p.legs, "put", "long"));
      const short = option(requireLeg(p.legs, "put", "short"));
      return {
        ...base,
        expiry: long.expiry,
        qty: long.qty,
        adjusted: long.adjusted,
        strategy: p.strategy,
        role: p.role,
        longStrike: long.strike,
        shortStrike: short.strike,
        price: absMoney4(sumMoney4([long.price, mulMoney4(short.price, -1)])),
      };
    }
    case "long_call": {
      if (p.role === "income") throw new Error("Long option cannot have income role");
      return {
        ...base,
        ...option(requireLeg(p.legs, "call", "long")),
        strategy: "long_call",
        role: p.role,
      };
    }
    default:
      throw new Error(`Open-book bridge does not support ${p.strategy}`);
  }
}

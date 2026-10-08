import { parseIsoDate } from "../domain/dates.ts";
import { absMoney4, divMoney4, mulMoney4, sumMoney4 } from "../domain/money.ts";
import type { Position } from "../domain/positions.ts";
import type { OpenPosition } from "../domain/sheet.ts";
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

// The Sheet values remaining quantity at opening prices, before fees.
export function toBookPosition(p: StoredPosition): Position {
  const base = { underlying: p.underlying, openedOn: parseIsoDate(p.openedOn) };
  switch (p.strategy) {
    case "stock":
    case "day_trade": {
      const leg = requireLeg(p.legs, "stock", "long");
      return {
        ...base,
        strategy: p.strategy,
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
    case "cc": {
      const call = requireLeg(p.legs, "call", "short");
      const stock = p.legs.find((leg) => leg.kind === "stock" && leg.side === "long");
      if (quantity(call) === 0 && stock && quantity(stock) > 0) {
        return {
          ...base,
          strategy: "stock",
          role: "swing",
          shares: quantity(stock),
          price: openingPrice(stock),
        };
      }
      return {
        ...base,
        ...option(call),
        strategy: "cc",
        role: "income",
        basis: p.coveredStock?.basis ?? openingPrice(requireLeg(p.legs, "stock", "long")),
      };
    }
    case "put_credit_spread":
    case "call_credit_spread": {
      const kind = p.strategy === "put_credit_spread" ? "put" : "call";
      const short = option(requireLeg(p.legs, kind, "short"));
      const long = option(requireLeg(p.legs, kind, "long"));
      return {
        ...base,
        expiry: short.expiry,
        qty: short.qty,
        adjusted: short.adjusted || long.adjusted,
        strategy: p.strategy,
        role: "income",
        longStrike: long.strike,
        shortStrike: short.strike,
        price: sumMoney4([short.price, mulMoney4(long.price, -1)]),
      };
    }
    case "put_debit_spread":
    case "call_debit_spread": {
      if (p.role === "income") throw new Error("Debit spread cannot have income role");
      const kind = p.strategy === "put_debit_spread" ? "put" : "call";
      const long = option(requireLeg(p.legs, kind, "long"));
      const short = option(requireLeg(p.legs, kind, "short"));
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
    case "long_call":
    case "long_put": {
      if (p.role === "income") throw new Error("Long option cannot have income role");
      return {
        ...base,
        ...option(requireLeg(p.legs, p.strategy === "long_call" ? "call" : "put", "long")),
        strategy: p.strategy,
        role: p.role,
      };
    }
    default:
      throw new Error(`Open-book bridge does not support ${p.strategy}`);
  }
}

/** Covered shares move from swing capital to CC collateral, without copying their fills. */
export function toBookPositions(rows: StoredPosition[]): OpenPosition[] {
  const covered = new Map<string, number>();
  for (const row of rows) {
    if (!row.coveredStock) continue;
    const call = requireLeg(row.legs, "call", "short");
    covered.set(
      row.coveredStock.legId,
      (covered.get(row.coveredStock.legId) ?? 0) + quantity(call) * call.multiplier,
    );
  }
  return rows.flatMap<OpenPosition>((row) => {
    const stored = { id: row.id, campaignId: row.campaignId, rollChainId: row.rollChainId };
    const p = toBookPosition(row);
    if ("shares" in p) {
      const leg = requireLeg(row.legs, "stock", "long");
      const shares = p.shares - (covered.get(leg.id) ?? 0);
      if (shares < 0) throw new Error("Covered calls exceed stock balance");
      return shares === 0 ? [] : [{ ...stored, ...p, shares }];
    }
    const entries: OpenPosition[] = [{ ...stored, ...p }];
    if (p.strategy === "cc") {
      const stock = row.legs.find((leg) => leg.kind === "stock" && leg.side === "long");
      if (stock) {
        const heldCalls = row.legs
          .filter((leg) => leg.kind === "call" && leg.side === "short" && leg.coveredLegId === null)
          .reduce((shares, leg) => shares + quantity(leg) * leg.multiplier, 0);
        const shares = quantity(stock) - heldCalls - (covered.get(stock.id) ?? 0);
        if (shares < 0) throw new Error("Covered calls exceed stock balance");
        if (shares > 0)
          entries.push({
            ...stored,
            underlying: p.underlying,
            openedOn: p.openedOn,
            strategy: "stock",
            role: "swing",
            shares,
            price: openingPrice(stock),
          });
      }
    }
    return entries;
  });
}

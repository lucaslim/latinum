import { dte, type IsoDate } from "../../domain/dates.ts";
import { negMoney4 } from "../../domain/money.ts";
import { type Position, positionMetrics } from "../../domain/positions.ts";
import { percent, shortDate, strikeNumber, usd } from "../format.ts";

export type Tone = "credit" | "debit" | "spread" | "cc" | "muted" | "dim";
export type Marker = "max" | "cost" | "risk" | "RoR";

export interface Cell {
  text: string;
  tone?: Tone;
  marker?: Marker;
}

export interface SheetRowView {
  ticker: string;
  strike: string;
  type: Cell;
  side: string;
  expiry: string;
  dte: string;
  qty: string;
  premium: Cell;
  collateral: Cell;
  yield: Cell;
  ann: Cell;
  /** Income rows carry yield and annualized; the rest carry their role instead. */
  income: boolean;
  /** Row tint: covered calls by strategy, hedges and swings by role. */
  tint: "cc" | "hedge" | "swing" | null;
}

const DASH: Cell = { text: "—", tone: "dim" };

function strikeText(p: Position): string {
  switch (p.strategy) {
    case "stock":
    case "day_trade":
      return `${p.shares} sh`;
    case "csp":
    case "cc":
    case "long_call":
    case "long_put":
      return `$${strikeNumber(p.strike)}`;
    case "put_credit_spread":
    case "call_credit_spread":
      return `$${strikeNumber(p.shortStrike)}/${strikeNumber(p.longStrike)}`;
    case "put_debit_spread":
    case "call_debit_spread":
      return `$${strikeNumber(p.longStrike)}/${strikeNumber(p.shortStrike)}`;
  }
}

function typeAndSide(p: Position): { type: Cell; side: string } {
  switch (p.strategy) {
    case "csp":
      return { type: { text: "Put", tone: "muted" }, side: "short" };
    case "cc":
      return { type: { text: "Call", tone: "cc" }, side: "covered" };
    case "put_credit_spread":
      return { type: { text: "Put Spread", tone: "spread" }, side: "short" };
    case "call_credit_spread":
      return { type: { text: "Call Spread", tone: "spread" }, side: "short" };
    case "put_debit_spread":
      return { type: { text: "Put Spread", tone: "spread" }, side: "long" };
    case "call_debit_spread":
      return { type: { text: "Call Spread", tone: "spread" }, side: "long" };
    case "long_call":
      return { type: { text: "Call", tone: "muted" }, side: "long" };
    case "long_put":
      return { type: { text: "Put", tone: "muted" }, side: "long" };
    case "stock":
      return { type: { text: "Stock", tone: "muted" }, side: "long" };
    case "day_trade":
      return { type: { text: "Day trade", tone: "muted" }, side: "long" };
  }
}

function moneyCells(p: Position): Pick<SheetRowView, "premium" | "collateral" | "yield" | "ann"> {
  const x = positionMetrics(p);
  switch (x.kind) {
    case "income":
      return {
        premium: { text: usd(x.premium), tone: "credit" },
        collateral: { text: usd(x.collateral) },
        yield: { text: percent(x.yield, 2) },
        ann: { text: percent(x.annualized), tone: "muted" },
      };
    case "debit":
      return {
        premium:
          x.maxProfit === "unlimited"
            ? { text: usd(negMoney4(x.debit)), tone: "debit", marker: "cost" }
            : { text: usd(x.maxProfit), tone: "credit", marker: "max" },
        collateral: { text: usd(x.collateral), marker: "risk" },
        // Open P/L needs a mark, and marks arrive with the drill-down.
        yield:
          x.returnOnRisk === null
            ? DASH
            : { text: percent(x.returnOnRisk), tone: "spread", marker: "RoR" },
        ann: { text: p.role, tone: "dim" },
      };
    case "stock":
      return {
        premium: DASH,
        collateral: { text: usd(x.collateral), marker: "cost" },
        yield: DASH,
        ann: { text: p.role, tone: "dim" },
      };
  }
}

export function sheetRow(p: Position, asOf: IsoDate): SheetRowView {
  const expiry = "expiry" in p ? p.expiry : null;
  const tint =
    p.strategy === "cc" ? "cc" : p.role === "hedge" || p.role === "swing" ? p.role : null;
  return {
    ticker: p.underlying,
    strike: strikeText(p),
    ...typeAndSide(p),
    expiry: expiry ? shortDate(expiry) : "—",
    dte: expiry ? String(dte(expiry, asOf)) : "—",
    qty: "shares" in p ? "—" : String(p.qty),
    ...moneyCells(p),
    income: p.role === "income",
    tint,
  };
}

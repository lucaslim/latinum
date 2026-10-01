import { type IsoDate, parseIsoDate } from "../dates.ts";
import { type Money4, parseMoney4 } from "../money.ts";
import type {
  CashSecuredPut,
  CoveredCall,
  DebitSpread,
  LongOption,
  Position,
  StockPosition,
} from "../positions.ts";

export const m = parseMoney4;
export const d = parseIsoDate;

export function csp(
  underlying: string,
  strike: string,
  expiry: string,
  qty: number,
  price: string,
  openedOn: string,
  adjusted = false,
): CashSecuredPut {
  return {
    strategy: "csp",
    role: "income",
    underlying,
    strike: m(strike),
    price: m(price),
    qty,
    openedOn: d(openedOn),
    expiry: d(expiry),
    adjusted,
  };
}

export function cc(
  underlying: string,
  strike: string,
  expiry: string,
  qty: number,
  price: string,
  openedOn: string,
  basis: string,
): CoveredCall {
  return {
    strategy: "cc",
    role: "income",
    underlying,
    strike: m(strike),
    price: m(price),
    qty,
    openedOn: d(openedOn),
    expiry: d(expiry),
    adjusted: false,
    basis: m(basis),
  };
}

export function putDebitSpread(
  underlying: string,
  longStrike: string,
  shortStrike: string,
  expiry: string,
  qty: number,
  debit: string,
  openedOn: string,
  role: DebitSpread["role"] = "hedge",
): DebitSpread {
  return {
    strategy: "put_debit_spread",
    role,
    underlying,
    longStrike: m(longStrike),
    shortStrike: m(shortStrike),
    price: m(debit),
    qty,
    openedOn: d(openedOn),
    expiry: d(expiry),
    adjusted: false,
  };
}

export function longCall(
  underlying: string,
  strike: string,
  expiry: string,
  qty: number,
  debit: string,
  openedOn: string,
): LongOption {
  return {
    strategy: "long_call",
    role: "swing",
    underlying,
    strike: m(strike),
    price: m(debit),
    qty,
    openedOn: d(openedOn),
    expiry: d(expiry),
    adjusted: false,
  };
}

export function stock(
  underlying: string,
  shares: number,
  price: string,
  openedOn: string,
): StockPosition {
  return {
    strategy: "stock",
    role: "swing",
    underlying,
    shares,
    price: m(price),
    openedOn: d(openedOn),
  };
}

/**
 * Discord sample. The screenshot rounds premiums to whole dollars, and AVGX 4,135 over 15
 * contracts is not a 4-decimal price (2.7567 gives 4,135.05), so the sample's 14,455 total is
 * asserted at whole-dollar display precision.
 */
export const discordBook: Position[] = [
  csp("AVGX", "45", "2026-09-18", 15, "2.7567", "2026-09-01"),
  csp("MRVL", "200", "2026-09-25", 2, "4.50", "2026-09-01"),
  csp("DRAM", "53", "2026-09-25", 10, "2.10", "2026-09-01"),
  csp("NVDL", "30", "2026-09-25", 10, "0.90", "2026-09-01"),
  csp("SPXL", "240", "2026-10-09", 2, "3.10", "2026-09-01"),
  csp("TQQQ", "55", "2026-10-09", 15, "1.15", "2026-09-01"),
  csp("NVDL", "30", "2026-10-09", 5, "1.10", "2026-09-01"),
  csp("MUU", "25", "2026-10-09", 10, "1.50", "2026-09-01"),
  putDebitSpread("SPY", "730", "725", "2026-10-09", 1, "0.52", "2026-09-01"),
  putDebitSpread("QQQ", "670", "665", "2026-10-09", 2, "0.70", "2026-09-01"),
  csp("ASMG", "35", "2026-10-16", 5, "1.75", "2026-09-01"),
  csp("GGLL", "85", "2026-10-16", 5, "2.30", "2026-09-01"),
];

/** Covered sample; the call rows' share basis is not part of the fixture, so it is arbitrary. */
export const coveredBook: Position[] = [
  csp("DRAM", "50", "2026-08-07", 10, "2.00", "2026-07-20"),
  csp("AVGX", "35", "2026-08-21", 10, "1.80", "2026-07-20"),
  csp("GGLL", "90", "2026-08-21", 5, "2.50", "2026-07-20"),
  cc("TSMG", "36", "2026-08-21", 10, "3.90", "2026-07-20", "30.00"),
  cc("MRVL", "220", "2026-08-21", 2, "13.00", "2026-07-20", "200.00"),
  csp("DRAM", "45", "2026-08-28", 10, "2.583", "2026-07-20"),
  csp("NVDL", "25", "2026-08-28", 10, "1.55", "2026-07-20"),
  cc("MRVL", "210", "2026-08-28", 2, "19.00", "2026-07-20", "196.40"),
  cc("DRAM", "55", "2026-08-28", 15, "4.10", "2026-07-20", "53.00"),
  putDebitSpread("TQQQ", "60", "55", "2026-08-28", 3, "1.56", "2026-07-20"),
];

export const cspBook: Position[] = [
  csp("DRAM", "55", "2026-07-24", 10, "2.40", "2026-07-01"),
  csp("MRVL", "210", "2026-07-24", 2, "5.00", "2026-07-01"),
  csp("DRAM", "55", "2026-07-31", 15, "2.00", "2026-07-01"),
  csp("NVDL", "26.67", "2026-07-31", 15, "0.80", "2026-07-01", true),
  csp("TQQQ", "55", "2026-07-31", 20, "1.925", "2026-07-01"),
  csp("DRAM", "50", "2026-08-07", 10, "2.00", "2026-07-01"),
  csp("AVGX", "35", "2026-08-21", 10, "1.80", "2026-07-01"),
];

/** The prototype's sample book (`POS`), as of 2026-10-01. */
export const prototypeBook: Position[] = [
  csp("DRAM", "50", "2026-10-09", 10, "1.85", "2026-09-25"),
  csp("AVGX", "35", "2026-10-16", 10, "1.60", "2026-09-18"),
  csp("NVDL", "75", "2026-10-16", 5, "2.80", "2026-09-15"),
  csp("NVDL", "70", "2026-10-16", 5, "1.90", "2026-09-15"),
  putDebitSpread("NVDA", "180", "175", "2026-10-16", 2, "1.09", "2026-09-15"),
  cc("DRAM", "55", "2026-10-16", 15, "1.10", "2026-09-18", "53.00"),
  csp("TQQQ", "55", "2026-10-23", 20, "2.45", "2026-09-24"),
  cc("MRVL", "210", "2026-10-23", 2, "4.75", "2026-09-25", "196.40"),
  csp("GGLL", "85", "2026-10-30", 5, "2.30", "2026-09-29"),
  putDebitSpread("QQQ", "670", "665", "2026-10-30", 2, "0.70", "2026-09-22"),
  longCall("AAPL", "250", "2026-11-20", 1, "7.80", "2026-09-10"),
  stock("CRWD", 50, "455.20", "2026-09-21"),
];

export type { IsoDate, Money4 };

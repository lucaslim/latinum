import { type IsoDate, term } from "./dates.ts";
import { absMoney4, addMoney4, type Money4, mulMoney4, ratio, subMoney4 } from "./money.ts";

const CONTRACT_MULTIPLIER = 100;

interface OptionBase {
  underlying: string;
  qty: number;
  openedOn: IsoDate;
  expiry: IsoDate;
  /** Non-standard deliverable (for example an NVDL strike of 26.67); the metrics only carry the flag. */
  adjusted: boolean;
  /** Per share, as filled: a credit for short premium, a debit for long positions. */
  price: Money4;
}

export interface CashSecuredPut extends OptionBase {
  strategy: "csp";
  role: "income";
  strike: Money4;
}

export interface CoveredCall extends OptionBase {
  strategy: "cc";
  role: "income";
  strike: Money4;
  /** Per-share cost basis of the covered shares. */
  basis: Money4;
}

export interface CreditSpread extends OptionBase {
  strategy: "put_credit_spread" | "call_credit_spread";
  role: "income";
  shortStrike: Money4;
  longStrike: Money4;
}

export interface DebitSpread extends OptionBase {
  strategy: "put_debit_spread" | "call_debit_spread";
  role: "hedge" | "swing";
  longStrike: Money4;
  shortStrike: Money4;
}

export interface LongOption extends OptionBase {
  strategy: "long_call" | "long_put";
  role: "hedge" | "swing";
  strike: Money4;
}

export interface StockPosition {
  strategy: "stock" | "day_trade";
  role: "swing";
  underlying: string;
  shares: number;
  price: Money4;
  openedOn: IsoDate;
}

export type Position =
  | CashSecuredPut
  | CoveredCall
  | CreditSpread
  | DebitSpread
  | LongOption
  | StockPosition;

export interface IncomeMetrics {
  kind: "income";
  contracts: number;
  term: number;
  premium: Money4;
  collateral: Money4;
  yield: number;
  /** D5 a: yield x 365 / term. */
  annualized: number;
  breakeven: Money4;
  maxProfit: Money4;
  maxLoss: Money4;
  adjusted: boolean;
}

export interface DebitMetrics {
  kind: "debit";
  contracts: number;
  term: number;
  debit: Money4;
  /** Risk is the net debit. */
  collateral: Money4;
  breakeven: Money4;
  maxProfit: Money4 | "unlimited";
  maxLoss: Money4;
  /** Null when the profit is unlimited. */
  returnOnRisk: number | null;
  adjusted: boolean;
}

export interface StockMetrics {
  kind: "stock";
  contracts: 0;
  collateral: Money4;
}

export type Metrics = IncomeMetrics | DebitMetrics | StockMetrics;

/** D5 a: simple annualization over the days the position was open to expiry. */
export function annualize(periodYield: number, termDays: number): number {
  if (termDays < 1) throw new RangeError(`Cannot annualize over a ${termDays}-day term`);
  return (periodYield * 365) / termDays;
}

/** D5 b: the same yield over the days left, for the Stats toggle. */
export function annualizeByDte(periodYield: number, daysLeft: number): number {
  if (daysLeft < 1) throw new RangeError(`Cannot annualize over ${daysLeft} days left`);
  return (periodYield * 365) / daysLeft;
}

const perContracts = (amount: Money4, qty: number): Money4 =>
  mulMoney4(amount, CONTRACT_MULTIPLIER * qty);

const spreadWidth = (a: Money4, b: Money4): Money4 => absMoney4(subMoney4(a, b));

export function spreadMaxPayout(spread: DebitSpread): Money4 {
  return perContracts(spreadWidth(spread.longStrike, spread.shortStrike), spread.qty);
}

function incomeMetrics(
  p: CashSecuredPut | CoveredCall | CreditSpread,
  fields: Pick<IncomeMetrics, "collateral" | "breakeven" | "maxProfit" | "maxLoss">,
): IncomeMetrics {
  const premium = perContracts(p.price, p.qty);
  const termDays = term(p.openedOn, p.expiry);
  const periodYield = ratio(premium, fields.collateral);
  return {
    kind: "income",
    contracts: p.qty,
    term: termDays,
    premium,
    yield: periodYield,
    annualized: annualize(periodYield, termDays),
    adjusted: p.adjusted,
    ...fields,
  };
}

function debitMetrics(
  p: DebitSpread | LongOption,
  fields: Pick<DebitMetrics, "breakeven" | "maxProfit">,
): DebitMetrics {
  const debit = perContracts(p.price, p.qty);
  return {
    kind: "debit",
    contracts: p.qty,
    term: term(p.openedOn, p.expiry),
    debit,
    collateral: debit,
    maxLoss: debit,
    returnOnRisk: fields.maxProfit === "unlimited" ? null : ratio(fields.maxProfit, debit),
    adjusted: p.adjusted,
    ...fields,
  };
}

export function positionMetrics(p: CashSecuredPut | CoveredCall | CreditSpread): IncomeMetrics;
export function positionMetrics(p: DebitSpread | LongOption): DebitMetrics;
export function positionMetrics(p: StockPosition): StockMetrics;
export function positionMetrics(p: Position): Metrics;
export function positionMetrics(p: Position): Metrics {
  switch (p.strategy) {
    case "csp": {
      const collateral = perContracts(p.strike, p.qty);
      const premium = perContracts(p.price, p.qty);
      return incomeMetrics(p, {
        collateral,
        breakeven: subMoney4(p.strike, p.price),
        maxProfit: premium,
        maxLoss: subMoney4(collateral, premium),
      });
    }
    case "cc": {
      const shares = CONTRACT_MULTIPLIER * p.qty;
      const premium = perContracts(p.price, p.qty);
      return incomeMetrics(p, {
        // D2: share value at the strike, not at basis
        collateral: mulMoney4(p.strike, shares),
        breakeven: subMoney4(p.basis, p.price),
        maxProfit: addMoney4(mulMoney4(subMoney4(p.strike, p.basis), shares), premium),
        maxLoss: subMoney4(mulMoney4(p.basis, shares), premium),
      });
    }
    case "put_credit_spread":
    case "call_credit_spread": {
      const premium = perContracts(p.price, p.qty);
      const collateral = subMoney4(
        perContracts(spreadWidth(p.shortStrike, p.longStrike), p.qty),
        premium,
      );
      return incomeMetrics(p, {
        collateral,
        breakeven:
          p.strategy === "put_credit_spread"
            ? subMoney4(p.shortStrike, p.price)
            : addMoney4(p.shortStrike, p.price),
        maxProfit: premium,
        maxLoss: collateral,
      });
    }
    case "put_debit_spread":
    case "call_debit_spread": {
      const debit = perContracts(p.price, p.qty);
      return debitMetrics(p, {
        breakeven:
          p.strategy === "put_debit_spread"
            ? subMoney4(p.longStrike, p.price)
            : addMoney4(p.longStrike, p.price),
        maxProfit: subMoney4(spreadMaxPayout(p), debit),
      });
    }
    case "long_call":
      return debitMetrics(p, { breakeven: addMoney4(p.strike, p.price), maxProfit: "unlimited" });
    case "long_put":
      return debitMetrics(p, {
        breakeven: subMoney4(p.strike, p.price),
        maxProfit: subMoney4(perContracts(p.strike, p.qty), perContracts(p.price, p.qty)),
      });
    case "stock":
    case "day_trade":
      return { kind: "stock", contracts: 0, collateral: mulMoney4(p.price, p.shares) };
  }
}

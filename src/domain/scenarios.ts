import { addMoney4, divMoney4, type Money4, ratio, subMoney4, sumMoney4 } from "./money.ts";
import {
  annualize,
  type CashSecuredPut,
  type DebitSpread,
  positionMetrics,
  spreadMaxPayout,
} from "./positions.ts";

const SHARES_PER_CONTRACT = 100;

export interface CspScenarios {
  premium: Money4;
  capital: Money4;
  hedgeDebit: Money4;
  hedgePayout: Money4;
  noAssignment: {
    netProfit: Money4;
    periodYield: number;
    /** D5 a, over the longest put term. */
    annualized: number;
    term: number;
  };
  assigned: {
    /** Premium plus the hedge's max payout, less its debit; cash only, not share P/L. */
    cash: Money4;
    cashYield: number;
    shares: number;
    /** Per put, in input order. */
    basisBeforeHedge: Money4[];
    /** Net hedge payout over the assigned shares: a campaign view, not tax basis. */
    hedgeCut: Money4;
    effectiveBasis: Money4[];
  };
}

export function cspScenarios(input: {
  puts: readonly [CashSecuredPut, ...CashSecuredPut[]];
  hedges: readonly DebitSpread[];
}): CspScenarios {
  const { puts, hedges } = input;
  const metrics = puts.map((p) => positionMetrics(p));

  const premium = sumMoney4(metrics.map((x) => x.premium));
  const capital = sumMoney4(metrics.map((x) => x.collateral));
  const hedgeDebit = sumMoney4(hedges.map((h) => positionMetrics(h).debit));
  const hedgePayout = sumMoney4(hedges.map(spreadMaxPayout));
  const shares = puts.reduce((n, p) => n + p.qty * SHARES_PER_CONTRACT, 0);
  const termDays = Math.max(...metrics.map((x) => x.term));

  const netProfit = subMoney4(premium, hedgeDebit);
  const periodYield = ratio(netProfit, capital);
  const cash = subMoney4(addMoney4(premium, hedgePayout), hedgeDebit);
  const hedgeCut = divMoney4(subMoney4(hedgePayout, hedgeDebit), shares);
  const basisBeforeHedge = puts.map((p) => subMoney4(p.strike, p.price));

  return {
    premium,
    capital,
    hedgeDebit,
    hedgePayout,
    noAssignment: {
      netProfit,
      periodYield,
      annualized: annualize(periodYield, termDays),
      term: termDays,
    },
    assigned: {
      cash,
      cashYield: ratio(cash, capital),
      shares,
      basisBeforeHedge,
      hedgeCut,
      effectiveBasis: basisBeforeHedge.map((b) => subMoney4(b, hedgeCut)),
    },
  };
}

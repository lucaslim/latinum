import { addMoney4, type Money4, ratio, sumMoney4 } from "./money.ts";
import { type Position, positionMetrics } from "./positions.ts";

export interface BookTotals {
  /** Sum of qty over every option position, hedges included; stock shares are not contracts. */
  contracts: number;
  /** Income rows only. */
  premium: Money4;
  incomeCollateral: Money4;
  /** Blended premium over income collateral; null when the book has no income rows. */
  yield: number | null;
  /** D5 a, weighted by collateral; null when the book has no income rows. */
  annualized: number | null;
  /** Net debit of hedge rows: excluded from income totals, counted in capital deployed. */
  hedgeCost: Money4;
  swingCapital: Money4;
  capitalDeployed: Money4;
}

export function bookTotals(positions: readonly Position[]): BookTotals {
  let contracts = 0;
  let annualizedWeighted = 0;
  const premiums: Money4[] = [];
  const incomeCollaterals: Money4[] = [];
  const hedgeDebits: Money4[] = [];
  const swingCollaterals: Money4[] = [];

  for (const p of positions) {
    const x = positionMetrics(p);
    contracts += x.contracts;
    if (x.kind === "income") {
      premiums.push(x.premium);
      incomeCollaterals.push(x.collateral);
      annualizedWeighted += x.annualized * x.collateral;
    } else if (p.role === "hedge") {
      hedgeDebits.push(x.collateral);
    } else {
      swingCollaterals.push(x.collateral);
    }
  }

  const premium = sumMoney4(premiums);
  const incomeCollateral = sumMoney4(incomeCollaterals);
  const hedgeCost = sumMoney4(hedgeDebits);
  const swingCapital = sumMoney4(swingCollaterals);
  const hasIncome = incomeCollateral !== 0;

  return {
    contracts,
    premium,
    incomeCollateral,
    yield: hasIncome ? ratio(premium, incomeCollateral) : null,
    annualized: hasIncome ? annualizedWeighted / incomeCollateral : null,
    hedgeCost,
    swingCapital,
    capitalDeployed: addMoney4(addMoney4(incomeCollateral, hedgeCost), swingCapital),
  };
}

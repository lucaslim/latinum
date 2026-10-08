import { allocateRealizedTrades } from "./lifecyclePnl.ts";
import { absMoney4, addMoney4, type Money4, ratio, sumMoney4 } from "./money.ts";
import type {
  ClosedOutcome,
  MonthlyPnlLeg,
  MonthlyPnlMonth,
  MonthlyPnlResponse,
  MonthlyPnlStats,
} from "./monthlyPnlTypes.ts";

function stats(outcomes: readonly ClosedOutcome[]): MonthlyPnlStats {
  const winners = outcomes.filter((outcome) => outcome.pnl > 0);
  const grossWins = sumMoney4(winners.map((outcome) => outcome.pnl));
  const grossLosses = sumMoney4(
    outcomes.filter((outcome) => outcome.pnl < 0).map((outcome) => absMoney4(outcome.pnl)),
  );
  return {
    pnl: sumMoney4(outcomes.map((outcome) => outcome.pnl)),
    closed: outcomes.length,
    wins: winners.length,
    winRate: outcomes.length === 0 ? null : winners.length / outcomes.length,
    grossWins,
    grossLosses,
    profitFactor: grossLosses === 0 ? null : ratio(grossWins, grossLosses),
  };
}

function nextMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

export function aggregateMonthlyPnl(legs: readonly MonthlyPnlLeg[]): MonthlyPnlResponse {
  const grouped = new Map<string, ClosedOutcome>();
  for (const leg of legs) {
    const trades = new Map(leg.trades.map((trade) => [trade.id, trade]));
    for (const allocation of allocateRealizedTrades(leg.trades)) {
      const trade = trades.get(allocation.tradeId);
      if (!trade || trade.action === "open") throw new Error("Missing realized closing trade");
      // Net all legs and same-day fills before classifying a spread as a win or loss.
      const id = JSON.stringify([leg.positionId, trade.date, trade.action, trade.rollId]);
      const existing = grouped.get(id);
      if (existing) {
        existing.pnl = addMoney4(existing.pnl, allocation.pnl);
        existing.tradeIds.push(trade.id);
      } else {
        grouped.set(id, {
          id,
          positionId: leg.positionId,
          campaignId: leg.campaignId,
          underlying: leg.underlying,
          strategy: leg.strategy,
          date: trade.date,
          action: trade.action,
          rollId: trade.rollId,
          tradeIds: [trade.id],
          pnl: allocation.pnl,
        });
      }
    }
  }
  const outcomes = [...grouped.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.positionId.localeCompare(b.positionId) ||
      a.action.localeCompare(b.action) ||
      (a.rollId ?? "").localeCompare(b.rollId ?? ""),
  );
  const first = outcomes[0];
  const last = outcomes.at(-1);
  if (!first || !last) return { months: [] };
  const byMonth = new Map<string, ClosedOutcome[]>();
  for (const outcome of outcomes) {
    outcome.tradeIds.sort();
    const month = outcome.date.slice(0, 7);
    const entries = byMonth.get(month) ?? [];
    entries.push(outcome);
    byMonth.set(month, entries);
  }
  const months: MonthlyPnlMonth[] = [];
  let cumulativePnl = 0 as Money4;
  for (
    let month = first.date.slice(0, 7);
    month <= last.date.slice(0, 7);
    month = nextMonth(month)
  ) {
    const trades = byMonth.get(month) ?? [];
    const totals = stats(trades);
    cumulativePnl = addMoney4(cumulativePnl, totals.pnl);
    months.push({
      month,
      ...totals,
      cumulativePnl,
      trades,
      byStrategy: [...new Set(trades.map((outcome) => outcome.strategy))]
        .sort()
        .map((strategy) => ({
          strategy,
          ...stats(trades.filter((outcome) => outcome.strategy === strategy)),
        })),
    });
  }
  return { months };
}

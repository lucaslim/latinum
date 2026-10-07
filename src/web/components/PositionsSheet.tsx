import { useState } from "react";
import type { IsoDate } from "../../domain/dates.ts";
import {
  filterPositions,
  type OpenPosition,
  SHEET_FILTERS,
  type SheetFilter,
  sortByExpiry,
} from "../../domain/sheet.ts";
import { type BookTotals, bookTotals } from "../../domain/totals.ts";
import { percent, shortDate, usd } from "../format.ts";
import { type Cell, sheetRow } from "./sheetRow.ts";
import "./sheet.css";

const FILTER_LABEL: Record<SheetFilter, string> = {
  all: "All",
  income: "Income",
  hedges: "Hedges",
  swings: "Swings",
};

const orDash = (value: number | null, show: (value: number) => string) =>
  value === null ? "—" : show(value);

function Value({ cell }: { cell: Cell }) {
  return (
    <>
      <span className={cell.tone && `tone-${cell.tone}`}>{cell.text}</span>
      {cell.marker && <sup className="m">{cell.marker}</sup>}
    </>
  );
}

function Kpis({ totals }: { totals: BookTotals }) {
  return (
    <section className="kpis" aria-label="Book summary">
      <div className="kpi">
        <div className="label">Premium working</div>
        <div className="v tone-credit">{usd(totals.premium)}</div>
        <div className="h">{totals.contracts} contracts open</div>
      </div>
      <div className="kpi">
        <div className="label">Blended yield</div>
        <div className="v">{orDash(totals.yield, (y) => percent(y, 2))}</div>
        <div className="h">
          {orDash(totals.annualized, (a) => percent(a))} annualized, collateral-weighted
        </div>
      </div>
      <div className="kpi">
        <div className="label">Capital deployed</div>
        <div className="v">{usd(totals.capitalDeployed)}</div>
        <div className="h">
          {usd(totals.incomeCollateral)} income + {usd(totals.hedgeCost)} hedges +{" "}
          {usd(totals.swingCapital)} swings
        </div>
      </div>
    </section>
  );
}

function TableFooter({ totals }: { totals: BookTotals }) {
  return (
    <tfoot>
      <tr>
        <td>Total</td>
        <td colSpan={5} />
        <td className="r num">
          {totals.contracts} <span className="tone-muted">contracts</span>
        </td>
        <td className="r num tone-credit">{usd(totals.premium)}</td>
        <td className="r num">{usd(totals.incomeCollateral)}</td>
        <td className="r num">{orDash(totals.yield, (y) => percent(y, 2))}</td>
        <td className="r num">
          {orDash(totals.annualized, (a) => percent(a))} <span className="tone-muted">ann.</span>
        </td>
      </tr>
      <tr className="sub">
        <td colSpan={7}>
          Income rows only in premium, collateral and yield. Hedges {usd(totals.hedgeCost)} at risk
          and swings {usd(totals.swingCapital)} count toward capital deployed.
        </td>
        <td className="r num" colSpan={2}>
          deployed {usd(totals.capitalDeployed)}
        </td>
        <td colSpan={2} />
      </tr>
    </tfoot>
  );
}

function CardFooter({ totals }: { totals: BookTotals }) {
  return (
    <div className="cards-foot">
      <div>
        Total {totals.contracts} contracts ·{" "}
        <span className="num tone-credit">{usd(totals.premium)}</span> on{" "}
        <span className="num">{usd(totals.incomeCollateral)}</span> ·{" "}
        <span className="num">{orDash(totals.yield, (y) => percent(y, 2))}</span> ·{" "}
        <span className="num">{orDash(totals.annualized, (a) => percent(a))}</span> ann.
      </div>
      <div className="tone-muted">
        Hedges {usd(totals.hedgeCost)} at risk and swings {usd(totals.swingCapital)} · deployed{" "}
        {usd(totals.capitalDeployed)}
      </div>
    </div>
  );
}

export function PositionsSheet({
  positions,
  asOf,
  initialFilter = "all",
}: {
  positions: readonly OpenPosition[];
  asOf: IsoDate;
  initialFilter?: SheetFilter;
}) {
  const [filter, setFilter] = useState<SheetFilter>(initialFilter);
  const visible = sortByExpiry(filterPositions(positions, filter));
  const rows = visible.map((p) => ({ id: p.id, campaignId: p.campaignId, ...sheetRow(p, asOf) }));
  const footerTotals = bookTotals(visible);

  return (
    <>
      <h1>Open positions</h1>
      <p className="subtitle">
        As of {shortDate(asOf)} · {positions.length} open position
        {positions.length === 1 ? "" : "s"}
      </p>
      <Kpis totals={bookTotals(positions)} />
      <fieldset className="chips">
        <legend className="sr-only">Filter positions</legend>
        {SHEET_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="chip"
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </fieldset>

      <div className="tablewrap" data-testid="sheet-table">
        <table className="pos">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Strike</th>
              <th>Type</th>
              <th>Side</th>
              <th>Expiry</th>
              <th className="r">DTE</th>
              <th className="r">Qty</th>
              <th className="r">Premium</th>
              <th className="r">Collateral</th>
              <th className="r">Yield</th>
              <th className="r">Ann.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.tint ? `row ${r.tint}` : "row"}>
                <td className="tk">
                  <a href={`#/campaigns/${r.campaignId}`}>{r.ticker}</a>
                </td>
                <td className="num">{r.strike}</td>
                <td>
                  <Value cell={r.type} />
                </td>
                <td className="num">{r.side}</td>
                <td className="tone-muted">{r.expiry}</td>
                <td className="r num tone-muted">{r.dte}</td>
                <td className="r num">{r.qty}</td>
                <td className="r num">
                  <Value cell={r.premium} />
                </td>
                <td className="r num">
                  <Value cell={r.collateral} />
                </td>
                <td className="r num">
                  <Value cell={r.yield} />
                </td>
                <td className="r num">
                  <Value cell={r.ann} />
                </td>
              </tr>
            ))}
          </tbody>
          <TableFooter totals={footerTotals} />
        </table>
        <p className="note">
          Puts are cash-secured (strike × 100 × qty). Covered calls use share value at the strike.
          Hedge spreads show max profit as premium, the net debit as risk, and return on risk
          instead of a yield. Ann. = yield × 365 ÷ days from open to expiry, not DTE remaining.
        </p>
      </div>

      <div className="cards" data-testid="sheet-cards">
        {rows.map((r) => (
          <article key={r.id} className={r.tint ? `card ${r.tint}` : "card"}>
            <div className="l1">
              <a href={`#/campaigns/${r.campaignId}`}>{r.ticker}</a>{" "}
              <span className="num">{r.strike}</span> <Value cell={r.type} />{" "}
              <span className="tone-muted">{r.side}</span>
            </div>
            <div className="r1 num">
              <Value cell={r.premium} />
            </div>
            <div className="l2">
              {r.expiry === "—" ? "stock" : `${r.expiry} · ${r.dte}d · ×${r.qty}`} ·{" "}
              <span className="num">
                <Value cell={r.collateral} />
              </span>
            </div>
            <div className="r2 num">
              {r.income ? (
                <>
                  <Value cell={r.yield} /> · {r.ann.text} ann
                </>
              ) : (
                <>
                  {r.yield.text !== "—" && (
                    <>
                      <Value cell={r.yield} /> ·{" "}
                    </>
                  )}
                  {r.ann.text}
                </>
              )}
            </div>
          </article>
        ))}
        <CardFooter totals={footerTotals} />
      </div>
    </>
  );
}

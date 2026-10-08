import { useId, useState } from "react";
import type { Money4 } from "../../domain/money.ts";
import type {
  MonthlyPnlMonth,
  MonthlyPnlResponse,
  MonthlyPnlStats,
  StrategyPnl,
} from "../../domain/monthlyPnlTypes.ts";
import { percent, usd } from "../format.ts";
import { useMonthlyPnl } from "../monthlyPnlApi.ts";
import "./monthly-pnl.css";

const strategyLabels: Record<StrategyPnl["strategy"], string> = {
  csp: "Cash-secured put",
  cc: "Covered call",
  put_credit_spread: "Put credit spread",
  call_credit_spread: "Call credit spread",
  put_debit_spread: "Put debit spread",
  call_debit_spread: "Call debit spread",
  long_call: "Long call",
  long_put: "Long put",
  stock: "Stock",
  day_trade: "Day trade",
};
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
const signedUsd = (value: Money4) => `${value > 0 ? "+" : ""}${usd(value, 2)}`;
const winRate = (stats: MonthlyPnlStats) =>
  stats.winRate === null ? "—" : percent(stats.winRate, 1);
const profitFactor = (stats: MonthlyPnlStats) =>
  stats.profitFactor === null
    ? stats.grossWins > 0 && stats.grossLosses === 0
      ? "∞"
      : "—"
    : stats.profitFactor.toFixed(2);
const tone = (value: Money4) => (value < 0 ? "tone-debit" : value > 0 ? "tone-credit" : "");

function MonthlyChart({ months }: { months: MonthlyPnlMonth[] }) {
  const descriptionId = useId();
  const values = months.flatMap((month) => [month.pnl, month.cumulativePnl]);
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const range = high - low || 1;
  const y = (value: number) => 20 + ((high - value) / range) * 220;
  const step = 660 / months.length;
  const x = (index: number) => 30 + step * (index + 0.5);
  const barWidth = Math.min(160, step * 0.75);
  return (
    <figure className="monthly-chart">
      <svg
        viewBox="0 0 720 260"
        role="img"
        aria-label="Monthly net P/L and cumulative P/L"
        aria-describedby={descriptionId}
      >
        <title>Monthly net P/L and cumulative P/L</title>
        <desc id={descriptionId}>
          Bars show monthly net P/L; the line shows cumulative net P/L. Positive bars are above the
          zero axis, negative bars below. Exact amounts appear in the month list.
        </desc>
        <line className="monthly-zero" x1="30" x2="690" y1={y(0)} y2={y(0)} />
        {months.map((month, index) => (
          <rect
            key={month.month}
            data-month={month.month}
            x={x(index) - barWidth / 2}
            y={y(Math.max(0, month.pnl))}
            width={barWidth}
            height={Math.abs(y(month.pnl) - y(0))}
            className={`monthly-bar ${tone(month.pnl)}`}
          >
            <title>{`${monthLabel(month.month)}: ${signedUsd(month.pnl)}`}</title>
          </rect>
        ))}
        <polyline
          className="monthly-cumulative"
          points={months.map((month, index) => `${x(index)},${y(month.cumulativePnl)}`).join(" ")}
        />
        {months.map((month, index) => (
          <circle
            key={month.month}
            className="monthly-point"
            cx={x(index)}
            cy={y(month.cumulativePnl)}
            r="4"
          />
        ))}
      </svg>
      <figcaption>Bars: monthly net P/L · Line: cumulative net P/L · Net of fees</figcaption>
    </figure>
  );
}

function StrategyTable({ rows }: { rows: StrategyPnl[] }) {
  if (rows.length === 0) return <p>No strategy outcomes in this month.</p>;
  return (
    <table className="monthly-strategies" aria-label="By strategy">
      <thead>
        <tr>
          <th scope="col">Strategy</th>
          <th scope="col">Net P/L</th>
          <th scope="col">Closed</th>
          <th scope="col">Wins</th>
          <th scope="col">Win rate</th>
          <th scope="col">Profit factor</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.strategy}>
            <th scope="row">{strategyLabels[row.strategy]}</th>
            <td data-label="Net P/L" className={`num ${tone(row.pnl)}`}>
              {signedUsd(row.pnl)}
            </td>
            <td data-label="Closed" className="num">
              {row.closed}
            </td>
            <td data-label="Wins" className="num">
              {row.wins}
            </td>
            <td data-label="Win rate" className="num">
              {winRate(row)}
            </td>
            <td data-label="Profit factor" className="num">
              {profitFactor(row)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MonthlyPnlDashboard({ data }: { data: MonthlyPnlResponse }) {
  const [selected, setSelected] = useState<string | null>(null);
  const month = data.months.find((entry) => entry.month === selected) ?? data.months.at(-1);
  return (
    <section className="monthly-pnl" aria-label="Monthly P/L dashboard">
      <h1>Monthly P/L</h1>
      <p className="monthly-note">Net of fees · Realized on the New York closing trade date.</p>
      {!month ? (
        <p role="status">No realized P/L yet.</p>
      ) : (
        <>
          <MonthlyChart months={data.months} />
          <ul className="monthly-months" aria-label="Months and exact chart values">
            {data.months.map((entry) => (
              <li key={entry.month}>
                <button
                  type="button"
                  aria-pressed={month.month === entry.month}
                  aria-label={monthLabel(entry.month)}
                  onClick={() => setSelected(entry.month)}
                >
                  <time dateTime={entry.month}>{monthLabel(entry.month)}</time>
                  <span className="monthly-series">
                    {`${monthLabel(entry.month)}: monthly ${signedUsd(entry.pnl)}; cumulative ${signedUsd(entry.cumulativePnl)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <section aria-label={`${monthLabel(month.month)} details`}>
            <h2>{monthLabel(month.month)}</h2>
            <dl className="monthly-stats" aria-label="Month summary">
              <div>
                <dt>Net P/L</dt>
                <dd className={`num ${tone(month.pnl)}`}>{signedUsd(month.pnl)}</dd>
              </div>
              <div>
                <dt>Closed outcomes</dt>
                <dd className="num">{month.closed}</dd>
              </div>
              <div>
                <dt>Wins</dt>
                <dd className="num">{month.wins}</dd>
              </div>
              <div>
                <dt>Win rate</dt>
                <dd className="num">{winRate(month)}</dd>
              </div>
              <div>
                <dt>Profit factor</dt>
                <dd className="num">{profitFactor(month)}</dd>
              </div>
              <div>
                <dt>Gross wins</dt>
                <dd className="num">{usd(month.grossWins, 2)}</dd>
              </div>
              <div>
                <dt>Gross losses</dt>
                <dd className="num">{usd(month.grossLosses, 2)}</dd>
              </div>
            </dl>
            <p className="monthly-note">
              Closed outcomes group fills with the same position, New York date, action and roll.
              Gross wins/losses sum positive/negative net outcomes, including fees. Breakeven
              outcomes count as closed, not wins.
            </p>
            <h3>Closed trades</h3>
            {month.trades.length === 0 ? (
              <p>No closed outcomes in this month.</p>
            ) : (
              <ol className="monthly-closures" aria-label="Closed trades">
                {month.trades.map((trade) => (
                  <li key={trade.id}>
                    <div>
                      <a href={`#/campaigns/${encodeURIComponent(trade.campaignId)}`}>
                        {trade.underlying}
                      </a>
                      <span>
                        {strategyLabels[trade.strategy]} ·{" "}
                        {trade.rollId ? "Roll close" : trade.action}
                      </span>
                      <time dateTime={trade.date}>{trade.date}</time>
                    </div>
                    <strong className={`num ${tone(trade.pnl)}`}>{signedUsd(trade.pnl)}</strong>
                  </li>
                ))}
              </ol>
            )}
            <h3>By strategy</h3>
            <StrategyTable rows={month.byStrategy} />
          </section>
        </>
      )}
    </section>
  );
}

export function MonthlyPnlRoute() {
  const { load, retry } = useMonthlyPnl();
  if (load.status === "ready") return <MonthlyPnlDashboard data={load.data} />;
  return (
    <section className="monthly-pnl" aria-label="Monthly P/L dashboard">
      <h1>Monthly P/L</h1>
      {load.status === "loading" ? (
        <p role="status">Loading monthly P/L…</p>
      ) : (
        <>
          <p role="alert">{load.message}</p>
          <button type="button" onClick={retry}>
            Retry monthly P/L
          </button>
        </>
      )}
    </section>
  );
}

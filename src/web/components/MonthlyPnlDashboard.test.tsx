import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { parseIsoDate as isoDate } from "../../domain/dates.ts";
import type { Money4 } from "../../domain/money.ts";
import type { MonthlyPnlMonth, MonthlyPnlResponse } from "../../domain/monthlyPnlTypes.ts";
import type { MonthlyPnlLoad } from "../monthlyPnlApi.ts";
import { MonthlyPnlDashboard, MonthlyPnlRoute } from "./MonthlyPnlDashboard.tsx";

const request = vi.hoisted(() => ({
  load: { status: "loading" } as MonthlyPnlLoad,
  retry: vi.fn(),
}));
vi.mock("../monthlyPnlApi.ts", () => ({ useMonthlyPnl: () => request }));
beforeEach(() => {
  request.load = { status: "loading" };
  request.retry.mockClear();
});
const m = (value: number) => value as Money4;
const september: MonthlyPnlMonth = {
  month: "2026-09",
  pnl: m(66246700),
  cumulativePnl: m(66246700),
  closed: 14,
  wins: 9,
  winRate: 0.6428571428571429,
  grossWins: m(95169700),
  grossLosses: m(28923000),
  profitFactor: 3.290451198008505,
  trades: [
    {
      id: "dram",
      positionId: "dram-position",
      campaignId: "dram/campaign",
      underlying: "DRAM",
      strategy: "csp",
      date: isoDate("2026-09-18"),
      action: "assign",
      rollId: null,
      tradeIds: ["dram-assign"],
      pnl: m(29901000),
    },
    {
      id: "tqqq",
      positionId: "tqqq-position",
      campaignId: "tqqq-campaign",
      underlying: "TQQQ",
      strategy: "csp",
      date: isoDate("2026-09-25"),
      action: "close",
      rollId: "roll",
      tradeIds: ["tqqq-close"],
      pnl: m(-8132000),
    },
  ],
  byStrategy: [
    {
      strategy: "csp",
      pnl: m(21769000),
      closed: 2,
      wins: 1,
      winRate: 0.5,
      grossWins: m(29901000),
      grossLosses: m(8132000),
      profitFactor: 3.676955238563699,
    },
  ],
};
const zero: MonthlyPnlMonth = {
  month: "2026-11",
  pnl: m(0),
  cumulativePnl: m(0),
  closed: 0,
  wins: 0,
  winRate: null,
  grossWins: m(0),
  grossLosses: m(0),
  profitFactor: null,
  trades: [],
  byStrategy: [],
};
const render = (data: MonthlyPnlResponse) =>
  renderToStaticMarkup(<MonthlyPnlDashboard data={data} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("September summary, grouped closures, strategy stats and encoded campaign links", () => {
  const html = render({ months: [september] });
  const output = text(html);
  expect(output).toContain("September 2026");
  expect(output).toContain("Net P/L +$6,624.67");
  expect(output).toContain("Closed outcomes 14");
  expect(output).toContain("Wins 9");
  expect(output).toContain("Win rate 64.3%");
  expect(output).toContain("Profit factor 3.29");
  expect(output).toContain("Gross wins $9,516.97");
  expect(output).toContain("Gross losses $2,892.30");
  expect(output).toContain("Net of fees");
  expect(output).toContain("same position, New York date, action and roll");
  expect(output).toContain("DRAM");
  expect(output).toContain("+$2,990.10");
  expect(output).toContain("TQQQ");
  expect(output).toContain("−$813.20");
  expect(output).toContain("Cash-secured put");
  expect(output).toContain("+$2,176.90");
  expect(output).toContain("50.0%");
  expect(output).toContain("3.68");
  expect(html).toContain('href="#/campaigns/dram%2Fcampaign"');
  expect(html).toContain('href="#/campaigns/tqqq-campaign"');
  expect(html).toContain('aria-label="By strategy"');
  expect(html).toContain('dateTime="2026-09-18"');
  expect(html).toContain("assign");
  expect(html).toContain("Roll close");
});

test("signed native SVG bars and cumulative points share a zero axis; latest month is selected", () => {
  const html = render({
    months: [
      { ...zero, month: "2026-09", pnl: m(1000000), cumulativePnl: m(1000000) },
      { ...zero, month: "2026-10", pnl: m(-1000000), cumulativePnl: m(0) },
      zero,
    ],
  });
  expect(html).toContain('viewBox="0 0 720 260"');
  expect(html).toContain('aria-label="Monthly net P/L and cumulative P/L"');
  expect(html).toContain("Bars show monthly net P/L; the line shows cumulative net P/L");
  expect(html).toContain('data-month="2026-09" x="60" y="20" width="160" height="110"');
  expect(html).toContain('data-month="2026-10" x="280" y="130" width="160" height="110"');
  expect(html).toContain('data-month="2026-11" x="500" y="130" width="160" height="0"');
  expect(html).toContain('points="140,20 360,130 580,130"');
  expect(html).toContain('y1="130"');
  expect(html).not.toMatch(/NaN|Infinity/);
  expect(html).toContain('aria-pressed="true" aria-label="November 2026"');
  expect(html).toContain('aria-pressed="false" aria-label="September 2026"');
  expect(text(html)).toContain("October 2026: monthly −$100.00; cumulative $0.00");
  expect(text(html)).toContain("No closed outcomes in this month.");
});

test("zero-only month has finite chart coordinates and no invented ratios", () => {
  const html = render({ months: [zero] });
  expect(html).not.toMatch(/NaN|Infinity/);
  expect(text(html)).toContain("Net P/L $0.00");
  expect(text(html)).toContain("Win rate —");
  expect(text(html)).toContain("Profit factor —");
  expect(text(html)).toContain("No strategy outcomes in this month.");
});

test.each([
  { wins: 1, closed: 1, winRate: 1, grossWins: m(1000000), factor: "∞" },
  { wins: 0, closed: 1, winRate: 0, grossWins: m(0), factor: "—" },
])("zero-loss profit factor is $factor with $wins wins", ({ factor, ...stats }) => {
  const month = { ...zero, ...stats };
  const html = render({ months: [{ ...month, byStrategy: [{ ...month, strategy: "cc" }] }] });
  expect(text(html)).toContain(`Profit factor ${factor}`);
  expect(text(html)).toContain(stats.wins === 1 ? "Win rate 100.0%" : "Win rate 0.0%");
  expect(text(html)).toContain("Covered call");
  expect(text(html).match(new RegExp(factor === "∞" ? "∞" : "—", "g"))).toHaveLength(2);
});

test("empty response is distinct from a zero month", () => {
  const html = render({ months: [] });
  expect(text(html)).toContain("No realized P/L yet.");
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("Win rate");
});

test("route shows loading, error with retry, and ready data", () => {
  expect(renderToStaticMarkup(<MonthlyPnlRoute />)).toContain('role="status"');
  expect(text(renderToStaticMarkup(<MonthlyPnlRoute />))).toContain("Loading monthly P/L…");
  request.load = { status: "error", message: "Offline" };
  const html = renderToStaticMarkup(<MonthlyPnlRoute />);
  expect(html).toContain('role="alert"');
  expect(text(html)).toContain("Offline");
  expect(html).toContain('<button type="button">Retry monthly P/L</button>');
  request.load = { status: "ready", data: { months: [september] } };
  expect(text(renderToStaticMarkup(<MonthlyPnlRoute />))).toContain("Net P/L +$6,624.67");
});

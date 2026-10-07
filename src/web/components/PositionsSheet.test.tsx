import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseIsoDate } from "../../domain/dates.ts";
import { parseMoney4 as m } from "../../domain/money.ts";
import type { Position } from "../../domain/positions.ts";
import type { OpenPosition } from "../../domain/sheet.ts";
import { coveredBook, cspBook, discordBook, prototypeBook } from "../../domain/test/fixtures.ts";
import { PositionsSheet } from "./PositionsSheet.tsx";

const asOf = parseIsoDate("2026-10-01");
const render = (book: Position[], initialFilter?: "income" | "hedges" | "swings") =>
  renderToStaticMarkup(
    <PositionsSheet
      asOf={asOf}
      positions={book.map(
        (p, i): OpenPosition => ({ ...p, id: `p${i}`, campaignId: `campaign-${i}` }),
      )}
      {...(initialFilter ? { initialFilter } : {})}
    />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const slice = (html: string, tag: string) =>
  html.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`))?.[0] ?? "";
const footer = (html: string) => text(slice(html, "tfoot"));

describe("Sheet footer", () => {
  it("prototype book: 77 contracts, $14,450, 3.33%, 47% ann. and $458,398 deployed", () => {
    const f = footer(render(prototypeBook));

    expect(f).toContain("77 contracts");
    expect(f).toContain("$14,450");
    expect(f).toContain("$434,500");
    expect(f).toContain("3.33%");
    expect(f).toContain("47% ann.");
    expect(f).toContain("Hedges $358 at risk and swings $23,540");
    expect(f).toContain("deployed $458,398");
  });

  it.each([
    ["Discord", discordBook, "82 contracts", "$14,455", "$421,000", "3.43%", "$192"],
    ["Covered", coveredBook, "77 contracts", "$25,633", "$404,500", "6.34%", "$468"],
    ["CSP", cspBook, "82 contracts", "$15,250", "$414,505", "3.68%", "$0"],
  ])("%s book totals", (_name, book, contracts, premium, collateral, yieldText, hedges) => {
    const f = footer(render(book));

    expect(f).toContain(contracts);
    expect(f).toContain(premium);
    expect(f).toContain(collateral);
    expect(f).toContain(yieldText);
    expect(f).toContain(`Hedges ${hedges} at risk`);
  });

  it("follows the active filter while the KPI strip keeps the whole book", () => {
    const html = render(prototypeBook, "hedges");

    expect(footer(html)).toContain("4 contracts");
    expect(footer(html)).toContain("$0");
    expect(footer(html)).toContain("—");
    expect(text(slice(html, "section"))).toContain("77 contracts open");
  });
});

it("counts split held CC rows as one real position and keeps residual capital", () => {
  const html = renderToStaticMarkup(
    <PositionsSheet
      asOf={asOf}
      positions={[
        {
          id: "held-cc",
          campaignId: "dram",
          strategy: "cc",
          role: "income",
          underlying: "DRAM",
          openedOn: parseIsoDate("2026-09-18"),
          expiry: parseIsoDate("2026-10-16"),
          strike: m("55"),
          basis: m("53"),
          qty: 10,
          price: m("1.10"),
          adjusted: false,
        },
        {
          id: "held-cc",
          campaignId: "dram",
          strategy: "stock",
          role: "swing",
          underlying: "DRAM",
          openedOn: parseIsoDate("2026-09-18"),
          shares: 500,
          price: m("53"),
        },
      ]}
      onEdit={() => {}}
    />,
  );
  expect(text(html)).toContain("1 open position");
  expect(text(html)).not.toContain("2 open positions");
  expect(footer(html)).toContain("swings $26,500");
  expect(footer(html)).toContain("deployed $81,500");
  expect(slice(html, "tbody").match(/Edit DRAM trade/g)).toHaveLength(2);
  expect(html.match(/href="#\/campaigns\/dram"/g)).toHaveLength(4);
});

describe("Sheet rows", () => {
  const html = render(prototypeBook);
  const rows = slice(html, "tbody").split("</tr>").slice(0, -1);
  const row = (ticker: string) =>
    text(rows.find((r) => text(r).trim().startsWith(ticker)) ?? "").trim();

  it("lists the open book by expiry with the Discord columns", () => {
    expect(rows).toHaveLength(12);
    expect(text(slice(html, "thead"))).toBe(
      " Ticker Strike Type Side Expiry DTE Qty Premium Collateral Yield Ann. ",
    );
    expect(row("DRAM $50")).toBe("DRAM $50 Put short Oct 9 8 10 $1,850 $50,000 3.70% 96%");
  });

  it("shows max and risk markers on the hedge row and excludes it from income", () => {
    expect(row("NVDA")).toBe(
      "NVDA $180/175 Put Spread long Oct 16 15 2 $782 max $218 risk 359% RoR hedge",
    );
    expect(html).toContain('class="row hedge"');
  });

  it("marks a long call as cost and risk, and stock as cost", () => {
    expect(row("AAPL")).toBe("AAPL $250 Call long Nov 20 50 1 −$780 cost $780 risk — swing");
    expect(row("CRWD")).toBe("CRWD 50 sh Stock long — — — — $22,760 cost — swing");
  });

  it("tints covered calls, hedges and swings", () => {
    expect(html.match(/class="row cc"/g)).toHaveLength(2);
    expect(html.match(/class="row hedge"/g)).toHaveLength(2);
    expect(html.match(/class="row swing"/g)).toHaveLength(2);
  });

  it("links ticker names to the campaign in both desktop rows and phone cards", () => {
    expect(html.match(/href="#\/campaigns\/campaign-0"/g)).toHaveLength(2);
    expect(html.match(/<a[^>]*href="#\/campaigns\/campaign-0"[^>]*>DRAM<\/a>/g)).toHaveLength(2);
  });

  it("renders two-line cards for the narrow layout", () => {
    expect(html.match(/class="card[ "]/g)).toHaveLength(12);
    expect(text(slice(html, "article"))).toContain("DRAM $50 Put short");
  });
});

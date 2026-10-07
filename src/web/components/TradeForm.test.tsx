import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseIsoDate } from "../../domain/dates.ts";
import * as expiryModule from "../../domain/expiry.ts";
import type { Money4 } from "../../domain/money.ts";
import { positionMetrics } from "../../domain/positions.ts";
import { STRATEGY_LABELS, TRADE_STRATEGIES } from "../../shared/trade.ts";
import { previewTrade } from "../../shared/tradeForm.ts";
import { DerivedTradeMetrics, TradeForm } from "./TradeForm.tsx";

describe("TradeForm", () => {
  it("offers all ten strategies and invalid initial inputs cannot save", () => {
    const html = renderToStaticMarkup(
      <TradeForm
        asOf={parseIsoDate("2026-09-25")}
        options={{ tickers: ["DRAM"], tags: ["wheel"], assignedStock: [] }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const strategy of TRADE_STRATEGIES) expect(html).toContain(STRATEGY_LABELS[strategy]);
    expect(html).toContain('aria-label="Derived trade metrics"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toContain('value="2026-09-25"');
    expect(html).toContain('value="0.65"');
    expect(html).toContain('aria-label="Expiry quick choices"');
    expect(html).toContain("2026-10-16 M");
    const quickChoices = html.match(
      /<fieldset aria-label="Expiry quick choices"[^>]*>(.*?)<\/fieldset>/,
    )?.[1];
    expect(quickChoices?.match(/<button /g)).toHaveLength(7);
    expect(html).not.toContain("NYSE calendar unsupported");
    expect(html.indexOf('value="DRAM"')).toBeLessThan(html.indexOf('value="AAPL"'));
    expect(html).toContain('value="wheel"');
  });

  it.each(["2028-11-20", "2029-01-02"])(
    "keeps the Add form and manual expiry usable when quick choices exceed coverage as of %s",
    (asOf) => {
      const html = renderToStaticMarkup(
        <TradeForm
          asOf={parseIsoDate(asOf)}
          options={{ tickers: [], tags: [], assignedStock: [] }}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(html).toContain('<form aria-label="Add trade"');
      expect(html).toContain("<h2>Add trade</h2>");
      expect(html).toMatch(/<label>Expiry<input type="date"[^>]*value=""/);
      expect(html).not.toMatch(/<fieldset[^>]*disabled/);
      for (const strategy of TRADE_STRATEGIES) expect(html).toContain(STRATEGY_LABELS[strategy]);
      expect(html).toContain(
        'role="status">NYSE calendar unsupported for these expiry quick choices (coverage: 2026–2028). Enter an expiry date manually.',
      );
      expect(html).toMatch(/<fieldset aria-label="Expiry quick choices"[^>]*><\/fieldset>/);
      expect(html).toContain(">Save trade</button>");
      expect(html).toContain(">Cancel</button>");
    },
  );

  it("does not swallow an unrelated RangeError from quick-choice generation", () => {
    const error = new RangeError("Unexpected expiry failure");
    const spy = vi.spyOn(expiryModule, "expiryChips").mockImplementation(() => {
      throw error;
    });
    try {
      expect(() =>
        renderToStaticMarkup(
          <TradeForm
            asOf={parseIsoDate("2026-09-25")}
            options={{ tickers: [], tags: [], assignedStock: [] }}
            onSaved={() => {}}
            onCancel={() => {}}
          />,
        ),
      ).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders every DRAM gross fixture line from the shared production preview", () => {
    const preview = previewTrade(
      {
        strategy: "csp",
        underlying: "DRAM",
        openedOn: "2026-09-25",
        expiry: "2026-10-09",
        quantity: 10,
        adjusted: false,
        strike: "50",
        price: "1.85",
        fees: "6.50",
        tags: [],
      },
      [],
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.errors.join("; "));
    const html = renderToStaticMarkup(
      <DerivedTradeMetrics metrics={preview.metrics} costBasis={preview.costBasis} />,
    );
    expect(html).toContain("$1,850");
    expect(html).toContain("$50,000");
    expect(html).toContain("3.70%");
    expect(html).toContain("14 days");
    expect(html).toContain("96.5%");
    expect(html).toContain("$48.15");
    expect(html).toContain("$48.15/sh");
  });

  it("labels bounded debit risk and stock capital without income lines", () => {
    const debit = positionMetrics({
      strategy: "put_debit_spread",
      role: "hedge",
      underlying: "TQQQ",
      openedOn: parseIsoDate("2026-09-25"),
      expiry: parseIsoDate("2026-10-09"),
      qty: 3,
      adjusted: false,
      longStrike: 600000 as Money4,
      shortStrike: 550000 as Money4,
      price: 15600 as Money4,
    });
    const html = renderToStaticMarkup(<DerivedTradeMetrics metrics={debit} />);
    expect(html).toContain("Debit");
    expect(html).toContain("$468");
    expect(html).toContain("Max profit");
    expect(html).toContain("$1,032");
    expect(html).toContain("220.5%");
    expect(html).not.toContain("Annualized");
    const stock = positionMetrics({
      strategy: "stock",
      role: "swing",
      underlying: "CRWD",
      openedOn: parseIsoDate("2026-09-25"),
      shares: 50,
      price: 4552000 as Money4,
    });
    const stockHtml = renderToStaticMarkup(<DerivedTradeMetrics metrics={stock} />);
    expect(stockHtml).toContain("Capital");
    expect(stockHtml).toContain("$22,760");
    expect(stockHtml).not.toContain("Yield");
  });
});

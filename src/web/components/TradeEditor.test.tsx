import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIsoDate } from "../../domain/dates.ts";
import type { Money4 } from "../../domain/money.ts";
import type { OpenPosition } from "../../domain/sheet.ts";
import type { ManualTrade } from "../../shared/trade.ts";
import { createTrade, editTrade, loadManualTrades, loadTradeFormOptions } from "../tradeApi.ts";
import { previewEditedTrade, TradeEditor } from "./TradeEditor.tsx";
import { DerivedTradeMetrics } from "./TradeForm.tsx";

const position: Extract<OpenPosition, { strategy: "csp" }> = {
  id: "position",
  campaignId: "campaign",
  strategy: "csp",
  role: "income",
  underlying: "DRAM",
  openedOn: parseIsoDate("2026-09-25"),
  expiry: parseIsoDate("2026-10-09"),
  adjusted: false,
  qty: 10,
  strike: 500000 as Money4,
  price: 18500 as Money4,
};
const trades: [ManualTrade] = [
  {
    id: "fill",
    legId: "put",
    kind: "put",
    side: "short",
    strike: 500000 as Money4,
    expiry: parseIsoDate("2026-10-09"),
    tradeDate: parseIsoDate("2026-09-25"),
    quantity: -10,
    price: 18500 as Money4,
    fees: -65000 as Money4,
    editable: true,
  },
];

describe("manual fill preview", () => {
  it("recalculates all DRAM metrics through the production edit adapter", () => {
    const preview = previewEditedTrade(position, trades, "fill", { price: "2", fees: "6.50" });
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.errors.join("; "));
    expect(preview.metrics).toMatchObject({
      kind: "income",
      premium: 20000000,
      collateral: 500000000,
      yield: 0.04,
      term: 14,
      breakeven: 480000,
    });
    expect(preview.costBasis).toBe(480000);
    const html = renderToStaticMarkup(
      <DerivedTradeMetrics metrics={preview.metrics} costBasis={preview.costBasis} />,
    );
    expect(html).toContain("$2,000");
    expect(html).toContain("4.00%");
    expect(html).toContain("104.3%");
    expect(html).toContain("$48.00/sh");
  });
});

describe("manual edit variants", () => {
  it("clears the preview instead of throwing when an edited stock fill exceeds Money4 precision", () => {
    const stock: OpenPosition = {
      id: "stock",
      campaignId: "campaign",
      strategy: "stock",
      role: "swing",
      underlying: "CRWD",
      openedOn: position.openedOn,
      shares: 2147483647,
      price: 1 as Money4,
    };
    const fill: ManualTrade = {
      ...trades[0],
      id: "stock-fill",
      kind: "stock",
      side: "long",
      strike: null,
      expiry: null,
      quantity: 2147483647,
      price: 1 as Money4,
      fees: 0 as Money4,
    };
    expect(previewEditedTrade(stock, [fill], "stock-fill", { price: "99999999" })).toEqual({
      success: false,
      errors: ["Amount exceeds Money4 precision"],
    });
  });
  it("uses the other current spread leg when editing a fill", () => {
    const spread: OpenPosition = {
      ...position,
      strategy: "put_debit_spread",
      role: "hedge",
      underlying: "TQQQ",
      qty: 3,
      longStrike: 600000 as Money4,
      shortStrike: 550000 as Money4,
      price: 15600 as Money4,
    };
    const fills: ManualTrade[] = [
      {
        ...trades[0],
        id: "long",
        legId: "long-leg",
        side: "long",
        strike: 600000 as Money4,
        quantity: 3,
        price: 20000 as Money4,
      },
      {
        ...trades[0],
        id: "short",
        legId: "short-leg",
        strike: 550000 as Money4,
        quantity: 3,
        price: 4400 as Money4,
      },
    ];
    const preview = previewEditedTrade(spread, fills, "long", { price: "2.00" });
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.errors.join("; "));
    expect(preview.metrics).toMatchObject({
      kind: "debit",
      debit: 4680000,
      maxProfit: 10320000,
      maxLoss: 4680000,
    });
    expect(preview.position.price).toBe(15600);
    expect(previewEditedTrade(spread, fills, "long", { price: "0.44" }).success).toBe(false);
    expect(previewEditedTrade(spread, fills.slice(0, 1), "long", { price: "2" })).toEqual({
      success: false,
      errors: ["Both spread legs are required for a preview"],
    });
  });

  it("editing held-stock basis changes CC breakeven without changing option premium", () => {
    const covered: OpenPosition = {
      ...position,
      strategy: "cc",
      qty: 15,
      strike: 550000 as Money4,
      basis: 550000 as Money4,
      price: 11000 as Money4,
    };
    const fills: ManualTrade[] = [
      {
        ...trades[0],
        id: "call",
        kind: "call",
        legId: "call-leg",
        strike: 550000 as Money4,
        quantity: 15,
        price: 11000 as Money4,
      },
      {
        ...trades[0],
        id: "shares",
        kind: "stock",
        side: "long",
        legId: "stock-leg",
        strike: null,
        expiry: null,
        quantity: 1500,
        price: 550000 as Money4,
        fees: 0 as Money4,
      },
    ];
    const preview = previewEditedTrade(covered, fills, "shares", { price: "53" });
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.errors.join("; "));
    expect(preview.metrics).toMatchObject({
      kind: "income",
      premium: 16500000,
      collateral: 825000000,
      breakeven: 519000,
      maxProfit: 46500000,
    });
    expect(preview.position).toMatchObject({ basis: 530000, price: 11000 });
    expect(preview.costBasis).toBe(519000);
  });

  it("shows stock capital and leaves gross metrics unchanged for fees-only edits", () => {
    const stock: OpenPosition = {
      id: "stock",
      campaignId: "campaign",
      strategy: "stock",
      role: "swing",
      underlying: "CRWD",
      shares: 50,
      price: 4552000 as Money4,
      openedOn: parseIsoDate("2026-09-25"),
    };
    const fill: ManualTrade = {
      ...trades[0],
      id: "stock-fill",
      kind: "stock",
      side: "long",
      strike: null,
      expiry: null,
      quantity: 50,
      price: 4552000 as Money4,
      fees: 0 as Money4,
    };
    const preview = previewEditedTrade(stock, [fill], "stock-fill", { fees: "1.23" });
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error(preview.errors.join("; "));
    expect(preview.metrics).toEqual({ kind: "stock", contracts: 0, collateral: 227600000 });
  });

  it("clears the preview for invalid, missing, or immutable fills", () => {
    expect(previewEditedTrade(position, trades, "fill", { price: "invalid" }).success).toBe(false);
    expect(previewEditedTrade(position, trades, "missing", { price: "2" })).toEqual({
      success: false,
      errors: ["Choose an editable manual fill"],
    });
    expect(
      previewEditedTrade(position, [{ ...trades[0], editable: false }], "fill", { price: "2" })
        .success,
    ).toBe(false);
    expect(
      previewEditedTrade(position, [{ ...trades[0], quantity: 0 }], "fill", { price: "2" }),
    ).toEqual({
      success: false,
      errors: ["Opening fill has no quantity"],
    });
  });

  it("renders the editor action and an accessible loading/cancel boundary", () => {
    const props = {
      asOf: parseIsoDate("2026-09-25"),
      positions: [position],
      onSaved: () => {},
      editingPositionId: null,
      onEditDone: () => {},
    };
    const closed = renderToStaticMarkup(<TradeEditor {...props} />);
    expect(closed).toContain("Add trade");
    const editing = renderToStaticMarkup(<TradeEditor {...props} editingPositionId="position" />);
    expect(editing).toContain('role="status"');
    expect(editing).toContain("Loading trade details");
    expect(editing).toContain("Cancel");
    const missing = renderToStaticMarkup(<TradeEditor {...props} editingPositionId="missing" />);
    expect(missing).toContain('role="alert"');
    expect(missing).toContain("This position is no longer open");
  });
});

describe("trade HTTP boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("loads typed form options and manual trades", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ tickers: ["DRAM"], tags: ["wheel"], assignedStock: [] }),
      )
      .mockResolvedValueOnce(Response.json({ positionId: "position", trades }));
    vi.stubGlobal("fetch", fetch);
    expect(await loadTradeFormOptions()).toEqual({
      tickers: ["DRAM"],
      tags: ["wheel"],
      assignedStock: [],
    });
    expect(await loadManualTrades("position")).toEqual({ positionId: "position", trades });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/trade-form/options", undefined);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/positions/position/manual-trades", undefined);
  });
  it("sends decimal request strings and returns ids", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ positionId: "position", campaignId: "campaign" }))
      .mockResolvedValueOnce(Response.json({ id: "fill" }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await createTrade({
        strategy: "csp",
        underlying: "DRAM",
        openedOn: parseIsoDate("2026-09-25"),
        expiry: parseIsoDate("2026-10-09"),
        quantity: 10,
        adjusted: false,
        strike: "50",
        price: "1.85",
        fees: "6.50",
        tags: [],
      }),
    ).toEqual({ positionId: "position", campaignId: "campaign" });
    expect(await editTrade("fill", { price: "2", fees: "6.50" })).toEqual({ id: "fill" });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/trades/fill", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"price":"2","fees":"6.50"}',
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      price: "1.85",
      fees: "6.50",
    });
  });
  it("reports server errors and rejects invalid requests before fetch", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Imported fills are immutable" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(editTrade("fill", { price: "2" })).rejects.toThrow(
      "HTTP 409: Imported fills are immutable",
    );
    expect(() => editTrade("fill", { fees: "-1" })).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps text, empty-body and transport failures readable", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 500, statusText: "Internal Server Error" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await expect(loadTradeFormOptions()).rejects.toThrow("HTTP 503: Service unavailable");
    await expect(loadManualTrades("position")).rejects.toThrow("HTTP 500: Internal Server Error");
    await expect(loadTradeFormOptions()).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

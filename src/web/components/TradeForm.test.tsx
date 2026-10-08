import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_YEAR, LAST_YEAR } from "../../domain/calendar.ts";
import { parseIsoDate } from "../../domain/dates.ts";
import * as expiryModule from "../../domain/expiry.ts";
import type { Money4 } from "../../domain/money.ts";
import { positionMetrics } from "../../domain/positions.ts";
import { STRATEGY_LABELS, TRADE_STRATEGIES } from "../../shared/trade.ts";
import { previewTrade } from "../../shared/tradeForm.ts";
import { createTrade } from "../tradeApi.ts";
import { DerivedTradeMetrics, TradeForm } from "./TradeForm.tsx";

const hooks = vi.hoisted(() => ({
  slots: new Map<string, unknown[]>(),
  key: "",
  index: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "id",
  useState(initial: unknown) {
    const slots = hooks.slots.get(hooks.key) ?? [];
    hooks.slots.set(hooks.key, slots);
    const index = hooks.index++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (value: unknown) => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const slots = hooks.slots.get(hooks.key) ?? [];
    hooks.slots.set(hooks.key, slots);
    const index = hooks.index++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect(effect: () => void) {
    effect();
  },
}));
vi.mock("../tradeApi.ts", () => ({ createTrade: vi.fn() }));

beforeEach(() => {
  hooks.slots.clear();
  hooks.key = "";
  hooks.index = 0;
});

describe("TradeForm", () => {
  it.each([1500, 1599])(
    "prefills assigned DRAM shares as CC contracts from %s uncovered shares",
    (uncoveredShares) => {
      const assignedStock = {
        legId: "00000000-0000-4000-8000-000000000053",
        underlying: "DRAM",
        uncoveredShares,
        basis: 530000 as Money4,
        assignedOn: parseIsoDate("2026-10-16"),
      };
      const html = renderToStaticMarkup(
        <TradeForm
          asOf={parseIsoDate("2026-10-16")}
          options={{ tickers: ["DRAM"], tags: [], assignedStock: [assignedStock] }}
          assignedStock={{ ...assignedStock, basis: 550000 as Money4 }}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(html).toContain('aria-pressed="true">CC</button>');
      expect(html).toMatch(/<label>Ticker<input[^>]*value="DRAM"/);
      expect(html).toMatch(/<label>Quantity<input[^>]*value="15"/);
      expect(html).toContain('<option value="00000000-0000-4000-8000-000000000053" selected="">');
      expect(html).not.toContain('<option value="held" selected="">');
      expect(html).toContain('<input readOnly="" value="53.0000"/>');
      expect(html).toContain('value="9.75"');
    },
  );

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
        `role="status">NYSE calendar unsupported for these expiry quick choices (coverage: ${FIRST_YEAR}–${LAST_YEAR}). Enter an expiry date manually.`,
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

type ElementProps = { children?: ReactNode; [key: string]: unknown };
function expand(node: ReactNode, path = "root"): ReactNode {
  if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`));
  if (!isValidElement<ElementProps>(node)) return node;
  if (typeof node.type === "function") {
    hooks.key = `${path}/${node.type.name}:${node.key}`;
    hooks.index = 0;
    return expand((node.type as (props: ElementProps) => ReactNode)(node.props), hooks.key);
  }
  return cloneElement(node, {}, expand(node.props.children, `${path}/children`));
}
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<ElementProps>(node) ? [node, ...elements(node.props.children)] : [];
}
const text = (node: ReactNode) =>
  renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("TradeForm role default", () => {
  const render = () =>
    expand(
      <TradeForm
        asOf={parseIsoDate("2026-09-25")}
        options={{ tickers: [], tags: [], assignedStock: [] }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
  const control = (tree: ReactNode, type: "input" | "select", label: string) => {
    const labelled = elements(tree).find(
      (el) => el.type === "label" && text(el.props.children).startsWith(label),
    );
    const el = elements(labelled?.props.children).find((child) => child.type === type);
    if (!el) throw new Error(`Missing ${type} ${label}`);
    return el;
  };
  const roleSelects = (tree: ReactNode) =>
    elements(tree).filter(
      (el) =>
        el.type === "select" && elements(el.props.children).some((o) => o.props.value === "hedge"),
    );
  const roleValue = () => roleSelects(render())[0]?.props.value;
  const choose = (strategy: keyof typeof STRATEGY_LABELS) => {
    const chip = elements(render()).find(
      (el) => el.type === "button" && text(el.props.children) === STRATEGY_LABELS[strategy],
    );
    if (!chip) throw new Error(`Missing strategy ${strategy}`);
    (chip.props.onClick as () => void)();
  };
  const pickRole = (value: string) => {
    const select = roleSelects(render())[0];
    if (!select) throw new Error("Missing Role select");
    (select.props.onChange as (event: unknown) => void)({ target: { value } });
  };
  const typeInto = (type: "input" | "select", label: string, value: string) =>
    (control(render(), type, label).props.onChange as (event: unknown) => void)({
      target: { value },
    });
  const submit = async () => {
    const form = elements(render()).find((el) => el.type === "form");
    if (!form) throw new Error("Missing form");
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: () => {} });
  };

  it.each([
    ["call_debit_spread", "swing"],
    ["long_call", "swing"],
    ["put_debit_spread", "hedge"],
    ["long_put", "hedge"],
  ] as const)("defaults %s to %s", (strategy, role) => {
    choose(strategy);
    expect(roleValue()).toBe(role);
  });

  it.each([
    ["long_call", "put_debit_spread", "hedge"],
    ["long_put", "call_debit_spread", "swing"],
  ] as const)("resets a manual pick when switching %s to %s", (from, to, role) => {
    choose(from);
    pickRole(role === "hedge" ? "swing" : "hedge");
    expect(roleValue()).toBe(role === "hedge" ? "swing" : "hedge");
    choose(to);
    expect(roleValue()).toBe(role);
  });

  it("keeps a manual pick when the selected strategy is clicked again", () => {
    choose("long_call");
    pickRole("hedge");
    choose("long_call");
    expect(roleValue()).toBe("hedge");
  });

  it("submits the role the user picked on a call-side strategy", async () => {
    vi.mocked(createTrade).mockResolvedValue(undefined as never);
    choose("long_call");
    typeInto("input", "Ticker", "QQQ");
    typeInto("input", "Strike", "600");
    typeInto("input", "Fill price", "1.50");
    pickRole("hedge");
    await submit();
    expect(createTrade).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "long_call", role: "hedge" }),
    );
  });

  it("omits role for strategies without one", async () => {
    vi.mocked(createTrade).mockResolvedValue(undefined as never);
    typeInto("input", "Ticker", "QQQ");
    typeInto("input", "Strike", "600");
    typeInto("input", "Fill price", "1.50");
    expect(roleSelects(render())).toHaveLength(0);
    await submit();
    expect(createTrade).toHaveBeenCalledWith(expect.objectContaining({ strategy: "csp" }));
    expect(vi.mocked(createTrade).mock.calls[0]?.[0]).not.toHaveProperty("role");
  });
});

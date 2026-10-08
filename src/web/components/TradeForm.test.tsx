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
  it("names missing fields without exposing schema regex messages", () => {
    const html = renderToStaticMarkup(
      <TradeForm
        asOf={parseIsoDate("2026-09-25")}
        options={{ tickers: [], tags: [], assignedStock: [] }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Needs ticker, strike, fill");
    expect(html).not.toContain("Invalid string");
    expect(html).not.toContain("/^[A-Z]");
  });
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
      expect(html).toMatch(/<label>Strategy<input[^>]*role="combobox"[^>]*value="Covered call"/);
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
    expect(html).toContain('value="Cash-secured put"');
    expect(html).toContain('aria-label="Derived trade metrics"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toContain('value="2026-09-25"');
    expect(html).toContain('value="0.65"');
    expect(html).toContain('aria-label="Expiry quick choices"');
    expect(html).toContain("10-16 M 21d");
    const quickChoices = html.match(
      /<fieldset aria-label="Expiry quick choices"[^>]*>(.*?)<\/fieldset>/,
    )?.[1];
    expect(quickChoices?.match(/<button /g)).toHaveLength(8);
    expect(html).not.toContain("NYSE calendar unsupported");
    expect(html).toMatch(/<label>Ticker<input[^>]*role="combobox"/);
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
      expect(html).toContain('value="Cash-secured put"');
      expect(html).toContain(
        `role="status">NYSE calendar unsupported for these expiry quick choices (coverage: ${FIRST_YEAR}–${LAST_YEAR}). Enter an expiry date manually.`,
      );
      expect(html).toMatch(
        /<fieldset aria-label="Expiry quick choices"[^>]*><button[^>]*>Other…<\/button><\/fieldset>/,
      );
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

const longStrategyNames = {
  csp: "Cash-secured put",
  cc: "Covered call",
  put_credit_spread: "Put credit spread",
  call_credit_spread: "Call credit spread",
  put_debit_spread: "Put debit spread",
  call_debit_spread: "Call debit spread",
  long_put: "Long put",
  long_call: "Long call",
  stock: "Stock",
  day_trade: "Day trade",
};
function chooseStrategy(render: () => ReactNode, strategy: keyof typeof STRATEGY_LABELS) {
  const label = elements(render()).find(
    (el) => el.type === "label" && text(el.props.children) === "Strategy",
  );
  const input = elements(label?.props.children).find((el) => el.type === "input");
  if (!input) throw new Error("Missing Strategy combobox");
  (input.props.onFocus as (event: unknown) => void)({ target: { select: () => {} } });
  const option = elements(render()).find(
    (el) =>
      el.props.role === "option" && text(el.props.children).startsWith(longStrategyNames[strategy]),
  );
  if (!option) throw new Error(`Missing strategy ${strategy}`);
  (option.props.onClick as () => void)();
}

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
  const control = (tree: ReactNode, type: "input" | "select" | "textarea", label: string) => {
    const labelled = elements(tree).find(
      (el) => el.type === "label" && text(el.props.children).startsWith(label),
    );
    const el = elements(labelled?.props.children).find((child) => child.type === type);
    if (!el) throw new Error(`Missing ${type} ${label}`);
    return el;
  };
  const roleControls = (tree: ReactNode) =>
    elements(tree).filter(
      (el) => el.type === "button" && ["Hedge", "Swing"].includes(text(el.props.children)),
    );
  const roleValue = () => {
    const selected = roleControls(render()).find((el) => el.props["aria-pressed"] === true);
    return selected ? text(selected.props.children).toLowerCase() : undefined;
  };
  const choose = (strategy: keyof typeof STRATEGY_LABELS) => chooseStrategy(render, strategy);
  const pickRole = (value: string) => {
    const button = roleControls(render()).find(
      (el) => text(el.props.children).toLowerCase() === value,
    );
    if (!button) throw new Error("Missing Role button");
    (button.props.onClick as () => void)();
  };
  const typeInto = (type: "input" | "select" | "textarea", label: string, value: string) => {
    (control(render(), type, label).props.onChange as (event: unknown) => void)({
      target: { value },
    });
    if (label === "Ticker") (control(render(), type, label).props.onBlur as () => void)();
  };
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

  it("names invalid current values without schema text", () => {
    typeInto("input", "Ticker", "?");
    typeInto("input", "Strike", "0");
    typeInto("input", "Fill price", "bad");
    const html = renderToStaticMarkup(render());
    expect(html).toContain("Needs ticker, strike, fill");
    expect(html).not.toContain("Invalid string");
    expect(html).not.toContain("must match pattern");
    expect(html).not.toContain("Must be greater than zero");
  });

  it("orders debit and credit legs and keeps their fee summaries independent", () => {
    typeInto("input", "Fees", "1.23");
    choose("put_debit_spread");
    let html = renderToStaticMarkup(render());
    expect(html.indexOf("Long strike")).toBeLessThan(html.indexOf("Short strike"));
    expect(html).toContain("Fees $0.65 per leg (0.65 × 1)");
    expect(html).not.toContain("$1.23");
    typeInto("input", "Long fees", "2.00");
    html = renderToStaticMarkup(render());
    expect(html).toContain("Fees $2.00 / $0.65 (long / short)");
    choose("put_credit_spread");
    html = renderToStaticMarkup(render());
    expect(html.indexOf("Short strike")).toBeLessThan(html.indexOf("Long strike"));
    choose("csp");
    expect(renderToStaticMarkup(render())).toContain("Fees $1.23");
  });

  it("shows a visible label naming the Role group", () => {
    choose("long_put");
    const group = elements(render()).find(
      (el) => el.type === "fieldset" && el.props["aria-label"] === "Role",
    );
    expect(
      elements(group?.props.children)
        .filter((el) => el.type === "legend")
        .map((el) => text(el.props.children)),
    ).toEqual(["Role"]);
  });

  it("presses exactly one expiry choice while the editor is open", () => {
    const button = elements(render()).find(
      (el) => el.type === "button" && text(el.props.children) === "Other…",
    );
    if (!button) throw new Error("Missing Other expiry");
    (button.props.onClick as () => void)();
    const group = elements(render()).find(
      (el) => el.props["aria-label"] === "Expiry quick choices",
    );
    expect(
      elements(group?.props.children)
        .filter((el) => el.props["aria-pressed"] === true)
        .map((el) => text(el.props.children)),
    ).toEqual(["Other…"]);
  });

  it("reveals manual expiry and always displays an off-chip selection", () => {
    const press = (name: string) => {
      const button = elements(render()).find(
        (el) => el.type === "button" && text(el.props.children) === name,
      );
      if (!button) throw new Error(`Missing expiry chip ${name}`);
      (button.props.onClick as () => void)();
    };
    press("Other…");
    typeInto("input", "Expiry", "2026-12-18");
    expect(renderToStaticMarkup(render())).toContain("Selected expiry: 2026-12-18");
    const focus = vi.fn();
    (control(render(), "input", "Expiry").props.ref as { current: unknown }).current = { focus };
    press("Other…");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(control(render(), "input", "Expiry").props.value).toBe("2026-12-18");
    press("10-16 M 21d");
    const html = renderToStaticMarkup(render());
    expect(html).toContain("Selected expiry: 2026-10-16");
    expect(html).not.toContain("<label>Expiry<input");
  });

  it("uses Shares for stock and keeps its zero fee default", () => {
    choose("stock");
    const html = renderToStaticMarkup(render());
    expect(html).toContain("<label>Shares<input");
    expect(html).toContain("Fees $0.00");
    expect(html).not.toContain("Expiry quick choices");
    expect(html).not.toContain("<table");
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

  it("preserves the covered-call payload including optional metadata", async () => {
    vi.mocked(createTrade).mockResolvedValue(undefined as never);
    choose("cc");
    typeInto("input", "Ticker", "DRAM");
    typeInto("input", "Strike", "55");
    typeInto("input", "Fill price", "1.10");
    typeInto("select", "Covered shares", "held");
    typeInto("input", "Share basis", "53");
    typeInto("textarea", "Notes", "Income trade");
    typeInto("input", "Tags", "remove");
    const tagInput = control(render(), "input", "Tags");
    (tagInput.props.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      preventDefault: () => {},
    });
    const remove = elements(render()).find((el) => el.props["aria-label"] === "Remove tag remove");
    if (!remove) throw new Error("Missing remove tag");
    (remove.props.onClick as () => void)();
    typeInto("input", "Tags", "wheel");
    const add = elements(render()).find(
      (el) => el.type === "button" && text(el.props.children) === "Add tag",
    );
    if (!add) throw new Error("Missing Add tag");
    (add.props.onClick as () => void)();
    const adjusted = elements(render()).find(
      (el) => el.type === "input" && el.props.type === "checkbox",
    );
    if (!adjusted) throw new Error("Missing adjusted contract");
    (adjusted.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    await submit();
    expect(createTrade).toHaveBeenCalledWith({
      strategy: "cc",
      underlying: "DRAM",
      openedOn: "2026-09-25",
      expiry: "2026-10-02",
      quantity: 1,
      strike: "55",
      price: "1.10",
      fees: "0.65",
      adjusted: true,
      cover: { kind: "held", basis: "53" },
      tags: ["wheel"],
      notes: "Income trade",
    });
  });

  it("offers journal tickers first and a new uppercase symbol without changing the committed ticker", () => {
    const tree = () =>
      expand(
        <TradeForm
          asOf={parseIsoDate("2026-09-25")}
          options={{ tickers: ["DRAM", "SPY"], tags: [], assignedStock: [] }}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
      );
    (control(tree(), "input", "Ticker").props.onFocus as (event: unknown) => void)({
      target: { select: () => {} },
    });
    const popup = elements(tree()).find((el) => el.props.role === "listbox");
    expect(
      elements(popup)
        .filter((el) => el.props.role === "option")
        .slice(0, 2)
        .map((el) => text(el.props.children)),
    ).toEqual(["DRAM", "SPY"]);
    expect(
      elements(popup)
        .filter((el) => el.type === "legend")
        .map((el) => text(el.props.children)),
    ).toEqual(["In journal", "Suggestions"]);
    (control(tree(), "input", "Ticker").props.onChange as (event: unknown) => void)({
      target: { value: "xyzz" },
    });
    const use = elements(tree()).find((el) => el.props.role === "option");
    expect(text(use?.props.children)).toBe("Use XYZZ");
    (control(tree(), "input", "Ticker").props.onKeyDown as (event: unknown) => void)({
      key: "Escape",
      preventDefault: () => {},
    });
    expect(control(tree(), "input", "Ticker").props.value).toBe("");
  });

  it("resets assigned covered shares only when a different ticker is committed", () => {
    const assignedStock = {
      legId: "00000000-0000-4000-8000-000000000053",
      underlying: "DRAM",
      uncoveredShares: 1500,
      basis: 530000 as Money4,
      assignedOn: parseIsoDate("2026-10-16"),
    };
    const tree = () =>
      expand(
        <TradeForm
          asOf={parseIsoDate("2026-10-16")}
          options={{ tickers: ["DRAM"], tags: [], assignedStock: [assignedStock] }}
          assignedStock={assignedStock}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
      );
    const typeTicker = (value: string) =>
      (control(tree(), "input", "Ticker").props.onChange as (event: unknown) => void)({
        target: { value },
      });
    typeTicker("QQQ");
    (control(tree(), "input", "Ticker").props.onKeyDown as (event: unknown) => void)({
      key: "Escape",
      preventDefault: () => {},
    });
    expect(control(tree(), "select", "Covered shares").props.value).toBe(assignedStock.legId);
    typeTicker("DRAM");
    (control(tree(), "input", "Ticker").props.onBlur as () => void)();
    expect(control(tree(), "select", "Covered shares").props.value).toBe(assignedStock.legId);
    typeTicker("QQQ");
    (control(tree(), "input", "Ticker").props.onBlur as () => void)();
    expect(control(tree(), "select", "Covered shares").props.value).toBe("held");
    expect(control(tree(), "input", "Ticker").props.value).toBe("QQQ");
  });

  it("omits role for strategies without one", async () => {
    vi.mocked(createTrade).mockResolvedValue(undefined as never);
    typeInto("input", "Ticker", "QQQ");
    typeInto("input", "Strike", "600");
    typeInto("input", "Fill price", "1.50");
    expect(roleControls(render())).toHaveLength(0);
    await submit();
    expect(createTrade).toHaveBeenCalledWith(expect.objectContaining({ strategy: "csp" }));
    expect(vi.mocked(createTrade).mock.calls[0]?.[0]).not.toHaveProperty("role");
  });
});

describe("TradeForm dirty signal", () => {
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const render = () =>
    expand(
      <TradeForm
        asOf={parseIsoDate("2026-09-25")}
        options={{ tickers: [], tags: [], assignedStock: [] }}
        onSaved={() => {}}
        onCancel={() => {}}
        onDirtyChange={onDirtyChange}
      />,
    );
  const reported = () => {
    onDirtyChange.mockClear();
    render();
    return onDirtyChange.mock.calls.at(-1)?.[0];
  };
  const control = (type: "input" | "select", label: string) => {
    const labelled = elements(render()).find(
      (el) => el.type === "label" && text(el.props.children).startsWith(label),
    );
    const el = elements(labelled?.props.children).find((child) => child.type === type);
    if (!el) throw new Error(`Missing ${type} ${label}`);
    return el;
  };
  const typeInto = (label: string, value: string) => {
    (control("input", label).props.onChange as (event: unknown) => void)({ target: { value } });
    if (label === "Ticker") (control("input", label).props.onBlur as () => void)();
  };
  const press = (label: string) => {
    const strategy = TRADE_STRATEGIES.find((value) => STRATEGY_LABELS[value] === label);
    if (strategy) {
      chooseStrategy(render, strategy);
      return;
    }
    const button = elements(render()).find(
      (el) => el.type === "button" && text(el.props.children) === label,
    );
    if (!button) throw new Error(`Missing button ${label}`);
    (button.props.onClick as () => void)();
  };

  beforeEach(() => onDirtyChange.mockReset());

  it("reports a pristine form as not dirty", () => {
    expect(reported()).toBe(false);
  });

  it.each([
    ["Ticker", "DRAM"],
    ["Strike", "50"],
    ["Fill price", "1.85"],
    ["Quantity", "2"],
    ["Opened on", "2026-09-24"],
    ["Expiry", "2026-10-09"],
    ["Fees", "9.99"],
    ["Tags", "wheel"],
    ["Share basis", "10"],
  ])("reports a change to %s as dirty", (label, value) => {
    if (label === "Share basis") press(STRATEGY_LABELS.cc);
    if (label === "Expiry") press("Other…");
    typeInto(label, value);
    expect(reported()).toBe(true);
  });

  it("returns to not dirty when an edited field is restored", () => {
    typeInto("Ticker", "DRAM");
    expect(reported()).toBe(true);
    typeInto("Ticker", "");
    expect(reported()).toBe(false);
  });

  it("does not treat a fee typed back to its default as an edit", () => {
    typeInto("Fees", "9.99");
    expect(reported()).toBe(true);
    typeInto("Fees", "0.65");
    expect(reported()).toBe(false);
  });

  it("reports a strategy switch as dirty and switching back as pristine", () => {
    press(STRATEGY_LABELS.stock);
    expect(reported()).toBe(true);
    press(STRATEGY_LABELS.csp);
    expect(reported()).toBe(false);
  });

  it("reports a picked role that differs from the side default as dirty", () => {
    press(STRATEGY_LABELS.long_put);
    expect(reported()).toBe(true);
    press("Swing");
    press(STRATEGY_LABELS.csp);
    expect(reported()).toBe(false);
  });

  it("is optional", () => {
    expect(() =>
      expand(
        <TradeForm
          asOf={parseIsoDate("2026-09-25")}
          options={{ tickers: [], tags: [], assignedStock: [] }}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});

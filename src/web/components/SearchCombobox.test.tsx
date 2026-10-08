import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ComboOption, SearchCombobox } from "./SearchCombobox.tsx";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "combo",
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect(effect: () => void) {
    effect();
  },
}));

type Props = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
}
const choices: ComboOption<string>[] = [
  { value: "put", label: "Long put", detail: "LP", group: "Directional", tone: "debit" },
  { value: "call", label: "Long call", detail: "LC", group: "Directional", tone: "credit" },
  { value: "stock", label: "Stock", group: "Stock" },
];

describe("SearchCombobox", () => {
  let value: string;
  const onPick = vi.fn((next: string) => {
    value = next;
  });
  const render = (free = false, empty = false) => {
    hooks.index = 0;
    return SearchCombobox({
      label: free ? "Ticker" : "Strategy",
      value,
      displayValue: free
        ? value
        : (choices.find((option) => option.value === value)?.label ?? value),
      options: (query) =>
        empty
          ? []
          : choices.filter((option) => option.label.toLowerCase().includes(query.toLowerCase())),
      onPick,
      ...(free ? { freeText: { normalize: (query: string) => query.toUpperCase() } } : {}),
    });
  };
  const input = (free = false, empty = false) => {
    const node = elements(render(free, empty)).find((element) => element.props.role === "combobox");
    if (!node) throw new Error("Missing combobox");
    return node;
  };
  const call = (handler: string, event?: unknown, free = false, empty = false) => {
    (input(free, empty).props[handler] as (event: unknown) => void)(event);
  };
  const key = (name: string, free = false, empty = false) => {
    const preventDefault = vi.fn();
    call("onKeyDown", { key: name, preventDefault }, free, empty);
    return preventDefault;
  };
  const type = (query: string, free = false, empty = false) =>
    call("onChange", { target: { value: query } }, free, empty);
  const focus = () => {
    const select = vi.fn();
    call("onFocus", { target: { select } });
    return select;
  };
  beforeEach(() => {
    hooks.slots = [];
    value = "put";
    onPick.mockClear();
  });

  it("names its input and associates grouped options with the popup", () => {
    expect(focus()).toHaveBeenCalledTimes(1);
    const tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('<label>Strategy<input role="combobox"');
    expect(html).toContain('aria-controls="combo-list"');
    expect(html).toContain('id="combo-list" role="listbox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-labelledby="combo-group-0"');
    expect(html).toContain('class="combo-group">Directional</legend>');
    expect(
      elements(tree)
        .filter((el) => el.props["aria-selected"] === true)
        .map((el) => el.props.id),
    ).toEqual(["combo-option-0"]);
  });

  it("moves the active descendant with arrows, scrolls it and commits on Enter", () => {
    expect(key("ArrowDown")).toHaveBeenCalledTimes(1);
    expect(input().props["aria-activedescendant"]).toBe("combo-option-0");
    expect(key("ArrowDown")).toHaveBeenCalledTimes(1);
    const active = elements(render()).find((el) => el.props.id === "combo-option-1");
    const scrollIntoView = vi.fn();
    (active?.props.ref as { current: unknown }).current = { scrollIntoView };
    render();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(input().props["aria-activedescendant"]).toBe("combo-option-1");
    expect(key("Enter")).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("call");
    expect(input().props.value).toBe("Long call");
    expect(input().props["aria-expanded"]).toBe(false);
  });

  it("wraps in both directions", () => {
    key("ArrowUp");
    expect(input().props["aria-activedescendant"]).toBe("combo-option-2");
    key("ArrowDown");
    expect(input().props["aria-activedescendant"]).toBe("combo-option-0");
    key("ArrowUp");
    key("ArrowUp");
    expect(input().props["aria-activedescendant"]).toBe("combo-option-1");
  });

  it("picks the first filtered strategy result without an arrow", () => {
    type("call");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("call");
    expect(input().props.value).toBe("Long call");
  });

  it("restores a strategy query on Escape or blur without committing", () => {
    type("call");
    key("Escape");
    expect(input().props.value).toBe("Long put");
    type("stock");
    call("onBlur");
    expect(input().props.value).toBe("Long put");
    expect(input().props["aria-expanded"]).toBe(false);
    expect(onPick).toHaveBeenCalledTimes(0);
  });

  it("opens on click after Escape without moving focus", () => {
    focus();
    key("Escape");
    call("onClick");
    expect(input().props["aria-expanded"]).toBe(true);
    expect(input().props["aria-activedescendant"]).toBe(undefined);
  });

  it("prevents mouse blur before picking an option", () => {
    focus();
    const tree = render();
    const option = elements(tree).find((el) => el.props.id === "combo-option-2");
    const popup = elements(tree).find((el) => el.props.role === "listbox");
    if (!option || !popup) throw new Error("Missing Stock option or popup");
    const preventDefault = vi.fn();
    (popup.props.onMouseDown as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    (option.props.onClick as () => void)();
    call("onBlur");
    expect(onPick.mock.calls).toEqual([["stock"]]);
    expect(input().props.value).toBe("Stock");
  });

  it("only associates the input with an existing popup", () => {
    expect(input().props["aria-controls"]).toBe(undefined);
    focus();
    expect(input().props["aria-controls"]).toBe("combo-list");
    key("Escape");
    expect(input().props["aria-controls"]).toBe(undefined);
  });

  it("has no active descendant for empty results", () => {
    type("missing", false, true);
    key("ArrowDown", false, true);
    expect(input(false, true).props["aria-activedescendant"]).toBe(undefined);
    expect(renderToStaticMarkup(render(false, true))).toContain("No matches");
    key("Enter", false, true);
    expect(onPick).toHaveBeenCalledTimes(0);
    expect(key("Tab")).toHaveBeenCalledTimes(0);
    key("Escape");
    expect(key("Enter")).toHaveBeenCalledTimes(0);
  });

  it("normalizes free text on blur but Escape restores the committed symbol", () => {
    value = "SPY";
    type("qqq", true);
    expect(input(true).props.value).toBe("QQQ");
    key("Escape", true);
    expect(input(true).props.value).toBe("SPY");
    expect(onPick).toHaveBeenCalledTimes(0);
    type("dram", true);
    call("onBlur", undefined, true);
    expect(onPick.mock.calls).toEqual([["DRAM"]]);
    call("onBlur", undefined, true);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("commits typed free text with Enter rather than the first suggestion", () => {
    type("l", true);
    key("Enter", true);
    expect(onPick.mock.calls).toEqual([["L"]]);
    expect(input(true).props.value).toBe("L");
  });

  it("picks an arrow-highlighted suggestion with Enter for free text", () => {
    type("l", true);
    key("ArrowDown", true);
    key("Enter", true);
    expect(onPick.mock.calls).toEqual([["put"]]);
  });

  it("closes free text on Enter without picking a suggestion when no query was typed", () => {
    value = "SPY";
    call("onFocus", { target: { select: () => {} } }, true);
    key("Enter", true);
    expect(onPick).toHaveBeenCalledTimes(0);
    expect(input(true).props.value).toBe("SPY");
    expect(input(true).props["aria-expanded"]).toBe(false);
  });

  it("commits free text with Enter when no suggestions match", () => {
    type("xyz", true, true);
    key("Enter", true, true);
    expect(onPick).toHaveBeenCalledWith("XYZ");
    expect(input(true).props["aria-expanded"]).toBe(false);
  });
});

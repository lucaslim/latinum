import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignResponse } from "../../domain/campaign.ts";
import { parseIsoDate as d } from "../../domain/dates.ts";
import { parseMoney4 as m } from "../../domain/money.ts";
import { RollForm } from "./RollForm.tsx";

const hooks = vi.hoisted(() => ({
  slots: new Map<string, unknown[]>(),
  effects: new Map<string, () => void>(),
  seen: new Set<string>(),
  key: "",
  index: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
  useEffect(effect: () => () => void) {
    const key = hooks.key;
    if (!hooks.effects.has(key)) hooks.effects.set(key, effect());
  },
}));

const positionId = "00000000-0000-4000-8000-000000000001";
const longId = "00000000-0000-4000-8000-000000000002";
const shortId = "00000000-0000-4000-8000-000000000003";
const revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const campaign: CampaignResponse = {
  id: "campaign",
  title: "QQQ hedge",
  openedOn: d("2026-09-15"),
  closedOn: null,
  notes: null,
  asOf: d("2026-10-01"),
  assignments: [],
  positions: [
    {
      id: positionId,
      revision,
      underlying: "QQQ",
      strategy: "put_debit_spread",
      role: "hedge",
      openedOn: d("2026-09-15"),
      closedOn: null,
      notes: null,
      tags: [],
      legs: [
        {
          id: longId,
          kind: "put",
          side: "long",
          underlying: "QQQ",
          strike: m("670"),
          expiry: d("2026-10-16"),
          multiplier: 100,
          adjusted: false,
          mark: null,
          trades: [
            {
              id: "long-open",
              action: "open",
              tradeDate: d("2026-09-15"),
              quantity: 2,
              price: m("0.70"),
              cash: m("-140"),
              fees: m("0"),
            },
          ],
        },
        {
          id: shortId,
          kind: "put",
          side: "short",
          underlying: "QQQ",
          strike: m("665"),
          expiry: d("2026-10-16"),
          multiplier: 100,
          adjusted: false,
          mark: null,
          trades: [
            {
              id: "short-open",
              action: "open",
              tradeDate: d("2026-09-15"),
              quantity: 2,
              price: m("0"),
              cash: m("0"),
              fees: m("0"),
            },
          ],
        },
      ],
    },
  ],
};

type ElementProps = { children?: ReactNode; [key: string]: unknown };
function expand(node: ReactNode, path = "root"): ReactNode {
  if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`));
  if (!isValidElement<ElementProps>(node)) return node;
  if (typeof node.type === "function") {
    hooks.key = `${path}/${node.type.name}:${node.key}`;
    hooks.index = 0;
    hooks.seen.add(hooks.key);
    return expand((node.type as (props: ElementProps) => ReactNode)(node.props), hooks.key);
  }
  return cloneElement(node, {}, expand(node.props.children, `${path}/children`));
}
function renderTree(node: ReactNode): ReactNode {
  hooks.seen.clear();
  const tree = expand(node);
  for (const [key, cleanup] of hooks.effects) {
    if (!hooks.seen.has(key)) {
      cleanup();
      hooks.effects.delete(key);
    }
  }
  return tree;
}
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<ElementProps>(node) ? [node, ...elements(node.props.children)] : [];
}
const content = (node: ReactNode) =>
  renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
function find(node: ReactNode, type: string, label: string) {
  const el = elements(node).find(
    (el) =>
      el.type === type &&
      (el.props["aria-label"] === label ||
        el.props.name === label ||
        content(el.props.children).trim() === label),
  );
  if (!el) throw new Error(`Missing ${type} ${label}`);
  return el;
}
function click(node: ReactNode, label: string) {
  (find(node, "button", label).props.onClick as () => void)();
}
function change(node: ReactNode, name: string, value: string) {
  (find(node, "input", name).props.onChange as (event: unknown) => void)({ target: { value } });
}
function setup(data = campaign, save = vi.fn().mockResolvedValue({})) {
  const render = () => renderTree(<RollForm campaign={data} onSave={save} />);
  click(render(), "Roll options");
  return { render, save };
}
function qqqFills(render: () => ReactNode) {
  change(render(), `closePrice-${longId}`, "0.42");
  change(render(), `openPrice-${longId}`, "0.77");
  change(render(), `closePrice-${shortId}`, "0");
  change(render(), `openPrice-${shortId}`, "0");
}
beforeEach(() => {
  hooks.slots.clear();
  hooks.effects.clear();
});

describe("RollForm", () => {
  it("offers exactly six expiry chips strictly after current expiry and keeps quantity fixed", () => {
    const { render } = setup();
    const choices = elements(render()).find(
      (el) => el.props["aria-label"] === "Roll expiry quick choices",
    );
    expect(
      elements(choices)
        .filter((el) => el.type === "button")
        .map((el) => el.props["aria-label"]),
    ).toEqual([
      "2026-10-23",
      "2026-10-30",
      "2026-11-06",
      "2026-11-13",
      "2026-11-20 M",
      "2026-11-27",
    ]);
    expect(content(render())).toContain("2 contracts");
    expect(
      elements(render()).filter((el) => el.type === "input" && el.props.type === "number"),
    ).toHaveLength(0);
    expect(find(render(), "input", `closeFees-${longId}`).props.value).toBe("1.30");
  });

  it("holiday-adjusts Good Friday and permits manual expiry beyond calendar coverage", () => {
    const fixture: CampaignResponse = {
      ...campaign,
      positions: campaign.positions.map((p) => ({
        ...p,
        legs: p.legs.map((l) => ({ ...l, expiry: d("2026-03-27") })),
      })),
    };
    const { render } = setup(fixture);
    expect(find(render(), "button", "2026-04-02").props["aria-label"]).toBe("2026-04-02");
    hooks.slots.clear();
    const late: CampaignResponse = {
      ...campaign,
      positions: campaign.positions.map((p) => ({
        ...p,
        legs: p.legs.map((l) => ({ ...l, expiry: d("2028-12-29") })),
      })),
    };
    const manual = setup(late).render;
    expect(content(manual())).toContain("Enter an expiry date manually");
    expect(find(manual(), "input", "expiry").props.type).toBe("date");
  });

  it("updates gross/net lines from the real roll preview and T3 new spread metrics", () => {
    const { render } = setup();
    qqqFills(render);
    expect(content(render())).toContain("Closing realized gross −$56.00");
    expect(content(render())).toContain("Closing realized net −$58.60");
    expect(content(render())).toContain("Roll cash gross −$70.00");
    expect(content(render())).toContain("Roll cash net −$75.20");
    expect(content(render())).toContain("Chain cash gross −$210.00");
    expect(content(render())).toContain("Chain cash net −$215.20");
    expect(content(render())).toContain("New max payout $1,000.00");
    expect(content(render())).toContain("New return on risk 549.4%");
    change(render(), `closePrice-${longId}`, "0.50");
    expect(content(render())).toContain("Closing realized gross −$40.00");
    expect(content(render())).toContain("Roll cash gross −$54.00");
  });

  it("serializes one atomic position roll with both spread constituents and editable zero fees", async () => {
    const { render, save } = setup();
    qqqFills(render);
    for (const id of [longId, shortId]) {
      change(render(), `closeFees-${id}`, "0");
      change(render(), `openFees-${id}`, "0");
    }
    click(render(), "2026-11-06");
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(save).toHaveBeenCalledExactlyOnceWith(positionId, {
      action: "roll",
      input: {
        positionId,
        expectedRevision: revision,
        tradeDate: "2026-10-01",
        expiry: "2026-11-06",
        fills: [
          {
            legId: longId,
            closePrice: "0.42",
            closeFees: "0.0000",
            strike: "670.0000",
            openPrice: "0.77",
            openFees: "0.0000",
          },
          {
            legId: shortId,
            closePrice: "0",
            closeFees: "0.0000",
            strike: "665.0000",
            openPrice: "0",
            openFees: "0.0000",
          },
        ],
      },
    });
  });

  it("selects an option POSITION, never an individual spread leg, and excludes stock", async () => {
    const first = campaign.positions[0];
    if (!first) throw new Error("Missing spread");
    const multi: CampaignResponse = {
      ...campaign,
      positions: [
        first,
        { ...first, id: "00000000-0000-4000-8000-000000000004", underlying: "SECOND" },
        {
          ...first,
          id: "stock",
          strategy: "stock",
          role: "swing",
          legs: first.legs.map((l) => ({ ...l, kind: "stock", strike: null, expiry: null })),
        },
      ],
    };
    const { render, save } = setup(multi);
    const picker = elements(render()).find((el) => el.props["aria-label"] === "Position to roll");
    const options = elements(picker).filter((el) => el.type === "button");
    expect(options).toHaveLength(2);
    expect(content(picker)).toContain("QQQ");
    expect(content(picker)).not.toContain("stock");
    const second = options[1];
    if (!second) throw new Error("Missing second position choice");
    (second.props.onClick as () => void)();
    expect(content(render())).toContain("Roll SECOND");
    expect(
      elements(render()).filter(
        (el) => el.type === "input" && String(el.props.name).startsWith("closePrice-"),
      ),
    ).toHaveLength(2);
    qqqFills(render);
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toBe("00000000-0000-4000-8000-000000000004");
    expect(
      save.mock.calls[0]?.[1].input.fills.map((fill: { legId: string }) => fill.legId),
    ).toEqual([longId, shortId]);
  });

  it("does not offer stock rolls and excludes held CC backing shares from fills", async () => {
    const first = campaign.positions[0];
    const short = first?.legs[1];
    if (!first || !short) throw new Error("Missing fixture");
    const stock = {
      ...short,
      id: "stock-leg",
      kind: "stock" as const,
      side: "long" as const,
      strike: null,
      expiry: null,
      multiplier: 1,
      trades: [
        {
          id: "stock-open",
          action: "open" as const,
          tradeDate: d("2026-09-15"),
          quantity: 200,
          price: m("660"),
          cash: m("-132000"),
          fees: m("0"),
        },
      ],
    };
    const stockOnly: CampaignResponse = {
      ...campaign,
      positions: [{ ...first, strategy: "stock", role: "swing", legs: [stock] }],
    };
    expect(content(expand(<RollForm campaign={stockOnly} onSave={vi.fn()} />))).toBe("");
    hooks.slots.clear();
    const held: CampaignResponse = {
      ...campaign,
      positions: [
        {
          ...first,
          strategy: "cc",
          role: "income",
          legs: [{ ...short, kind: "call", coveredLegId: null }, stock],
        },
      ],
    };
    const { render, save } = setup(held);
    change(render(), `openPrice-${shortId}`, "1.10");
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(save.mock.calls[0]?.[1].input.fills).toEqual([
      {
        legId: shortId,
        closePrice: "0.0000",
        closeFees: "-1.3000",
        strike: "665.0000",
        openPrice: "1.10",
        openFees: "-1.3000",
      },
    ]);
  });

  it.each(["long_call", "long_put"] as const)(
    "renders T3 %s metrics and rejects a zero-cost replacement like the API",
    (strategy) => {
      const first = campaign.positions[0];
      const long = first?.legs[0];
      if (!first || !long) throw new Error("Missing option fixture");
      const option: CampaignResponse = {
        ...campaign,
        positions: [
          {
            ...first,
            strategy,
            role: "swing",
            legs: [{ ...long, kind: strategy === "long_call" ? "call" : "put" }],
          },
        ],
      };
      const { render } = setup(option);
      expect(content(render())).toContain("New collateral $140.00");
      expect(content(render())).toContain(
        strategy === "long_call" ? "New max profit Unlimited" : "New max profit $133,860.00",
      );
      change(render(), `openPrice-${longId}`, "0");
      expect(find(render(), "button", "Save roll").props.disabled).toBe(true);
      expect(content(render())).toContain("Must be greater than zero");
    },
  );

  it.each([
    ["reversed strikes", `strike-${longId}`, "660", "Strikes are reversed"],
    [
      "excessive debit",
      `openPrice-${longId}`,
      "6",
      "Net premium must be between zero and spread width",
    ],
    ["zero debit", `openPrice-${longId}`, "0", "Net premium must be between zero and spread width"],
  ])(
    "rejects %s before showing replacement metrics or saving",
    async (_label, field, value, message) => {
      const { render, save } = setup();
      change(render(), field, value);
      expect(find(render(), "button", "Save roll").props.disabled).toBe(true);
      expect(content(render())).toContain(message);
      expect(content(render())).not.toContain("New max profit");
      await (
        find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>
      )({ preventDefault: vi.fn() });
      expect(save).toHaveBeenCalledTimes(0);
    },
  );

  it.each([
    [29, "71.05", "$1,595.00"],
    [7, "17.15", "$385.00"],
  ] as const)(
    "uses integer deliverable units for an adjusted CSP with multiplier %s",
    (multiplier, cash, collateral) => {
      const first = campaign.positions[0];
      const short = first?.legs[1];
      if (!first || !short) throw new Error("Missing option fixture");
      const adjusted: CampaignResponse = {
        ...campaign,
        positions: [
          {
            ...first,
            strategy: "csp",
            role: "income",
            underlying: "TQQQ",
            legs: [
              {
                ...short,
                underlying: "TQQQ",
                multiplier,
                adjusted: true,
                strike: m("55"),
                trades: [
                  {
                    id: "adjusted-open",
                    action: "open",
                    tradeDate: d("2026-09-15"),
                    quantity: 1,
                    price: m("2.45"),
                    cash: m(cash),
                    fees: m("0"),
                  },
                ],
              },
            ],
          },
        ],
      };
      const { render } = setup(adjusted);
      change(render(), `closePrice-${shortId}`, "3.19");
      change(render(), `openPrice-${shortId}`, "3.54");
      expect(find(render(), "button", "Save roll").props.disabled).toBe(false);
      expect(content(render())).toContain(`New collateral ${collateral}`);
      expect(content(render())).toContain("New breakeven $51.46");
      expect(content(render())).not.toContain("Amount exceeds Money4 precision");
      expect(content(render())).toContain("New leg yield 6.44%");
    },
  );

  it("normalizes adjusted spread monetary metrics without fractional contracts", () => {
    const adjusted: CampaignResponse = {
      ...campaign,
      positions: campaign.positions.map((position) => ({
        ...position,
        legs: position.legs.map((leg) => ({
          ...leg,
          multiplier: 29,
          adjusted: true,
          trades: leg.trades.map((trade) => ({
            ...trade,
            quantity: 1,
            cash: m(leg.side === "long" ? "-20.30" : "0"),
          })),
        })),
      })),
    };
    const { render } = setup(adjusted);
    qqqFills(render);
    expect(find(render(), "button", "Save roll").props.disabled).toBe(false);
    expect(content(render())).toContain("New collateral $22.33");
    expect(content(render())).toContain("New max payout $145.00");
    expect(content(render())).toContain("New max profit $122.67");
    expect(content(render())).toContain("New return on risk 549.4%");
  });

  it("defaults TQQQ fills to entry, then previews explicit prototype acceptance fills", () => {
    const first = campaign.positions[0];
    const short = first?.legs[1];
    if (!first || !short) throw new Error("Missing fixture");
    const tqqq: CampaignResponse = {
      ...campaign,
      positions: [
        {
          ...first,
          underlying: "TQQQ",
          strategy: "csp",
          role: "income",
          legs: [
            {
              ...short,
              underlying: "TQQQ",
              strike: m("55"),
              expiry: d("2026-10-23"),
              trades: [
                {
                  id: "open",
                  action: "open",
                  tradeDate: d("2026-09-24"),
                  quantity: 20,
                  price: m("2.45"),
                  cash: m("4900"),
                  fees: m("0"),
                },
              ],
            },
          ],
        },
      ],
    };
    const { render } = setup(tqqq);
    expect(find(render(), "input", `closePrice-${shortId}`).props.value).toBe("2.4500");
    expect(find(render(), "input", `openPrice-${shortId}`).props.value).toBe("2.4500");
    change(render(), `closePrice-${shortId}`, "3.19");
    change(render(), `openPrice-${shortId}`, "3.54");
    expect(find(render(), "input", "expiry").props.value).toBe("2026-11-06");
    expect(content(render())).toContain("Closing realized gross −$1,480.00");
    expect(content(render())).toContain("Roll cash gross +$700.00");
    expect(content(render())).toContain("New collateral $110,000.00");
    expect(content(render())).toContain("New breakeven $51.46");
  });

  it("blocks invalid input, duplicate pending submissions, and exposes API errors without discarding fields", async () => {
    let reject: (error: Error) => void = () => {
      throw new Error("Missing pending save");
    };
    const saving = new Promise((_, fail) => {
      reject = fail;
    });
    const { render, save } = setup(campaign, vi.fn().mockReturnValue(saving));
    qqqFills(render);
    change(render(), `openFees-${longId}`, "-1");
    expect(find(render(), "button", "Save roll").props.disabled).toBe(true);
    change(render(), `openFees-${longId}`, "1.30");
    const submit = find(render(), "form", "Roll position").props.onSubmit as (
      e: unknown,
    ) => Promise<void>;
    const done = submit({ preventDefault: vi.fn() });
    await submit({ preventDefault: vi.fn() });
    expect(save).toHaveBeenCalledTimes(1);
    expect(content(render())).toContain("Saving roll…");
    expect(find(render(), "button", "Save roll").props.disabled).toBe(true);
    reject(new Error("Invalid strikes (HTTP 400)"));
    await done;
    expect(content(render())).toContain("Invalid strikes (HTTP 400)");
    expect(find(render(), "input", `closePrice-${longId}`).props.value).toBe("0.42");
    expect(find(render(), "button", "Save roll").props.disabled).toBe(false);
  });

  it("releases campaign pending after successful refresh replaces the editor and permits another roll", async () => {
    let current = campaign;
    const save = vi.fn().mockImplementation(async () => {
      current = {
        ...campaign,
        positions: campaign.positions.map((p) => ({
          ...p,
          revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })),
      };
      render();
      return {};
    });
    const render = () => renderTree(<RollForm campaign={current} onSave={save} />);
    click(render(), "Roll options");
    qqqFills(render);
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(find(render(), "button", "Roll options").props.disabled).toBe(false);
    expect(find(render(), "button", "Save roll").props.disabled).toBe(false);
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("closes the editor after a roll refresh replaces the source ID instead of choosing another position", async () => {
    const first = campaign.positions[0];
    if (!first) throw new Error("Missing source position");
    let current = campaign;
    const unrelated = {
      ...first,
      id: "00000000-0000-4000-8000-000000000010",
      underlying: "NVDA",
      legs: first.legs.map((leg, index) => ({
        ...leg,
        id: `00000000-0000-4000-8000-00000000001${index + 1}`,
        underlying: "NVDA",
      })),
    };
    const replacement = {
      ...first,
      id: "00000000-0000-4000-8000-000000000020",
      openedOn: d("2026-10-01"),
      legs: first.legs.map((leg, index) => ({
        ...leg,
        id: `00000000-0000-4000-8000-00000000002${index + 1}`,
        expiry: d("2026-11-06"),
        trades: [
          {
            id: `replacement-${index}`,
            action: "open" as const,
            tradeDate: d("2026-10-01"),
            quantity: 2,
            price: m(leg.side === "long" ? "0.77" : "0"),
            cash: m(leg.side === "long" ? "-154" : "0"),
            fees: m("0"),
          },
        ],
      })),
    };
    const save = vi.fn().mockImplementation(async () => {
      current = {
        ...campaign,
        positions: [
          {
            ...first,
            closedOn: d("2026-10-01"),
            legs: first.legs.map((leg) => ({
              ...leg,
              trades: [
                ...leg.trades,
                {
                  id: `close-${leg.id}`,
                  action: "close" as const,
                  tradeDate: d("2026-10-01"),
                  quantity: 2,
                  price: m(leg.side === "long" ? "0.42" : "0"),
                  cash: m(leg.side === "long" ? "84" : "0"),
                  fees: m("0"),
                },
              ],
            })),
          },
          unrelated,
          replacement,
        ],
      };
      render();
      return {};
    });
    const render = () => renderTree(<RollForm campaign={current} onSave={save} />);
    click(render(), "Roll options");
    qqqFills(render);
    await (find(render(), "form", "Roll position").props.onSubmit as (e: unknown) => Promise<void>)(
      { preventDefault: vi.fn() },
    );
    expect(elements(render()).filter((el) => el.type === "form")).toHaveLength(0);
    expect(find(render(), "button", "Roll options").props.disabled).toBe(false);
    click(render(), "Roll options");
    expect(content(render())).toContain("Roll NVDA");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("resets old fill intent when the displayed position revision changes", () => {
    const { render } = setup();
    change(render(), `closePrice-${longId}`, "9.99");
    const refreshed: CampaignResponse = {
      ...campaign,
      positions: campaign.positions.map((p) => ({
        ...p,
        revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })),
    };
    const node = expand(<RollForm campaign={refreshed} onSave={vi.fn()} />);
    expect(find(node, "input", `closePrice-${longId}`).props.value).toBe("0.7000");
  });
});

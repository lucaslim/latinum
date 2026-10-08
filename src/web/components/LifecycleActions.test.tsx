import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nvdlCampaign } from "../../domain/test/campaignFixtures.ts";
import { LifecycleActions } from "./LifecycleActions.tsx";

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const index = state.index++;
    if (!(index in state.values))
      state.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      state.values[index],
      (value: unknown) => {
        state.values[index] = typeof value === "function" ? value(state.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: vi.fn(),
}));

import { type LifecycleMutation, saveLifecycle } from "../lifecycleApi.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Lifecycle transport", () => {
  const mutations: LifecycleMutation[] = [
    {
      action: "close",
      input: {
        expectedRevision: "R0",
        fills: [{ legId: "spxl-leg", quantity: 2, price: "0.4000", fees: "-1.30" }],
        tradeDate: "2026-10-16",
      },
    },
    { action: "expire", input: { expectedRevision: "R0" } },
    { action: "assign", input: { expectedRevision: "R0", legId: "dram-leg" } },
    { action: "link-hedge", input: { expectedRevision: "R0", campaignId: "target" } },
  ];
  for (const mutation of mutations) {
    it(`POSTs ${mutation.action} exactly once as private uncached JSON`, async () => {
      const result =
        mutation.action === "link-hedge"
          ? { positionId: "position", campaignId: "target" }
          : {
              positionId: "position",
              campaignId: "campaign",
              closedOn: null,
              tradeIds: [],
              realized: [],
            };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
      vi.stubGlobal("fetch", fetchMock);
      const signal = new AbortController().signal;
      expect(await saveLifecycle("position/id", mutation, signal)).toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`/api/positions/position%2Fid/${mutation.action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(mutation.input),
        signal,
      });
    });
  }
  it("shows an API rejection rather than retrying a mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Position is already closed" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveLifecycle(
        "position",
        { action: "expire", input: { expectedRevision: "R0" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Position is already closed (HTTP 409)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["", '{"error":', "<html>Proxy error</html>"])(
    "retains HTTP status when a JSON-labelled rejection has an invalid body: %s",
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(body, {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        saveLifecycle(
          "position",
          { action: "expire", input: { expectedRevision: "R0" } },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        message: "Could not save lifecycle action (HTTP 502)",
        status: 502,
        cause: expect.any(SyntaxError),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["null", "7", '{"error":123}'])(
    "uses the status-bearing fallback for a rejection without a string error: %s",
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(body, {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        saveLifecycle(
          "position",
          { action: "expire", input: { expectedRevision: "R0" } },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Could not save lifecycle action (HTTP 409)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("uses the HTTP fallback for a non-JSON rejection without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Proxy error", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveLifecycle(
        "position",
        { action: "expire", input: { expectedRevision: "R0" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Could not save lifecycle action (HTTP 502)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("leaves network uncertainty explicit and never retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveLifecycle(
        "position",
        { action: "expire", input: { expectedRevision: "R0" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Lifecycle revisions", () => {
  function findSubmit(node: ReactNode): ((event: unknown) => Promise<void>) | undefined {
    if (Array.isArray(node)) {
      for (const child of node) {
        const submit = findSubmit(child);
        if (submit) return submit;
      }
    } else if (
      isValidElement<{ children?: ReactNode; onSubmit?: (event: unknown) => Promise<void> }>(node)
    ) {
      if (node.type === "form") return node.props.onSubmit;
      return findSubmit(node.props.children);
    }
    return undefined;
  }

  it.each(["close", "expire", "assign", "link-hedge"] as const)(
    "%s builds its request from the displayed position revision",
    async (action) => {
      const fixture = nvdlCampaign.positions[action === "link-hedge" ? 2 : 0];
      if (!fixture) throw new Error("Missing lifecycle fixture position");
      const position = { ...fixture, revision: "R0" };
      const legId = position.legs[0]?.id;
      if (!legId) throw new Error("Missing lifecycle fixture leg");
      state.values = [{ action, legId }, [legId], false, null];
      state.index = 0;
      const fields = new Map([
        ["tradeDate", "2026-10-16"],
        ["fees", "2.00"],
        ["campaignId", "target"],
        [`quantity-${legId}`, "5"],
        [`price-${legId}`, "0.40"],
        [`fees-${legId}`, "1.30"],
      ]);
      vi.stubGlobal(
        "FormData",
        class {
          get(name: string) {
            return fields.get(name);
          }
        },
      );
      const onSave = vi.fn().mockResolvedValue({});
      const submit = findSubmit(LifecycleActions({ position, onSave }));
      if (!submit) throw new Error("Lifecycle form was not rendered");
      await submit({ preventDefault: vi.fn(), currentTarget: {} });
      const input =
        action === "close"
          ? {
              expectedRevision: "R0",
              tradeDate: "2026-10-16",
              fills: [{ legId, quantity: 5, price: "0.40", fees: "-1.3000" }],
            }
          : action === "expire"
            ? { expectedRevision: "R0", tradeDate: "2026-10-16" }
            : action === "assign"
              ? { expectedRevision: "R0", tradeDate: "2026-10-16", legId, fees: "-2.0000" }
              : { expectedRevision: "R0", campaignId: "target" };
      expect(onSave).toHaveBeenCalledExactlyOnceWith(position.id, { action, input });
    },
  );

  function findInputs(node: ReactNode, found: Record<string, unknown>[] = []) {
    if (Array.isArray(node)) {
      for (const child of node) findInputs(child, found);
    } else if (isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === "input") found.push(node.props as Record<string, unknown>);
      findInputs(node.props.children, found);
    }
    return found;
  }

  it("defaults close fees to $0.65 per open contract and assignment fees to zero", () => {
    const fixture = nvdlCampaign.positions[0];
    const leg = fixture?.legs[0];
    if (!fixture || !leg) throw new Error("Missing lifecycle fixture");
    const render = (action: "close" | "assign") => {
      state.values = [{ action, legId: leg.id }, [leg.id], false, null];
      state.index = 0;
      return findInputs(LifecycleActions({ position: fixture, onSave: vi.fn() }));
    };
    const closeFees = render("close").find((input) => input.name === `fees-${leg.id}`);
    const assignFees = render("assign").find((input) => input.name === "fees");
    expect(closeFees?.value).toBe("3.25");
    expect(assignFees?.defaultValue).toBe("0");
    for (const input of [closeFees, assignFees]) {
      const accepts = (value: string) => new RegExp(`^(?:${String(input?.pattern)})$`).test(value);
      expect(accepts("1.30")).toBe(true);
      expect(accepts("-1.30")).toBe(false);
    }
  });

  it("defaults closing 100 stock shares to zero rather than an option contract fee", () => {
    const fixture = nvdlCampaign.positions[0];
    const leg = fixture?.legs[0];
    if (!fixture || !leg) throw new Error("Missing lifecycle fixture");
    const stock = {
      ...leg,
      kind: "stock" as const,
      strike: null,
      expiry: null,
      multiplier: 1,
      trades: leg.trades.map((trade) => ({ ...trade, quantity: 100 })),
    };
    state.values = [{ action: "close" }, [leg.id], false, null];
    state.index = 0;
    const inputs = findInputs(
      LifecycleActions({ position: { ...fixture, legs: [stock] }, onSave: vi.fn() }),
    );
    expect(inputs.find((input) => input.name === `quantity-${leg.id}`)?.defaultValue).toBe(100);
    expect(inputs.find((input) => input.name === `fees-${leg.id}`)?.value).toBe("0.00");
  });

  it.each(["close", "assign"] as const)(
    "%s shows fee conversion errors without saving or leaving the form pending",
    async (action) => {
      const position = nvdlCampaign.positions[0];
      const leg = position?.legs[0];
      if (!position || !leg) throw new Error("Missing lifecycle fixture");
      state.values = [{ action, legId: leg.id }, [leg.id], false, null];
      const render = () => {
        state.index = 0;
        return LifecycleActions({ position, onSave });
      };
      const onSave = vi.fn();
      const fields = new Map([
        ["fees", "1000000000000"],
        [`quantity-${leg.id}`, "5"],
        [`price-${leg.id}`, "0.40"],
        [`fees-${leg.id}`, "1000000000000"],
      ]);
      vi.stubGlobal(
        "FormData",
        class {
          get(name: string) {
            return fields.get(name);
          }
        },
      );
      const submit = findSubmit(render());
      if (!submit) throw new Error("Missing lifecycle form");
      await submit({ preventDefault: vi.fn(), currentTarget: {} });
      expect(onSave).toHaveBeenCalledTimes(0);
      const html = renderToStaticMarkup(render());
      expect(html).toContain('role="alert"');
      expect(html).toContain("USD amount out of range: 1000000000000");
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('disabled=""');
    },
  );

  it("makes an unedited close fee follow the closing quantity until the fee is typed in", () => {
    const fixture = nvdlCampaign.positions[0];
    const leg = fixture?.legs[0];
    if (!fixture || !leg) throw new Error("Missing lifecycle fixture");
    const render = () => {
      state.index = 0;
      return findInputs(LifecycleActions({ position: fixture, onSave: vi.fn() }));
    };
    const field = (name: string) => {
      const input = render().find((candidate) => candidate.name === name);
      if (!input) throw new Error(`Missing input ${name}`);
      return input;
    };
    const type = (name: string, value: string) => {
      const onChange = field(name).onChange as ((event: unknown) => void) | undefined;
      if (!onChange) throw new Error(`Input ${name} is not tracked`);
      onChange({ target: { value } });
    };
    state.values = [{ action: "close" }, [leg.id], false, null];
    expect(field(`fees-${leg.id}`).value).toBe("3.25");
    type(`quantity-${leg.id}`, "2");
    expect(field(`fees-${leg.id}`).value).toBe("1.30");
    type(`quantity-${leg.id}`, "");
    expect(field(`fees-${leg.id}`).value).toBe("1.30");
    type(`fees-${leg.id}`, "9.99");
    type(`quantity-${leg.id}`, "4");
    expect(field(`fees-${leg.id}`).value).toBe("9.99");
  });

  it.each([
    ["stale_revision", "stale_revision"],
    ["another_code", undefined],
    [123, undefined],
    [null, undefined],
    [{ value: "stale_revision" }, undefined],
    [undefined, undefined],
  ])("only recognizes the known string code %j", async (code, expectedCode) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "Position changed", code }, { status: 409 })),
    );
    await expect(
      saveLifecycle(
        "position",
        { action: "expire", input: { expectedRevision: "R0" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: expectedCode,
      message: "Position changed (HTTP 409)",
    });
  });
});

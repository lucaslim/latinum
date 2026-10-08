import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nvdlCampaign } from "../domain/test/campaignFixtures.ts";
import { useCampaign } from "./campaignApi.ts";
import { type LifecycleMutation, saveLifecycle } from "./lifecycleApi.ts";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  active: { current: null as unknown },
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useRef() {
    return hooks.active;
  },
  useEffect(effect: () => () => void) {
    hooks.cleanup?.();
    hooks.cleanup = effect();
  },
}));

beforeEach(() => {
  hooks.states = [];
  hooks.index = 0;
  hooks.active.current = null;
});
afterEach(() => {
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  vi.unstubAllGlobals();
});
const campaign = {
  id: "campaign",
  title: "MUU",
  openedOn: "2026-09-15",
  closedOn: null,
  asOf: "2026-10-16",
  notes: null,
  positions: [],
  assignments: [],
};
const roll: LifecycleMutation = {
  action: "roll",
  input: {
    positionId: "position",
    expectedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tradeDate: "2026-10-01",
    expiry: "2026-11-06",
    fills: [
      {
        legId: "leg",
        closePrice: "0.42",
        closeFees: "0",
        strike: "670",
        openPrice: "0.77",
        openFees: "0",
      },
    ],
  },
};

test("roll posts the position-bearing contract to /api/rolls, not a positions URL", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ rollId: "roll", newPositionId: "new" }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(saveLifecycle("position", roll, signal)).resolves.toEqual({
    rollId: "roll",
    newPositionId: "new",
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/rolls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(roll.input),
    signal,
  });
});

test("roll refuses a mismatched position ID before issuing a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(saveLifecycle("another", roll, new AbortController().signal)).rejects.toThrow(
    "Roll position does not match",
  );
  expect(fetch).toHaveBeenCalledTimes(0);
});

test.each(["network", "502", "unreadable", "refresh", "stale"])(
  "roll %s removes the ready snapshot and blocks every lifecycle mutation",
  async (failure) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(campaign));
    if (failure === "network") fetch.mockRejectedValueOnce(new Error("Connection lost"));
    else if (failure === "502")
      fetch.mockResolvedValueOnce(Response.json({ error: "Proxy failed" }, { status: 502 }));
    else if (failure === "unreadable") fetch.mockResolvedValueOnce(new Response(""));
    else if (failure === "stale")
      fetch.mockResolvedValueOnce(
        Response.json({ error: "Position changed", code: "stale_revision" }, { status: 409 }),
      );
    else
      fetch
        .mockResolvedValueOnce(Response.json(result))
        .mockRejectedValueOnce(new Error("Refresh failed"));
    vi.stubGlobal("fetch", fetch);
    const actions = useCampaign("campaign");
    await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
    await expect(actions.saveLifecycle("position", roll)).rejects.toThrow(
      failure === "stale"
        ? "Position changed"
        : failure === "refresh"
          ? "Lifecycle action was saved"
          : "Lifecycle action outcome is uncertain",
    );
    expect(hooks.states[0]).toEqual({
      status: "error",
      message: expect.stringContaining("Reload the campaign"),
    });
    await expect(actions.saveLifecycle("position", roll)).rejects.toThrow(
      "Campaign is no longer active",
    );
    await expect(
      actions.saveLifecycle("position", { action: "expire", input: { expectedRevision: "R0" } }),
    ).rejects.toThrow("Campaign is no longer active");
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toBe("/api/rolls");
  },
);

test("an ordinary roll rejection permits correction without rewriting its revision", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockResolvedValueOnce(Response.json({ error: "Invalid strikes" }, { status: 400 }))
    .mockResolvedValueOnce(Response.json(result))
    .mockResolvedValueOnce(Response.json(campaign));
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  await expect(actions.saveLifecycle("position", roll)).rejects.toThrow("Invalid strikes");
  expect(hooks.states[0]).toEqual({ status: "ready", data: campaign });
  await expect(actions.saveLifecycle("position", roll)).resolves.toEqual(result);
  expect(
    fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([url, init]) => [url, JSON.parse(init.body)]),
  ).toEqual([
    ["/api/rolls", roll.input],
    ["/api/rolls", roll.input],
  ]);
});

const revisionPosition = nvdlCampaign.positions[0];
if (!revisionPosition) throw new Error("Missing lifecycle fixture position");
const result = {
  positionId: "position",
  campaignId: "campaign",
  closedOn: null,
  tradeIds: ["close"],
  realized: [
    {
      tradeId: "close",
      quantity: 5,
      openingCash: 7500000,
      openingFees: -33000,
      pnl: 7467000,
      bookedMonth: "2026-10",
    },
  ],
};

test("saved mutation with failed refresh removes stale ready state and blocks another POST until retry", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockResolvedValueOnce(Response.json(result))
    .mockRejectedValueOnce(new Error("Refresh interrupted"))
    .mockResolvedValueOnce(Response.json(campaign));
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  await expect(
    actions.saveLifecycle("position", {
      action: "close",
      input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
    }),
  ).rejects.toThrow("Lifecycle action was saved");
  expect(hooks.states[0]).toEqual({
    status: "error",
    message:
      "Lifecycle action was saved, but campaign refresh failed. Reload the campaign before another action.",
  });
  await expect(
    actions.saveLifecycle("position", {
      action: "close",
      input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
    }),
  ).rejects.toThrow("Campaign is no longer active");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  actions.retry();
  hooks.index = 0;
  useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  expect(fetch).toHaveBeenCalledTimes(4);
});

test.each(["lost response", "unreadable success", "server failure"])(
  "an uncertain mutation outcome (%s) blocks stale actions until a read-only retry",
  async (failure) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(campaign));
    if (failure === "lost response") fetch.mockRejectedValueOnce(new Error("Connection lost"));
    else
      fetch.mockResolvedValueOnce(
        new Response(failure === "unreadable success" ? "" : "Proxy error", {
          status: failure === "unreadable success" ? 200 : 502,
          headers: { "Content-Type": "application/json" },
        }),
      );
    fetch.mockResolvedValueOnce(Response.json(campaign));
    vi.stubGlobal("fetch", fetch);
    const actions = useCampaign("campaign");
    await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
    await expect(
      actions.saveLifecycle("position", {
        action: "close",
        input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
      }),
    ).rejects.toThrow("Lifecycle action outcome is uncertain");
    expect(hooks.states[0]).toEqual({
      status: "error",
      message:
        failure === "server failure"
          ? "Lifecycle action outcome is uncertain (HTTP 502). Reload the campaign before another action."
          : "Lifecycle action outcome is uncertain. Reload the campaign before another action.",
    });
    await expect(
      actions.saveLifecycle("position", { action: "expire", input: { expectedRevision: "R0" } }),
    ).rejects.toThrow("Campaign is no longer active");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    actions.retry();
    hooks.index = 0;
    useCampaign("campaign");
    await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  },
);

test.each([400, 404, 409])(
  "HTTP %s rejection keeps the known ready snapshot and never performs a refresh",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(campaign))
      .mockResolvedValueOnce(Response.json({ error: "Close exceeds open quantity" }, { status }));
    vi.stubGlobal("fetch", fetch);
    const actions = useCampaign("campaign");
    await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
    await expect(
      actions.saveLifecycle("position", { action: "expire", input: { expectedRevision: "R0" } }),
    ).rejects.toThrow("Close exceeds open quantity");
    expect(hooks.states[0]).toEqual({ status: "ready", data: campaign });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test("a stale revision conflict removes actions and only a GET retry can restore them", async () => {
  const message = "Position changed. Reload the campaign before another action.";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockResolvedValueOnce(
      Response.json({ error: message, code: "stale_revision" }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json(campaign));
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  await expect(
    actions.saveLifecycle("position", {
      action: "close",
      input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
    }),
  ).rejects.toThrow(message);
  expect(hooks.states[0]).toEqual({ status: "error", message });
  await expect(
    actions.saveLifecycle("position", {
      action: "expire",
      input: { expectedRevision: "R0" },
    }),
  ).rejects.toThrow("Campaign is no longer active");
  expect(fetch).toHaveBeenCalledTimes(2);
  actions.retry();
  hooks.index = 0;
  useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

test("a stale GET after an uncertain close re-enables intent but preserves R0 for the server precondition", async () => {
  const snapshot = {
    ...campaign,
    positions: [{ ...revisionPosition, id: "position", revision: "R0" }],
  };
  const message = "Position changed. Reload the campaign before another action.";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockRejectedValueOnce(new Error("Connection lost before transaction completes"))
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(
      Response.json({ error: message, code: "stale_revision" }, { status: 409 }),
    );
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: snapshot }));
  const close = {
    action: "close" as const,
    input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
  };
  await expect(actions.saveLifecycle("position", close)).rejects.toThrow(
    "Lifecycle action outcome is uncertain",
  );
  actions.retry();
  hooks.index = 0;
  const reloaded = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: snapshot }));
  await expect(reloaded.saveLifecycle("position", close)).rejects.toThrow(message);
  const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts.map(([, init]) => JSON.parse(init.body))).toEqual([close.input, close.input]);
  expect(hooks.states[0]).toEqual({ status: "error", message });
});

test("the hook does not upgrade a stale intent to a newer ready revision", async () => {
  const snapshot = {
    ...campaign,
    positions: [{ ...revisionPosition, id: "position", revision: "R1" }],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(snapshot))
    .mockResolvedValueOnce(
      Response.json({ error: "Position changed", code: "stale_revision" }, { status: 409 }),
    );
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: snapshot }));
  await expect(
    actions.saveLifecycle("position", {
      action: "expire",
      input: { expectedRevision: "R0" },
    }),
  ).rejects.toThrow("Position changed");
  expect(fetch.mock.calls[1]?.[1].body).toBe('{"expectedRevision":"R0"}');
});

test("an ordinary 409 permits correction while retaining the observed revision", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockResolvedValueOnce(
      Response.json(
        { error: "Close exceeds open quantity", code: "quantity_conflict" },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(Response.json(result))
    .mockResolvedValueOnce(Response.json(campaign));
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  await expect(
    actions.saveLifecycle("position", {
      action: "close",
      input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 11, price: "0" }] },
    }),
  ).rejects.toThrow("Close exceeds open quantity");
  expect(hooks.states[0]).toEqual({ status: "ready", data: campaign });
  await expect(
    actions.saveLifecycle("position", {
      action: "close",
      input: { expectedRevision: "R0", fills: [{ legId: "leg", quantity: 5, price: "0" }] },
    }),
  ).resolves.toEqual(result);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  expect(hooks.states[0]).toEqual({ status: "ready", data: campaign });
});

test("a stale rejection arriving after navigation does not discard the new campaign", async () => {
  let release: (response: Response) => void = () => {
    throw new Error("No pending mutation");
  };
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const other = { ...campaign, id: "other" };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(Response.json(other));
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  const saving = actions.saveLifecycle("position", {
    action: "expire",
    input: { expectedRevision: "R0" },
  });
  const rejected = expect(saving).rejects.toThrow("Position changed");
  hooks.index = 0;
  useCampaign("other");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: other }));
  const active = hooks.active.current;
  release(Response.json({ error: "Position changed", code: "stale_revision" }, { status: 409 }));
  await rejected;
  expect(hooks.states[0]).toEqual({ status: "ready", data: other });
  expect(hooks.active.current).toBe(active);
});

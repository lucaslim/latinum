import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCampaign } from "./campaignApi.ts";

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
      input: { fills: [{ legId: "leg", quantity: 5, price: "0" }] },
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
      input: { fills: [{ legId: "leg", quantity: 5, price: "0" }] },
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

test("rejected mutation keeps the known ready snapshot and never performs a refresh", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(campaign))
    .mockResolvedValueOnce(
      Response.json({ error: "Close exceeds open quantity" }, { status: 409 }),
    );
  vi.stubGlobal("fetch", fetch);
  const actions = useCampaign("campaign");
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data: campaign }));
  await expect(actions.saveLifecycle("position", { action: "expire", input: {} })).rejects.toThrow(
    "Close exceeds open quantity",
  );
  expect(hooks.states[0]).toEqual({ status: "ready", data: campaign });
  expect(fetch).toHaveBeenCalledTimes(2);
});

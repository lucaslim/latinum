import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchMonthlyPnl, useMonthlyPnl } from "./monthlyPnlApi.ts";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
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
  useEffect(effect: () => () => void) {
    hooks.cleanup?.();
    hooks.cleanup = effect();
  },
}));
beforeEach(() => {
  hooks.states = [];
  hooks.index = 0;
});
afterEach(() => {
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  vi.unstubAllGlobals();
});

const data = { months: [] };

test("GET returns the monthly response with no-store and the caller's abort signal", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(data));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(fetchMonthlyPnl(signal)).resolves.toEqual({ months: [] });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/pl/monthly", {
    cache: "no-store",
    signal,
  });
});

test.each([404, 500])("HTTP %s is an explicit read error", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
  await expect(fetchMonthlyPnl(new AbortController().signal)).rejects.toThrow(
    `Could not load monthly P/L (HTTP ${status})`,
  );
});

test("transport rejects network, malformed JSON and aborted reads rather than empty data", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(new Response("not JSON"))
      .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError")),
  );
  await expect(fetchMonthlyPnl(controller.signal)).rejects.toThrow("Offline");
  await expect(fetchMonthlyPnl(controller.signal)).rejects.toBeInstanceOf(SyntaxError);
  await expect(fetchMonthlyPnl(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("hook exposes loading then ready", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
  expect(useMonthlyPnl().load).toEqual({ status: "loading" });
  await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data }));
});

test.each([new Error("Offline"), "Offline"])(
  "hook exposes errors and retries a fresh GET",
  async (cause) => {
    const fetch = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(Response.json(data));
    vi.stubGlobal("fetch", fetch);
    const actions = useMonthlyPnl();
    await vi.waitFor(() =>
      expect(hooks.states[0]).toEqual({ status: "error", message: "Offline" }),
    );
    const firstSignal = fetch.mock.calls[0]?.[1].signal;
    actions.retry();
    expect(hooks.states[1]).toBe(1);
    hooks.index = 0;
    useMonthlyPnl();
    expect(hooks.states[0]).toEqual({ status: "loading" });
    await vi.waitFor(() => expect(hooks.states[0]).toEqual({ status: "ready", data }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(firstSignal.aborted).toBe(true);
    expect(fetch.mock.calls[1]?.[1].signal.aborted).toBe(false);
  },
);

test.each(["resolve", "reject"])("unmount aborts and ignores late %s", async (finish) => {
  let resolve: (value: Response) => void = () => {
    throw new Error("Missing resolver");
  };
  let reject: (cause: unknown) => void = () => {
    throw new Error("Missing rejecter");
  };
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(useMonthlyPnl().load).toEqual({ status: "loading" });
  hooks.cleanup?.();
  expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  if (finish === "resolve") resolve(Response.json(data));
  else reject(new Error("Late failure"));
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(hooks.states[0]).toEqual({ status: "loading" });
});

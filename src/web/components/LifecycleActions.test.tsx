import { afterEach, describe, expect, it, vi } from "vitest";
import { type LifecycleMutation, saveLifecycle } from "../lifecycleApi.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Lifecycle transport", () => {
  const mutations: LifecycleMutation[] = [
    {
      action: "close",
      input: {
        fills: [{ legId: "spxl-leg", quantity: 2, price: "0.4000", fees: "-1.30" }],
        tradeDate: "2026-10-16",
      },
    },
    { action: "expire", input: {} },
    { action: "assign", input: { legId: "dram-leg" } },
    { action: "link-hedge", input: { campaignId: "target" } },
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
      saveLifecycle("position", { action: "expire", input: {} }, new AbortController().signal),
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
        saveLifecycle("position", { action: "expire", input: {} }, new AbortController().signal),
      ).rejects.toMatchObject({
        message: "Could not save lifecycle action (HTTP 502)",
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
        saveLifecycle("position", { action: "expire", input: {} }, new AbortController().signal),
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
      saveLifecycle("position", { action: "expire", input: {} }, new AbortController().signal),
    ).rejects.toThrow("Could not save lifecycle action (HTTP 502)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("leaves network uncertainty explicit and never retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection lost"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveLifecycle("position", { action: "expire", input: {} }, new AbortController().signal),
    ).rejects.toThrow("Connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

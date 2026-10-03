import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./app.ts";
import { type HeartbeatWriter, heartbeatRoute } from "./cron.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/heartbeat", () => {
  it.each([undefined, "Bearer wrong", "test-only-cron-secret", "bearer test-only-cron-secret"])(
    "rejects authorization %s",
    async (authorization) => {
      vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
      const res = await app.request("/api/cron/heartbeat", {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(res.status).toBe(401);
    },
  );

  it.each([undefined, ""])("fails closed with secret %s", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const res = await app.request("/api/cron/heartbeat", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the configured bearer", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    const res = await new Hono()
      .get("/heartbeat", heartbeatRoute())
      .request("/heartbeat", { headers: { Authorization: "Bearer test-only-cron-secret" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("heartbeat persistence", () => {
  const route = (writer: HeartbeatWriter) => new Hono().get("/heartbeat", heartbeatRoute(writer));

  it("writes one heartbeat per authorized call and none otherwise", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    const writer = vi.fn<HeartbeatWriter>(async () => {});
    const cron = route(writer);

    await cron.request("/heartbeat", { headers: { Authorization: "Bearer wrong" } });
    expect(writer.mock.calls).toEqual([]);

    const res = await cron.request("/heartbeat", {
      headers: { Authorization: "Bearer test-only-cron-secret" },
    });
    expect(res.status).toBe(200);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]?.[0].receivedAt).toBeInstanceOf(Date);
  });

  it("fails loudly instead of reporting ok when the write fails", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cron = route(async () => {
      throw new Error("database down");
    });
    const res = await cron.request("/heartbeat", {
      headers: { Authorization: "Bearer test-only-cron-secret" },
    });
    expect(res.status).toBe(500);
  });

  it("the deployed app errors without DATABASE_URL", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    vi.stubEnv("DATABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/api/cron/heartbeat", {
      headers: { Authorization: "Bearer test-only-cron-secret" },
    });
    expect(res.status).toBe(500);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./app.ts";

afterEach(() => vi.unstubAllEnvs());

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
    const res = await app.request("/api/cron/heartbeat", {
      headers: { Authorization: "Bearer test-only-cron-secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

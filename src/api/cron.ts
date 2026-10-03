import { createHash, timingSafeEqual } from "node:crypto";
import type { Handler } from "hono";

export type HeartbeatWriter = (heartbeat: { receivedAt: Date }) => Promise<void>;

// Defaults to a no-op so the route is testable without a database; the app injects the Neon writer.
export function heartbeatRoute(writeHeartbeat: HeartbeatWriter = async () => {}): Handler {
  return async (c) => {
    const secret = process.env.CRON_SECRET;
    const authorization = c.req.header("Authorization");
    if (!secret || !authorization) return c.json({ error: "Unauthorized" }, 401);

    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await writeHeartbeat({ receivedAt: new Date() });
    return c.json({ ok: true });
  };
}

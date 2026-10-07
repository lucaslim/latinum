import { Hono } from "hono";
import { withNeon } from "../db/neon.ts";
import { campaignRoute, manualMarkRoute } from "./campaigns.ts";
import { heartbeatRoute } from "./cron.ts";
import { neonHeartbeatWriter } from "./heartbeat.ts";
import { type PositionsDeps, positionsRoute } from "./positions.ts";

export function createApp(deps: PositionsDeps) {
  const app = new Hono().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/cron/heartbeat", heartbeatRoute(neonHeartbeatWriter));
  app.get("/positions", positionsRoute(deps));
  app.get("/campaigns/:id", campaignRoute(deps));
  app.put("/legs/:id/mark", manualMarkRoute(deps));
  return app;
}

export const app = createApp({ withDb: withNeon, now: () => new Date() });

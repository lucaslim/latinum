import { Hono, type MiddlewareHandler } from "hono";
import { withNeon } from "../db/neon.ts";
import { authRoutes, requireSession } from "./auth.ts";
import { campaignRoute, manualMarkRoute } from "./campaigns.ts";
import { heartbeatRoute } from "./cron.ts";
import { exportRoute } from "./export.ts";
import { neonHeartbeatWriter } from "./heartbeat.ts";
import { lifecycleRoute } from "./lifecycle.ts";
import { monthlyPnlRoute } from "./monthlyPnl.ts";
import { type PositionsDeps, positionsRoute } from "./positions.ts";
import { rollRoute } from "./rolls.ts";
import {
  createPositionRoute,
  manualTradesRoute,
  patchTradeRoute,
  tradeFormOptionsRoute,
} from "./trades.ts";

export type AppDeps = PositionsDeps & {
  /** Runs before every route registered after it; the deployed app uses `requireSession`. */
  guard: MiddlewareHandler;
};

export function createApp(deps: AppDeps) {
  const app = new Hono().basePath("/api");

  // Public: health for probes, cron behind its own bearer, and the login routes themselves.
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/cron/heartbeat", heartbeatRoute(neonHeartbeatWriter));
  app.route("/auth", authRoutes(deps.now));
  app.use(deps.guard);
  app.get("/positions", positionsRoute(deps));
  app.get("/campaigns/:id", campaignRoute(deps));
  app.put("/legs/:id/mark", manualMarkRoute(deps));
  app.get("/export", exportRoute(deps));
  app.get("/pl/monthly", monthlyPnlRoute(deps));
  app.post("/positions", createPositionRoute(deps));
  app.post("/rolls", rollRoute(deps));
  app.patch("/trades/:id", patchTradeRoute(deps));
  app.get("/trade-form/options", tradeFormOptionsRoute(deps));
  app.get("/positions/:id/manual-trades", manualTradesRoute(deps));
  app.post("/positions/:id/close", lifecycleRoute("close", deps));
  app.post("/positions/:id/expire", lifecycleRoute("expire", deps));
  app.post("/positions/:id/assign", lifecycleRoute("assign", deps));
  app.post("/positions/:id/link-hedge", lifecycleRoute("link-hedge", deps));
  return app;
}

const now = () => new Date();
export const app = createApp({ withDb: withNeon, now, guard: requireSession(now) });

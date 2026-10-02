import { Hono } from "hono";
import { heartbeatRoute } from "./cron.ts";

export const app = new Hono().basePath("/api");

app.get("/health", (c) => c.json({ ok: true }));
app.get("/cron/heartbeat", heartbeatRoute());

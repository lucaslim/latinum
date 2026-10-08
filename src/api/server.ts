import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { seedBook } from "../db/seed.ts";
import { createApp } from "./app.ts";
import { hashPassword, requireSession } from "./auth.ts";
import { installTestFixtures } from "./testFixtures.ts";

// Local only: an in-memory PGlite holding the prototype book, rebuilt on every start.
const db = drizzle({ client: new PGlite(), casing: "snake_case" });
await migrate(db, { migrationsFolder: "drizzle" });
await seedBook(db);

// A fixed local password unless one is configured; the session secret changes every start.
const localPassword = process.env.AUTH_PASSWORD_HASH ? "from AUTH_PASSWORD_HASH" : "journal";
process.env.AUTH_PASSWORD_HASH ||= await hashPassword(localPassword);
process.env.SESSION_SECRET ||= randomBytes(32).toString("base64url");

const e2e = process.env.E2E_MODE === "1";
const now = () => (e2e ? new Date("2026-10-17T03:30:00Z") : new Date());
const app = createApp({ withDb: (use) => use(db), now, guard: requireSession(now) });
if (e2e) installTestFixtures(app, db);
const port = Number(process.env.API_PORT ?? 8787);

serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`api listening on http://localhost:${port} (password: ${localPassword})`);
});

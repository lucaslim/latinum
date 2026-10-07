import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { seedBook } from "../db/seed.ts";
import { createApp } from "./app.ts";

// Local only: an in-memory PGlite holding the prototype book, rebuilt on every start.
const db = drizzle({ client: new PGlite(), casing: "snake_case" });
await migrate(db, { migrationsFolder: "drizzle" });
await seedBook(db);

const app = createApp({ withDb: (use) => use(db), now: () => new Date() });
if (process.env.E2E_MODE === "1") {
  app.post("/test/reset", async (c) => {
    await db.execute(sql`truncate accounts cascade`);
    await seedBook(db);
    return c.json({ ok: true });
  });
}
const port = Number(process.env.API_PORT ?? 8787);

serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`api listening on http://localhost:${port}`);
});

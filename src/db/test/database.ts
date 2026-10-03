import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

export async function testDatabase() {
  const client = new PGlite();
  const db = drizzle({ client, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { client, db };
}

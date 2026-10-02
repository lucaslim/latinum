import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { seedBook } from "../src/db/seed.ts";

const path = process.argv[2] ?? ".pglite";
if (path.includes("://")) throw new Error("Seed accepts a local filesystem path only");
const client = new PGlite(path);
try {
  const db = drizzle({ client, casing: "snake_case" });
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedBook(db);
  console.log("Local prototype open book seeded");
} finally {
  await client.close();
}

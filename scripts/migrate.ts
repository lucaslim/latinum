import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const connectionString = process.env.DATABASE_URL_OWNER;
if (!connectionString) throw new Error("DATABASE_URL_OWNER is required");
const pool = new Pool({ connectionString });
try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  console.log("Production migration chain applied");
} catch {
  // Driver errors can contain credentials or SQL; never print them in CI.
  console.error("Production migration failed (connection, authentication or SQL error)");
  process.exitCode = 1;
} finally {
  await pool.end();
}

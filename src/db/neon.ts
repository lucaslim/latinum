import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { WithDb } from "./database.ts";

/** One pool per call: serverless instances must not hold connections between requests. */
export const withNeon: WithDb = async (use) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString });
  try {
    return await use(drizzle({ client: pool, casing: "snake_case" }));
  } finally {
    await pool.end();
  }
};

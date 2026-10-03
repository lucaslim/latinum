import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { repository } from "../db/repository.ts";
import type { HeartbeatWriter } from "./cron.ts";

// A Pool per invocation, ended before returning: serverless functions must not keep sockets open.
export const neonHeartbeatWriter: HeartbeatWriter = async ({ receivedAt }) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString });
  try {
    await repository(drizzle({ client: pool, casing: "snake_case" })).recordHeartbeat({
      at: receivedAt,
      source: "vercel-cron",
    });
  } finally {
    await pool.end();
  }
};

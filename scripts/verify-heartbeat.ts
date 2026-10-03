import { Pool } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL_OWNER;
if (!connectionString) throw new Error("DATABASE_URL_OWNER is required");
const pool = new Pool({ connectionString });
try {
  const { rows } = await pool.query(
    "SELECT id, at FROM platform_heartbeat WHERE source = 'vercel-cron' ORDER BY at DESC LIMIT 5",
  );
  for (const row of rows)
    console.log(`heartbeat id=${row.id} at=${new Date(row.at).toISOString()}`);
  if (rows.length === 0) {
    console.error("No vercel-cron heartbeat row yet (the cron runs daily at 10:00 UTC)");
    process.exitCode = 1;
  }
} catch {
  console.error("Heartbeat read failed (connection, authentication or SQL error)");
  process.exitCode = 1;
} finally {
  await pool.end();
}

export type Queryable = {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
};

const DENIED = [
  "CREATE TABLE public.denial_probe (id integer)",
  "SELECT 1 FROM drizzle.__drizzle_migrations",
  "ALTER TABLE public.accounts ADD COLUMN denial_probe integer",
  "DROP TABLE public.accounts",
  "TRUNCATE public.accounts",
];

// Every probe runs in a transaction that is rolled back, so a wrongly permitted statement leaves nothing behind.
async function attempt(db: Queryable, sql: string): Promise<string | undefined> {
  await db.query("BEGIN");
  try {
    await db.query(sql);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await db.query("ROLLBACK");
  }
}

export async function proveDenial(db: Queryable): Promise<string[]> {
  const [identity] = (
    await db.query(
      "SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    )
  ).rows;
  if (
    identity?.name !== "app_rw" ||
    identity.rolsuper ||
    identity.rolcreaterole ||
    identity.rolcreatedb
  ) {
    throw new Error("Denial proof must run as an unprivileged app_rw");
  }
  const report = ["connected as app_rw without superuser, createrole or createdb"];

  await db.query("BEGIN");
  try {
    await db.query("INSERT INTO platform_heartbeat (source) VALUES ('denial-proof')");
    await db.query(
      "UPDATE platform_heartbeat SET source = 'denial-proof-2' WHERE source = 'denial-proof'",
    );
    const { rows } = await db.query(
      "SELECT source FROM platform_heartbeat WHERE source = 'denial-proof-2'",
    );
    if (rows.length !== 1) throw new Error("app_rw could not read back its own insert");
    await db.query("DELETE FROM platform_heartbeat WHERE source = 'denial-proof-2'");
  } finally {
    await db.query("ROLLBACK");
  }
  report.push("normal DML (insert, update, select, delete) allowed");

  for (const sql of DENIED) {
    const code = await attempt(db, sql);
    if (code !== "42501") {
      throw new Error(`"${sql}": expected SQLSTATE 42501, got ${code ?? "success"}`);
    }
    report.push(`denied with 42501: ${sql}`);
  }
  return report;
}

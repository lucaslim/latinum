import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";

test("real migrations grant DML but deny app DDL and migration-log access", async () => {
  const path = await mkdtemp(join(process.cwd(), ".pglite-roles-"));
  try {
    const owner = new PGlite(path);
    try {
      await migrate(drizzle(owner), { migrationsFolder: "drizzle" });
      expect((await owner.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(
        3,
      );
      await owner.exec("ALTER ROLE app_rw PASSWORD 'local-test-only'");
      expect(
        (await owner.query("SELECT rolconfig FROM pg_roles WHERE rolname='app_rw'")).rows,
      ).toEqual([{ rolconfig: ["TimeZone=UTC"] }]);
      const before = await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname='app_rw'");
      await owner.exec(await readFile("drizzle/0000_roles.sql", "utf8"));
      expect(
        (await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname='app_rw'")).rows,
      ).toEqual(before.rows);
    } finally {
      await owner.close();
    }
    const app = new PGlite({ dataDir: path, username: "app_rw" });
    try {
      expect((await app.query("SELECT current_user AS name")).rows).toEqual([{ name: "app_rw" }]);
      await app.exec("INSERT INTO accounts (label,broker) VALUES ('app control','manual')");
      await app.exec("UPDATE accounts SET label='updated' WHERE label='app control'");
      expect((await app.query("SELECT label FROM accounts")).rows).toEqual([{ label: "updated" }]);
      await app.exec("DELETE FROM accounts WHERE label='updated'");
      await app.exec("INSERT INTO platform_heartbeat (source) VALUES ('role-test')");
      expect((await app.query("SELECT source FROM platform_heartbeat")).rows).toEqual([
        { source: "role-test" },
      ]);
      await expect(app.exec("CREATE TABLE public.forbidden (id integer)")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(app.query("SELECT * FROM drizzle.__drizzle_migrations")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.close();
    }
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 20_000);

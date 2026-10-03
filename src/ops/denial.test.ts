import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { proveDenial } from "./denial.ts";

it("passes for app_rw, and fails loudly for a role that can do more", async () => {
  const path = await mkdtemp(join(process.cwd(), ".pglite-denial-"));
  try {
    const owner = new PGlite(path);
    try {
      await migrate(drizzle(owner), { migrationsFolder: "drizzle" });
      await expect(proveDenial(owner)).rejects.toThrow("unprivileged app_rw");
    } finally {
      await owner.close();
    }
    const app = new PGlite({ dataDir: path, username: "app_rw" });
    try {
      const report = await proveDenial(app);
      expect(report.filter((line) => line.startsWith("denied with 42501"))).toHaveLength(5);
      expect(report).toContain("normal DML (insert, update, select, delete) allowed");
      expect((await app.query("SELECT count(*)::int AS n FROM platform_heartbeat")).rows).toEqual([
        { n: 0 },
      ]);
    } finally {
      await app.close();
    }
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);

it("reports the code when a statement is refused for another reason", async () => {
  const path = await mkdtemp(join(process.cwd(), ".pglite-denial-"));
  try {
    const owner = new PGlite(path);
    try {
      await migrate(drizzle(owner), { migrationsFolder: "drizzle" });
      // Granting CREATE makes the CREATE TABLE probe succeed, which must be reported as a failure.
      await owner.exec("GRANT CREATE ON SCHEMA public TO app_rw");
    } finally {
      await owner.close();
    }
    const app = new PGlite({ dataDir: path, username: "app_rw" });
    try {
      await expect(proveDenial(app)).rejects.toThrow("expected SQLSTATE 42501, got success");
    } finally {
      await app.close();
    }
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);

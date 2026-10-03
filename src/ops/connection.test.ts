import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { appDatabaseUrl, generateSecret, passwordStatement } from "./connection.ts";

const owner =
  "postgresql://neondb_owner:owner-secret@ep-quiet-sky-123456.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

it("generates distinct URL-safe secrets", () => {
  const [a, b] = [generateSecret(), generateSecret()];
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(generateSecret(32)).toHaveLength(43);
});

it("builds an app_rw URL on the pooled host with the owner's database", () => {
  const url = new URL(appDatabaseUrl(owner, "pw-_9"));
  expect(url.username).toBe("app_rw");
  expect(url.password).toBe("pw-_9");
  expect(url.hostname).toBe("ep-quiet-sky-123456-pooler.us-east-1.aws.neon.tech");
  expect(url.pathname).toBe("/neondb");
  expect(url.search).toBe("?sslmode=require");
  expect(appDatabaseUrl(owner, "x")).not.toContain("owner");
});

it("keeps an already pooled host unchanged", () => {
  const pooled = owner.replace("123456.", "123456-pooler.");
  expect(new URL(appDatabaseUrl(pooled, "x")).hostname).toBe(
    "ep-quiet-sky-123456-pooler.us-east-1.aws.neon.tech",
  );
});

it.each(["has space", "quo'te", "semi;colon", "", "pct%41"])("rejects password %j", (password) => {
  expect(() => passwordStatement(password)).toThrow("base64url");
  expect(() => appDatabaseUrl(owner, password)).toThrow("base64url");
});

it("sets a password on the passwordless role", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE app_rw LOGIN");
    const read = () =>
      db.query("SELECT rolpassword IS NOT NULL AS has FROM pg_authid WHERE rolname = 'app_rw'");
    expect((await read()).rows).toEqual([{ has: false }]);
    await db.exec(passwordStatement(generateSecret()));
    expect((await read()).rows).toEqual([{ has: true }]);
  } finally {
    await db.close();
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedBook } from "../db/seed.ts";
import { testDatabase } from "../db/test/database.ts";
import { createApp, app as deployedApp } from "./app.ts";
import { hashPassword, requireSession } from "./auth.ts";

// scrypt (N=16384, r=8, p=1, 32 bytes) of "correct horse", computed outside this codebase.
const HASH =
  "scrypt$dHJhZGluZy1qb3VybmFsLXRlc3Qtc2FsdA$0f7tgb5PF8VB5taO9hp1qINFjb3gUc6UuHqxqpD-Jeo";
const SECRET = "test-only-session-secret-0123456789";
const NINETY_DAYS_S = 7_776_000;

let clock = new Date("2026-10-02T03:30:00Z");
const now = () => clock;

beforeEach(() => {
  clock = new Date("2026-10-02T03:30:00Z");
  vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
  vi.stubEnv("SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function guardedApp() {
  const { db, client } = await testDatabase();
  await seedBook(db);
  const app = createApp({ withDb: (use) => use(db), now, guard: requireSession(now) });
  return { app, client };
}

function login(app: ReturnType<typeof createApp>, password: unknown) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] ?? "";
}

describe("deployed app", () => {
  it.each([
    ["GET", "/api/positions?status=open"],
    ["GET", "/api/campaigns/00000000-0000-4000-8000-000000000000"],
    ["PUT", "/api/legs/00000000-0000-4000-8000-000000000000/mark"],
    ["GET", "/api/export"],
    ["GET", "/api/pl/monthly"],
    ["POST", "/api/positions"],
    ["POST", "/api/rolls"],
    ["PATCH", "/api/trades/00000000-0000-4000-8000-000000000000"],
    ["GET", "/api/trade-form/options"],
    ["GET", "/api/positions/00000000-0000-4000-8000-000000000000/manual-trades"],
    ["POST", "/api/positions/00000000-0000-4000-8000-000000000000/close"],
    ["POST", "/api/positions/00000000-0000-4000-8000-000000000000/expire"],
    ["POST", "/api/positions/00000000-0000-4000-8000-000000000000/assign"],
    ["POST", "/api/positions/00000000-0000-4000-8000-000000000000/link-hedge"],
    ["GET", "/api/auth/session"],
  ])("rejects anonymous %s %s", async (method, path) => {
    const res = await deployedApp.request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("keeps health public", async () => {
    const res = await deployedApp.request("/api/health");
    expect(res.status).toBe(200);
  });

  it.each([
    ["AUTH_PASSWORD_HASH", 401],
    ["SESSION_SECRET", 500],
  ])("fails loudly when %s is unset", async (name, guarded) => {
    vi.stubEnv(name, "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await login(deployedApp, "correct horse")).status).toBe(500);
    expect((await deployedApp.request("/api/pl/monthly")).status).toBe(guarded);
  });
});

describe("login session", () => {
  it("issues a 90-day host-only cookie that unlocks the journal", async () => {
    const { app, client } = await guardedApp();
    try {
      const res = await login(app, "correct horse");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const setCookie = res.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toMatch(/^__Host-session=[^;]+;/);
      expect(setCookie).toContain(`Max-Age=${NINETY_DAYS_S}`);
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Lax");

      const positions = await app.request("/api/positions?status=open", {
        headers: { Cookie: sessionCookie(res) },
      });
      expect(positions.status).toBe(200);
    } finally {
      await client.close();
    }
  });

  it.each(["wrong", "", 42, undefined])("rejects password %s without a cookie", async (pw) => {
    const { app, client } = await guardedApp();
    try {
      const res = await login(app, pw);
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("rejects a tampered cookie", async () => {
    const { app, client } = await guardedApp();
    try {
      const cookie = sessionCookie(await login(app, "correct horse"));
      const [name, value = ""] = cookie.split("=", 2);
      const [payload] = decodeURIComponent(value).split(".");
      const forged = `${name}=${encodeURIComponent(`${Number(payload) + 1}.${"A".repeat(43)}=`)}`;
      const res = await app.request("/api/pl/monthly", { headers: { Cookie: forged } });
      expect(res.status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("rejects a cookie signed with a rotated secret", async () => {
    const { app, client } = await guardedApp();
    try {
      const cookie = sessionCookie(await login(app, "correct horse"));
      vi.stubEnv("SESSION_SECRET", "a-different-secret-after-rotation");
      const res = await app.request("/api/pl/monthly", { headers: { Cookie: cookie } });
      expect(res.status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("expires after 90 days even if the browser keeps the cookie", async () => {
    const { app, client } = await guardedApp();
    try {
      const cookie = sessionCookie(await login(app, "correct horse"));
      clock = new Date(clock.getTime() + NINETY_DAYS_S * 1000 - 1);
      expect((await app.request("/api/pl/monthly", { headers: { Cookie: cookie } })).status).toBe(
        200,
      );
      clock = new Date(clock.getTime() + 1);
      expect((await app.request("/api/pl/monthly", { headers: { Cookie: cookie } })).status).toBe(
        401,
      );
    } finally {
      await client.close();
    }
  });

  it("renews the session when the app checks it", async () => {
    const { app, client } = await guardedApp();
    try {
      const first = sessionCookie(await login(app, "correct horse"));
      clock = new Date(clock.getTime() + 80 * 86_400_000);
      const check = await app.request("/api/auth/session", { headers: { Cookie: first } });
      expect(check.status).toBe(200);
      const renewed = sessionCookie(check);
      expect(renewed).toMatch(/^__Host-session=/);

      clock = new Date(clock.getTime() + 20 * 86_400_000);
      expect((await app.request("/api/pl/monthly", { headers: { Cookie: first } })).status).toBe(
        401,
      );
      expect((await app.request("/api/pl/monthly", { headers: { Cookie: renewed } })).status).toBe(
        200,
      );
    } finally {
      await client.close();
    }
  });

  it("logout clears the cookie", async () => {
    const { app, client } = await guardedApp();
    try {
      const res = await app.request("/api/auth/logout", { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-session=; Max-Age=0;/);
    } finally {
      await client.close();
    }
  });

  it("rejects a malformed login body", async () => {
    const { app, client } = await guardedApp();
    try {
      const res = await app.request("/api/auth/login", { method: "POST", body: "{" });
      expect(res.status).toBe(400);
    } finally {
      await client.close();
    }
  });
});

describe("hashPassword", () => {
  it("produces a salted hash that login accepts for that password only", async () => {
    const hash = await hashPassword("a new password");
    expect(hash).toMatch(/^scrypt\$[\w-]{22}\$[\w-]{43}$/);
    expect(await hashPassword("a new password")).not.toBe(hash);

    vi.stubEnv("AUTH_PASSWORD_HASH", hash);
    const { app, client } = await guardedApp();
    try {
      expect((await login(app, "a new password")).status).toBe(200);
      expect((await login(app, "correct horse")).status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("refuses a malformed stored hash instead of treating it as a mismatch", async () => {
    vi.stubEnv("AUTH_PASSWORD_HASH", "plaintext");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await login(deployedApp, "plaintext")).status).toBe(500);
  });
});

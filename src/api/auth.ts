import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SESSION_COOKIE = "session";
const SESSION_DAYS = 90;
const SESSION_MS = SESSION_DAYS * 86_400_000;

/** Format: `scrypt$<salt base64url>$<key base64url>`, the value of `AUTH_PASSWORD_HASH`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_BYTES, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) throw new Error("AUTH_PASSWORD_HASH is malformed");
  const key = await scryptAsync(password, Buffer.from(salt, "base64url"), KEY_BYTES, SCRYPT);
  return timingSafeEqual(key, Buffer.from(expected, "base64url"));
}

// Read per request, like CRON_SECRET, so a missing variable fails the request rather than the deploy.
function setting(name: "AUTH_PASSWORD_HASH" | "SESSION_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const unauthorized = (c: Context) => c.json({ error: "Unauthorized" }, 401);

async function startSession(c: Context, now: Date) {
  // The cookie carries its own expiry so a replayed cookie dies server-side too.
  const expiresAt = String(now.getTime() + SESSION_MS);
  await setSignedCookie(c, SESSION_COOKIE, expiresAt, setting("SESSION_SECRET"), {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_MS / 1000,
  });
}

async function hasSession(c: Context, now: Date): Promise<boolean> {
  const secret = setting("SESSION_SECRET");
  const value = await getSignedCookie(c, secret, SESSION_COOKIE, "host");
  if (!value) return false;
  return now.getTime() < Number(value);
}

export function requireSession(now: () => Date): MiddlewareHandler {
  return async (c, next) => {
    if (!(await hasSession(c, now()))) return unauthorized(c);
    await next();
  };
}

const LoginBody = z.object({ password: z.string().min(1) });

/** Mounted outside the guard; `/session` checks the cookie itself and slides it forward. */
export function authRoutes(now: () => Date) {
  return new Hono()
    .post("/login", async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch (error) {
        if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
        throw error;
      }
      const body = LoginBody.safeParse(json);
      const hash = setting("AUTH_PASSWORD_HASH");
      if (!body.success || !(await verifyPassword(body.data.password, hash))) {
        return unauthorized(c);
      }
      await startSession(c, now());
      return c.json({ ok: true });
    })
    .post("/logout", (c) => {
      deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/" });
      return c.json({ ok: true });
    })
    .get("/session", async (c) => {
      if (!(await hasSession(c, now()))) return unauthorized(c);
      await startSession(c, now());
      return c.json({ ok: true });
    });
}

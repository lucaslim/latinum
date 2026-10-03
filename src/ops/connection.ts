import { randomBytes } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

// base64url keeps the value URL-safe and quote-free, so it can sit in a URL and a SQL literal as is.
export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function passwordStatement(password: string): string {
  if (!SECRET_PATTERN.test(password)) throw new Error("Password must be base64url");
  return `ALTER ROLE app_rw PASSWORD '${password}'`;
}

// The app connects through Neon's pooled host. channel_binding is left off: the serverless
// driver reaches Neon over a WebSocket proxy, where SCRAM channel binding is not documented.
export function appDatabaseUrl(ownerUrl: string, password: string): string {
  if (!SECRET_PATTERN.test(password)) throw new Error("Password must be base64url");
  const url = new URL(ownerUrl);
  const [endpoint = "", ...domain] = url.hostname.split(".");
  if (!endpoint.endsWith("-pooler")) url.hostname = [`${endpoint}-pooler`, ...domain].join(".");
  url.username = "app_rw";
  url.password = password;
  url.search = "?sslmode=require";
  return url.toString();
}

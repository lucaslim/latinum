import type { MiddlewareHandler } from "hono";

/** Unit tests of journal routes skip the session; `auth.test.ts` covers the guard itself. */
export const noSession: MiddlewareHandler = (_c, next) => next();

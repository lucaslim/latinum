import type { Handler } from "hono";
import type { LifecycleResponse, LinkHedgeResponse } from "../contracts/lifecycle.ts";
import {
  assignSchema,
  closeSchema,
  expireSchema,
  isUuid,
  linkHedgeSchema,
} from "../contracts/lifecycleSchemas.ts";
import type { Database } from "../db/database.ts";
import {
  LifecycleConflictError,
  LifecycleValidationError,
  lifecycleRepository,
} from "../db/lifecycle.ts";
import { CoveredStockConflictError } from "../db/repository.ts";
import { todayNY } from "../domain/dates.ts";
import type { PositionsDeps } from "./positions.ts";

export type LifecycleAction = "close" | "expire" | "assign" | "link-hedge";

export function lifecycleRoute(action: LifecycleAction, { withDb, now }: PositionsDeps): Handler {
  return async (c) => {
    c.header("Cache-Control", "private, no-store");
    const id = c.req.param("id");
    if (!id || !isUuid(id)) return c.json({ error: "Invalid position id" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: "Invalid JSON" }, 400);
    }
    // Parse before opening a connection; only input errors become 400s.
    let perform: (db: Database) => Promise<LifecycleResponse | LinkHedgeResponse | null>;
    try {
      const today = todayNY(now());
      switch (action) {
        case "close": {
          const input = closeSchema.parse(body, today);
          perform = (db) => lifecycleRepository(db).closePosition(id, input);
          break;
        }
        case "expire": {
          const input = expireSchema.parse(body, today);
          perform = (db) => lifecycleRepository(db).expirePosition(id, input);
          break;
        }
        case "assign": {
          const input = assignSchema.parse(body, today);
          perform = (db) => lifecycleRepository(db).assignPosition(id, input);
          break;
        }
        case "link-hedge": {
          const input = linkHedgeSchema.parse(body);
          perform = (db) => lifecycleRepository(db).linkHedge(id, input);
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return c.json({ error: error.message }, 400);
    }
    try {
      const result = await withDb(perform);
      return result ? c.json(result) : c.json({ error: "Position or campaign not found" }, 404);
    } catch (error) {
      if (error instanceof LifecycleValidationError) return c.json({ error: error.message }, 400);
      if (error instanceof LifecycleConflictError || error instanceof CoveredStockConflictError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
  };
}

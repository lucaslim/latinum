import type { Handler } from "hono";
import type { RollInput } from "../contracts/roll.ts";
import { rollSchema } from "../contracts/rollSchemas.ts";
import {
  LifecycleConflictError,
  LifecycleValidationError,
  StalePositionRevisionError,
} from "../db/lifecycle.ts";
import { CoveredStockConflictError } from "../db/repository.ts";
import { rollRepository } from "../db/rolls.ts";
import { todayNY } from "../domain/dates.ts";
import type { PositionsDeps } from "./positions.ts";

export function rollRoute({ withDb, now }: PositionsDeps): Handler {
  return async (c) => {
    c.header("Cache-Control", "private, no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: "Invalid JSON" }, 400);
    }
    let input: RollInput;
    try {
      input = rollSchema.parse(body, todayNY(now()));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return c.json({ error: error.message }, 400);
    }
    try {
      const result = await withDb((db) => rollRepository(db).rollPosition(input));
      return result ? c.json(result) : c.json({ error: "Position not found" }, 404);
    } catch (error) {
      if (error instanceof StalePositionRevisionError)
        return c.json({ error: error.message, code: "stale_revision" }, 409);
      if (error instanceof LifecycleValidationError) return c.json({ error: error.message }, 400);
      if (error instanceof LifecycleConflictError || error instanceof CoveredStockConflictError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
  };
}

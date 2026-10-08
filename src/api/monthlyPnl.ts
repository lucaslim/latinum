import type { Handler } from "hono";
import { readMonthlyPnl } from "../db/monthlyPnl.ts";
import type { PositionsDeps } from "./positions.ts";

export function monthlyPnlRoute({ withDb }: PositionsDeps): Handler {
  return async (c) => {
    const body = await withDb(readMonthlyPnl);
    c.header("Cache-Control", "private, no-store");
    return c.json(body);
  };
}

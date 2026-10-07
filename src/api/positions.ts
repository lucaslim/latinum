import type { Handler } from "hono";
import { toBookPosition } from "../db/book.ts";
import type { WithDb } from "../db/database.ts";
import { repository } from "../db/repository.ts";
import { todayNY } from "../domain/dates.ts";
import type { OpenPositionsResponse } from "../domain/sheet.ts";

export interface PositionsDeps {
  withDb: WithDb;
  now: () => Date;
}

export function positionsRoute({ withDb, now }: PositionsDeps): Handler {
  return async (c) => {
    if (c.req.query("status") !== "open") return c.json({ error: "status must be open" }, 400);

    const rows = await withDb((db) => repository(db).readOpenBook());
    const body: OpenPositionsResponse = {
      asOf: todayNY(now()),
      positions: rows.map((row) => ({
        id: row.id,
        campaignId: row.campaignId,
        ...toBookPosition(row),
      })),
    };
    c.header("Cache-Control", "private, no-store");
    return c.json(body);
  };
}

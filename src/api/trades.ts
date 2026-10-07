import type { Context, Handler } from "hono";
import { z } from "zod";
import { TradeWriteError, tradeRepository } from "../db/tradeRepository.ts";
import { Money4RangeError } from "../domain/money.ts";
import { createPositionSchema, patchTradeSchema } from "../shared/trade.ts";
import type { PositionsDeps } from "./positions.ts";

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new TradeWriteError("Malformed JSON", 400);
    throw error;
  }
}

function route(handle: Handler): Handler {
  return async (c, next) => {
    try {
      c.header("Cache-Control", "private, no-store");
      return await handle(c, next);
    } catch (error) {
      if (error instanceof TradeWriteError) return c.json({ error: error.message }, error.status);
      if (error instanceof Money4RangeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  };
}

function id(c: Context) {
  const parsed = z.uuid().safeParse(c.req.param("id"));
  if (!parsed.success) throw new TradeWriteError("Invalid ID", 400);
  return parsed.data;
}

export function createPositionRoute({ withDb }: PositionsDeps): Handler {
  return route(async (c) => {
    const parsed = createPositionSchema.safeParse(await body(c));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    return c.json(await withDb((db) => tradeRepository(db).create(parsed.data)), 201);
  });
}

export function patchTradeRoute({ withDb }: PositionsDeps): Handler {
  return route(async (c) => {
    const tradeId = id(c);
    const parsed = patchTradeSchema.safeParse(await body(c));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    return c.json(await withDb((db) => tradeRepository(db).patch(tradeId, parsed.data)), 200);
  });
}

export function tradeFormOptionsRoute({ withDb }: PositionsDeps): Handler {
  return route(async (c) => c.json(await withDb((db) => tradeRepository(db).options())));
}

export function manualTradesRoute({ withDb }: PositionsDeps): Handler {
  return route(async (c) => {
    const positionId = id(c);
    return c.json(await withDb((db) => tradeRepository(db).manualTrades(positionId)));
  });
}

import type { Handler } from "hono";
import { campaignRepository, ManualMarkConflictError } from "../db/campaigns.ts";
import type { CampaignMark } from "../domain/campaign.ts";
import { parseIsoDate, todayNY } from "../domain/dates.ts";
import { parseMoney4 } from "../domain/money.ts";
import type { PositionsDeps } from "./positions.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function campaignRoute({ withDb, now }: PositionsDeps): Handler {
  return async (c) => {
    c.header("Cache-Control", "private, no-store");
    const id = c.req.param("id");
    if (!id || !UUID.test(id)) return c.json({ error: "Invalid campaign id" }, 400);
    const response = await withDb((db) => campaignRepository(db).readCampaign(id, todayNY(now())));
    return response ? c.json(response) : c.json({ error: "Campaign not found" }, 404);
  };
}

export function manualMarkRoute({ withDb, now }: PositionsDeps): Handler {
  return async (c) => {
    c.header("Cache-Control", "private, no-store");
    const id = c.req.param("id");
    if (!id || !UUID.test(id)) return c.json({ error: "Invalid leg id" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !("price" in body) ||
      typeof body.price !== "string" ||
      Object.keys(body).some((key) => key !== "price" && key !== "asOf")
    ) {
      return c.json({ error: "Expected decimal price and optional asOf date" }, 400);
    }
    const dateInput = "asOf" in body ? body.asOf : undefined;
    if (dateInput !== undefined && typeof dateInput !== "string") {
      return c.json({ error: "Expected asOf date string" }, 400);
    }
    const today = todayNY(now());
    let mark: CampaignMark & { source: "manual" };
    try {
      const price = parseMoney4(body.price);
      const asOf = dateInput === undefined ? today : parseIsoDate(dateInput);
      // Match numeric(12,4)'s storage range before entering the write transaction.
      if (price <= 0 || price > 999_999_999_999 || asOf > today)
        throw new RangeError("Invalid mark");
      mark = { price, asOf, source: "manual" };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return c.json(
        { error: "Price must be positive USD with at most 4 decimals; date cannot be future" },
        400,
      );
    }
    try {
      const response = await withDb((db) => campaignRepository(db).saveManualMark(id, mark));
      return response ? c.json(response) : c.json({ error: "Leg not found" }, 404);
    } catch (error) {
      if (!(error instanceof ManualMarkConflictError)) throw error;
      return c.json({ error: error.message }, 409);
    }
  };
}

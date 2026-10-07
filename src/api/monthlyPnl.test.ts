import { describe, expect, it } from "vitest";
import { repository } from "../db/repository.ts";
import * as s from "../db/schema.ts";
import { seedBook } from "../db/seed.ts";
import { testDatabase } from "../db/test/database.ts";
import { parseMoney4 as m } from "../domain/money.ts";
import type { MonthlyPnlResponse } from "../domain/monthlyPnlTypes.ts";
import { createApp } from "./app.ts";

const accountId = "30000000-0000-4000-8000-000000000001";
const campaignId = "30000000-0000-4000-8000-000000000002";
const positionId = "30000000-0000-4000-8000-000000000003";
const closeId = "30000000-0000-4000-8000-000000000004";
const now = () => new Date("2026-11-01T12:00:00Z");

describe("GET /api/pl/monthly", () => {
  it("books a close executed after UTC midnight in September using tradeDate", async () => {
    const { db, client } = await testDatabase();
    try {
      await db
        .insert(s.accounts)
        .values({ id: accountId, label: "Timezone edge", broker: "manual" });
      await db
        .insert(s.campaigns)
        .values({ id: campaignId, accountId, title: "SPXL", openedOn: "2026-09-01" });
      await repository(db).createPosition({
        id: positionId,
        campaignId,
        underlying: "SPXL",
        strategy: "csp",
        role: "income",
        openedOn: "2026-09-01",
        legs: [
          {
            kind: "put",
            side: "short",
            underlying: "SPXL",
            strike: m("240"),
            expiry: "2026-10-16",
            trades: [
              {
                action: "open",
                tradeDate: "2026-09-01",
                quantity: 2,
                price: m("3.10"),
                cash: m("620"),
                fees: m("-1.30"),
              },
              {
                id: closeId,
                action: "close",
                tradeDate: "2026-09-30",
                executedAt: new Date("2026-10-01T01:00:00Z"),
                quantity: 2,
                price: m("0.40"),
                cash: m("-80"),
                fees: m("-1.30"),
              },
            ],
          },
        ],
      });
      const app = createApp({ withDb: (use) => use(db), now });
      const res = await app.request("/api/pl/monthly");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      const body = (await res.json()) as MonthlyPnlResponse;
      expect(body).toEqual({
        months: [
          {
            month: "2026-09",
            pnl: 5_374_000,
            cumulativePnl: 5_374_000,
            closed: 1,
            wins: 1,
            winRate: 1,
            grossWins: 5_374_000,
            grossLosses: 0,
            profitFactor: null,
            trades: [
              {
                id: '["30000000-0000-4000-8000-000000000003","2026-09-30","close",null]',
                positionId,
                campaignId,
                underlying: "SPXL",
                strategy: "csp",
                date: "2026-09-30",
                action: "close",
                rollId: null,
                tradeIds: [closeId],
                pnl: 5_374_000,
              },
            ],
            byStrategy: [
              {
                strategy: "csp",
                pnl: 5_374_000,
                closed: 1,
                wins: 1,
                winRate: 1,
                grossWins: 5_374_000,
                grossLosses: 0,
                profitFactor: null,
              },
            ],
          },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it("requires no query parameters and returns an empty book before seeding", async () => {
    const { db, client } = await testDatabase();
    try {
      const app = createApp({ withDb: (use) => use(db), now });
      const res = await app.request("/api/pl/monthly");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ months: [] });
      const health = await app.request("/api/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it("does not hide the single-account invariant behind an empty response", async () => {
    const { db, client } = await testDatabase();
    try {
      await db.insert(s.accounts).values([
        { label: "one", broker: "manual" },
        { label: "two", broker: "manual" },
      ]);
      const app = createApp({ withDb: (use) => use(db), now });
      app.onError((error, c) => c.json({ error: error.message }, 500));
      const res = await app.request("/api/pl/monthly");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "More than one account: monthly P/L reads a single book",
      });
    } finally {
      await client.close();
    }
  });

  it("serves the full seeded September history through createApp", async () => {
    const { db, client } = await testDatabase();
    try {
      await seedBook(db);
      const app = createApp({ withDb: (use) => use(db), now });
      const res = await app.request("/api/pl/monthly");
      expect(res.status).toBe(200);
      const body = (await res.json()) as MonthlyPnlResponse;
      expect(body.months).toHaveLength(1);
      expect(body.months[0]).toMatchObject({
        month: "2026-09",
        pnl: 66_246_700,
        closed: 14,
        wins: 9,
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});

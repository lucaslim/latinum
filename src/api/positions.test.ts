import { describe, expect, it } from "vitest";
import * as s from "../db/schema.ts";
import { seedBook } from "../db/seed.ts";
import { testDatabase } from "../db/test/database.ts";
import { todayNY } from "../domain/dates.ts";
import { formatMoney4 } from "../domain/money.ts";
import type { OpenPositionsResponse } from "../domain/sheet.ts";
import { prototypeBook } from "../domain/test/fixtures.ts";
import { bookTotals } from "../domain/totals.ts";
import { createApp } from "./app.ts";

const now = new Date("2026-10-02T03:30:00Z");

async function appOn(setup: (db: Awaited<ReturnType<typeof testDatabase>>["db"]) => Promise<void>) {
  const { db, client } = await testDatabase();
  await setup(db);
  return { app: createApp({ withDb: (use) => use(db), now: () => now }), client };
}

describe("GET /api/positions?status=open", () => {
  it("returns the seeded open book that the domain totals reproduce", async () => {
    const { app, client } = await appOn(async (db) => void (await seedBook(db)));
    try {
      const res = await app.request("/api/positions?status=open");
      const body = (await res.json()) as OpenPositionsResponse;

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(body.asOf).toBe(todayNY(now));
      expect(body.asOf).toBe("2026-10-01");
      expect(body.positions).toHaveLength(12);
      const totals = bookTotals(body.positions);
      expect(totals.contracts).toBe(77);
      expect(formatMoney4(totals.premium, 0)).toBe("14450");
      expect(formatMoney4(totals.capitalDeployed, 0)).toBe("458398");
      expect(totals).toEqual(bookTotals(prototypeBook));
      expect(new Set(body.positions.map((p) => p.id)).size).toBe(12);
    } finally {
      await client.close();
    }
  }, 20_000);

  it.each(["", "?status=closed", "?status="])(
    "rejects %j: only status=open is served",
    async (query) => {
      const { app, client } = await appOn(async () => {});
      try {
        const res = await app.request(`/api/positions${query}`);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "status must be open" });
      } finally {
        await client.close();
      }
    },
  );

  it("returns an empty book before any account exists", async () => {
    const { app, client } = await appOn(async () => {});
    try {
      const res = await app.request("/api/positions?status=open");

      expect(await res.json()).toEqual({ asOf: "2026-10-01", positions: [] });
    } finally {
      await client.close();
    }
  });

  it("fails loudly when more than one account exists", async () => {
    const { app, client } = await appOn(async (db) => {
      await db.insert(s.accounts).values([
        { label: "one", broker: "manual" },
        { label: "two", broker: "manual" },
      ]);
    });
    try {
      const res = await app.request("/api/positions?status=open");

      expect(res.status).toBe(500);
    } finally {
      await client.close();
    }
  });
});

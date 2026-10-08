import { expect, test } from "vitest";
import { TRADE_CSV_COLUMNS } from "../db/export.types.ts";
import { testDatabase } from "../db/test/database.ts";
import { createApp } from "./app.ts";
import { noSession } from "./testGuard.ts";

test("the production app serves JSON and CSV exports of an empty journal", async () => {
  const { db, client } = await testDatabase();
  try {
    const app = createApp({
      guard: noSession,
      withDb: (use) => use(db),
      now: () => new Date("2026-10-01"),
    });
    const json = await app.request("/api/export");
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({
      version: 1,
      tables: {
        accounts: [],
        campaigns: [],
        roll_chains: [],
        positions: [],
        legs: [],
        rolls: [],
        trades: [],
        assignments: [],
        marks: [],
        platform_heartbeat: [],
      },
    });
    const csv = await app.request("/api/export?format=csv");
    expect(csv.status).toBe(200);
    expect(await csv.text()).toBe(`${TRADE_CSV_COLUMNS.join(",")}\r\n`);
  } finally {
    await client.close();
  }
}, 20_000);

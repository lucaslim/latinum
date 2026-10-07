import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { JournalExport } from "../src/db/export.types.ts";

const tradeColumns = [
  "id",
  "legId",
  "action",
  "tradeDate",
  "executedAt",
  "quantity",
  "price",
  "cash",
  "fees",
  "currency",
  "rollId",
  "source",
  "createdAt",
];

for (const viewport of [
  { width: 1400, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Export at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("downloads JSON backup and raw trade CSV from the visible control", async ({
      page,
    }, testInfo) => {
      await page.goto("/");
      const control = page.getByRole("main").getByText("Download", { exact: true });
      await expect(control).toBeVisible();
      await control.focus();
      await control.press("Enter");
      await expect(page.getByRole("link", { name: "JSON backup", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Raw trade CSV", exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);

      const jsonDownload = page.waitForEvent("download");
      await page.getByRole("link", { name: "JSON backup", exact: true }).click();
      const jsonFile = await jsonDownload;
      expect(jsonFile.suggestedFilename()).toBe("trading-journal-backup.json");
      const jsonPath = testInfo.outputPath("backup.json");
      await jsonFile.saveAs(jsonPath);
      const backup: JournalExport = JSON.parse(await readFile(jsonPath, "utf8"));

      expect(backup.version).toBe(1);
      expect(Object.keys(backup.tables).sort()).toEqual([
        "accounts",
        "assignments",
        "campaigns",
        "legs",
        "marks",
        "platform_heartbeat",
        "positions",
        "roll_chains",
        "rolls",
        "trades",
      ]);
      const dram = backup.tables.legs.find(
        (leg) => leg.underlying === "DRAM" && leg.kind === "put" && leg.strike === 500000,
      );
      expect(dram).toMatchObject({ underlying: "DRAM", kind: "put", strike: 500000 });
      const trade = backup.tables.trades.find((row) => row.legId === dram?.id);
      expect(trade).toMatchObject({
        action: "open",
        tradeDate: "2026-09-25",
        executedAt: null,
        quantity: 10,
        price: 18500,
        cash: 18500000,
        fees: 0,
        currency: "USD",
        rollId: null,
        source: "manual",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });

      const csvDownload = page.waitForEvent("download");
      await page.getByRole("link", { name: "Raw trade CSV", exact: true }).click();
      const csvFile = await csvDownload;
      expect(csvFile.suggestedFilename()).toBe("trading-journal-trades.csv");
      const csvPath = testInfo.outputPath("trades.csv");
      await csvFile.saveAs(csvPath);
      const csv = await readFile(csvPath, "utf8");
      // Stored trade fields are UUIDs, enums, dates and numbers, with no CSV delimiters.
      const [header, ...records] = csv
        .trimEnd()
        .split("\r\n")
        .map((line) => line.split(","));
      expect(header).toEqual(tradeColumns);
      const csvTrades = records.map((fields) => {
        expect(fields).toHaveLength(13);
        return Object.fromEntries(tradeColumns.map((column, index) => [column, fields[index]]));
      });
      expect(csvTrades).toHaveLength(backup.tables.trades.length);
      expect(csvTrades.find((row) => row.id === trade?.id)).toEqual({
        id: trade?.id,
        legId: dram?.id,
        action: "open",
        tradeDate: "2026-09-25",
        executedAt: "",
        quantity: "10",
        price: "1.8500",
        cash: "1850.0000",
        fees: "0.0000",
        currency: "USD",
        rollId: "",
        source: "manual",
        createdAt: trade?.createdAt,
      });
    });
  });
}

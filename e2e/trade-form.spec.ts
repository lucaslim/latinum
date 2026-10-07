import { expect, type Page, test } from "@playwright/test";
import { STRATEGY_LABELS, TRADE_STRATEGIES } from "../src/shared/trade.ts";

const viewports = [
  { width: 1400, height: 900, sheet: "sheet-table", rows: "tbody tr", footer: "tfoot" },
  { width: 390, height: 844, sheet: "sheet-cards", rows: "article", footer: ".cards-foot" },
] as const;

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  await expect(response).toBeOK();
});

test.afterEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  await expect(response).toBeOK();
});

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      containers: Array.from(
        document.querySelectorAll('form, [data-testid="sheet-table"], [data-testid="sheet-cards"]'),
      )
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          name: element.getAttribute("aria-label") ?? element.getAttribute("data-testid"),
          gap: element.scrollWidth - element.clientWidth,
        }))
        .filter(({ gap }) => gap !== 0),
    })),
  ).toEqual({ page: 0, containers: [] });
}

async function expectSameDocument(page: Page) {
  expect(
    await page.evaluate(
      () => (window as Window & { __t6DocumentSentinel?: string }).__t6DocumentSentinel,
    ),
  ).toBe("trade-form-document");
  await expect(page).toHaveURL("/");
}

async function fillDramPut(page: Page) {
  await page.getByRole("button", { name: "CSP", exact: true }).click();
  await page.getByLabel("Ticker", { exact: true }).fill("DRAM");
  await page.getByLabel("Opened on", { exact: true }).fill("2026-09-25");
  await page.getByLabel("Expiry", { exact: true }).fill("2026-10-09");
  await page.getByLabel("Quantity", { exact: true }).fill("10");
  await page.getByLabel("Strike", { exact: true }).fill("50");
  await page.getByLabel("Fill price", { exact: true }).fill("1.85");
}

for (const { width, height, sheet, rows, footer } of viewports) {
  test.describe(`Trade form at ${width}px`, () => {
    test.use({ viewport: { width, height } });

    test("adds and edits the DRAM fixture, refreshing row and totals without reload", async ({
      page,
    }) => {
      await page.goto("/");
      const book = page.getByTestId(sheet);
      const summary = page.getByRole("region", { name: "Book summary" });
      await expect(summary).toContainText("77 contracts open");
      const dramRows = book.locator(rows).filter({ hasText: "DRAM" });
      const initialDramCount = await dramRows.count();
      await page.evaluate(() => {
        (window as Window & { __t6DocumentSentinel?: string }).__t6DocumentSentinel =
          "trade-form-document";
      });

      await page.getByRole("button", { name: "Add trade", exact: true }).click();
      await fillDramPut(page);
      await expect(page.getByLabel("Fees", { exact: true })).toHaveValue("6.50");

      const derived = page.getByRole("region", { name: "Derived trade metrics" });
      await expect(derived).toContainText(/Premium\s*\$1,850/);
      await expect(derived).toContainText(/Collateral\s*\$50,000/);
      await expect(derived).toContainText(/Yield\s*3\.70%/);
      await expect(derived).toContainText(/Term\s*14 days/);
      await expect(derived).toContainText(/Annualized\s*96\.5%/);
      await expect(derived).toContainText(/Breakeven\s*\$48\.15/);
      await expect(derived).toContainText(/Cost basis if assigned\s*\$48\.15/);
      await expectNoOverflow(page);
      await page.screenshot({ path: `.verify/trade-form-${width}.png`, fullPage: true });

      await page.getByRole("button", { name: "Save trade", exact: true }).click();
      await expect(dramRows).toHaveCount(initialDramCount + 1);
      const addedRow = dramRows.filter({ hasText: "$1,850" }).last();
      await expect(addedRow).toHaveCount(1);
      await expect(addedRow).toContainText("$50,000");
      await expect(addedRow).toContainText("3.70%");
      await expect(book.locator(footer)).toContainText("87 contracts");
      await expect(book.locator(footer)).toContainText("$16,300");
      await expect(book.locator(footer)).toContainText("$484,500");
      await expect(book.locator(footer)).toContainText("$508,398");
      await expect(summary).toContainText("87 contracts open");
      await expect(summary).toContainText("$16,300");
      await expect(summary).toContainText("$508,398");
      await expectSameDocument(page);
      await expectNoOverflow(page);
      await page.screenshot({ path: `.verify/trade-saved-${width}.png`, fullPage: true });

      await addedRow.getByRole("button", { name: "Edit DRAM trade", exact: true }).click();
      await page.getByLabel("Fill price", { exact: true }).fill("2.00");
      await expect(derived).toContainText(/Premium\s*\$2,000/);
      await expect(derived).toContainText(/Collateral\s*\$50,000/);
      await expect(derived).toContainText(/Yield\s*4\.00%/);
      await expect(derived).toContainText(/Term\s*14 days/);
      await expect(derived).toContainText(/Annualized\s*104\.3%/);
      await expect(derived).toContainText(/Breakeven\s*\$48\.00/);
      await expect(derived).toContainText(/Cost basis if assigned\s*\$48\.00/);
      await expectNoOverflow(page);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();

      await expect(dramRows).toHaveCount(initialDramCount + 1);
      const editedRow = dramRows.filter({ hasText: "$2,000" });
      await expect(editedRow).toHaveCount(1);
      await expect(editedRow).toContainText("$50,000");
      await expect(editedRow).toContainText("4.00%");
      await expect(book.locator(footer)).toContainText("87 contracts");
      await expect(book.locator(footer)).toContainText("$16,450");
      await expect(book.locator(footer)).toContainText("$484,500");
      await expect(book.locator(footer)).toContainText("$508,398");
      await expect(summary).toContainText("$16,450");
      await expectSameDocument(page);
      await expectNoOverflow(page);
      await page.screenshot({ path: `.verify/trade-edited-${width}.png`, fullPage: true });
    });

    test("offers strategy and holiday-adjusted expiry chips and preserves edited fees", async ({
      page,
    }) => {
      // Freeze only the server's trading date; the seed and form options still come from PGlite.
      await page.route("**/api/positions?status=open", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), asOf: "2026-03-27" } });
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Add trade", exact: true }).click();
      const expiryChoices = page.getByRole("group", { name: "Expiry quick choices" });
      await expect(expiryChoices.getByRole("button")).toHaveText([
        "2026-04-02",
        "2026-04-10",
        "2026-04-17 M",
        "2026-04-24",
        "2026-05-01",
        "2026-05-08",
        "2026-05-15 M",
      ]);
      await expiryChoices.getByRole("button", { name: "2026-04-17 M", exact: true }).click();
      await expect(page.getByLabel("Expiry", { exact: true })).toHaveValue("2026-04-17");
      await expiryChoices.getByRole("button", { name: "2026-04-02", exact: true }).click();
      await expect(page.getByLabel("Expiry", { exact: true })).toHaveValue("2026-04-02");
      const strategies = page
        .getByRole("group", { name: "Strategy", exact: true })
        .locator(":scope > .trade-chips")
        .first();
      await expect(strategies.getByRole("button", { pressed: true })).toHaveCount(1);
      await expect(strategies.getByRole("button")).toHaveCount(10);
      await page.screenshot({ path: `.verify/trade-expiry-${width}.png`, fullPage: true });
      for (const strategy of TRADE_STRATEGIES) {
        const chip = page.getByRole("button", { name: STRATEGY_LABELS[strategy], exact: true });
        await chip.click();
        await expect(chip).toHaveAttribute("aria-pressed", "true");
        await expect(strategies.getByRole("button", { pressed: true })).toHaveCount(1);
        await expectNoOverflow(page);
      }
      await page.getByRole("button", { name: "CSP", exact: true }).click();
      await page.getByLabel("Quantity", { exact: true }).fill("10");
      const fees = page.getByLabel("Fees", { exact: true });
      await expect(fees).toHaveValue("6.50");
      await page.getByLabel("Quantity", { exact: true }).fill("15");
      await expect(fees).toHaveValue("9.75");
      await fees.fill("1.23");
      await page.getByLabel("Quantity", { exact: true }).fill("10");
      await expect(fees).toHaveValue("1.23");
    });
  });
}

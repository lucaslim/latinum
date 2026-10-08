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
  await expect(page).toHaveURL("/#/");
}

async function fillDramPut(page: Page) {
  await page.getByRole("button", { name: "CSP", exact: true }).click();
  await page.getByLabel("Ticker", { exact: true }).fill("DRAM");
  await page.getByText("Tags, notes, opened date, adjusted contract", { exact: true }).click();
  await page.getByLabel("Opened on", { exact: true }).fill("2026-09-25");
  await page.getByRole("button", { name: "Other…", exact: true }).click();
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

      await page.getByRole("button", { name: "New trade", exact: true }).click();
      await fillDramPut(page);
      await page.locator(".trade-fee-editor summary").click();
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
      await page.getByRole("button", { name: "New trade", exact: true }).click();
      const expiryChoices = page.getByRole("group", { name: "Expiry quick choices" });
      await expect(expiryChoices.getByRole("button")).toHaveText([
        "04-02 6d",
        "04-10 14d",
        "04-17 M 21d",
        "04-24 28d",
        "05-01 35d",
        "05-08 42d",
        "05-15 M 49d",
        "Other…",
      ]);
      await expiryChoices.getByRole("button", { name: "04-17 M 21d", exact: true }).click();
      await expect(page.getByText("Selected expiry: 2026-04-17", { exact: true })).toBeVisible();
      await expiryChoices.getByRole("button", { name: "04-02 6d", exact: true }).click();
      await expect(page.getByText("Selected expiry: 2026-04-02", { exact: true })).toBeVisible();
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
      await page.locator(".trade-fee-editor summary").click();
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

for (const width of [1280, 390]) {
  test.describe(`Order ticket at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("lays out a put debit spread and CSP without overflow", async ({ page }) => {
      await page.route("**/api/positions?status=open", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), asOf: "2026-10-07" } });
      });
      await page.goto("/#/trades/new");
      const form = page.getByRole("form", { name: "Add trade" });
      await expect(form).toContainText("Needs ticker, strike, fill");
      await expect(form).not.toContainText("Invalid string");
      await page.getByRole("button", { name: "Put debit spread", exact: true }).click();
      await expect(form).toContainText("Needs ticker, strikes, fills");
      await page.getByLabel("Ticker", { exact: true }).fill("SPY");
      await page.getByLabel("Long strike", { exact: true }).fill("730");
      await page.getByLabel("Short strike", { exact: true }).fill("725");
      await page.getByLabel("Long fill price", { exact: true }).fill("0.92");
      await page.getByLabel("Short fill price", { exact: true }).fill("0.40");
      await page.getByRole("button", { name: "10-16 M 9d", exact: true }).click();
      await expect(form.locator(".trade-headline")).toHaveText("SPY 730/725p 10-16 ×1");
      await expect(form.locator(".trade-legs tbody th")).toHaveText(["Buy Put", "Sell Put"]);
      const role = page.getByRole("group", { name: "Role", exact: true });
      await expect(role.getByRole("button", { name: "Hedge" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(form).toContainText("Fees $0.65 per leg (0.65 × 1)");
      await expect(form.locator(".trade-extra")).not.toHaveAttribute("open");
      const main = await form.locator(".trade-main").boundingBox();
      const summary = await form.locator(".trade-summary").boundingBox();
      expect(main).not.toBeNull();
      expect(summary).not.toBeNull();
      if (!main || !summary) throw new Error("Missing order ticket columns");
      if (width === 1280) expect(summary.x).toBeGreaterThan(main.x + main.width);
      else expect(summary.y).toBeGreaterThan(main.y + main.height);
      await expectNoOverflow(page);

      await page.getByRole("button", { name: "CSP", exact: true }).click();
      await page.getByLabel("Ticker", { exact: true }).fill("DRAM");
      await page.getByLabel("Quantity", { exact: true }).fill("10");
      await page.getByLabel("Strike", { exact: true }).fill("50");
      await page.getByLabel("Fill price", { exact: true }).fill("1.85");
      await expect(form.locator(".trade-legs tbody th")).toHaveText(["Sell Put"]);
      await expect(form.locator(".trade-headline")).toHaveText("DRAM 50p 10-16 ×10");
      await expect(page.getByRole("region", { name: "Derived trade metrics" })).toContainText(
        /Premium\s*\$1,850/,
      );
      await expect(page.getByRole("button", { name: "Save trade", exact: true })).toBeEnabled();
      await expectNoOverflow(page);
    });
  });
}

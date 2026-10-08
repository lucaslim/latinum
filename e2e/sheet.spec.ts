import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  expect(response.status()).toBe(200);
});

const viewports = [
  { width: 1400, height: 900, totals: "sheet-table" },
  { width: 390, height: 844, totals: "sheet-cards" },
] as const;

for (const { width, height, totals } of viewports) {
  test.describe(`Positions Sheet at ${width}px`, () => {
    test.use({ viewport: { width, height } });

    test("shows the seed book totals and does not overflow", async ({ page }) => {
      await page.goto("/");
      const book = page.getByTestId(totals);

      await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();
      const kpis = page.getByRole("region", { name: "Book summary" });
      await expect(kpis).toContainText("$14,450");
      await expect(kpis).toContainText("77 contracts open");
      await expect(kpis).toContainText("3.33%");
      await expect(kpis).toContainText("47% annualized");
      await expect(kpis).toContainText("$458,398");
      await expect(book).toContainText("77 contracts");
      await expect(book).toContainText("$14,450");
      await expect(book).toContainText("3.33%");
      await expect(book).toContainText("47%");
      await expect(book).toContainText("$458,398");
      await expect(book).toContainText("Hedges $358 at risk");

      // The prototype's check: scrollWidth equals clientWidth, for the page and for the table.
      const overflow = await page.evaluate(() => {
        const gap = (el: Element) => el.scrollWidth - el.clientWidth;
        const table = document.querySelector("[data-testid=sheet-table]");
        return { page: gap(document.documentElement), table: table ? gap(table) : 0 };
      });
      expect(overflow).toEqual({ page: 0, table: 0 });

      // Evidence for `pnpm verify`: the OS setting picks Ember (dark, default) or Paper (light).
      for (const [colorScheme, theme] of [
        ["dark", "ember"],
        ["light", "paper"],
      ] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: `.verify/sheet-${width}-${theme}.png`, fullPage: true });
      }
    });

    test("filters the Sheet while the footer follows", async ({ page }) => {
      await page.goto("/");
      const book = page.getByTestId(totals);

      await page.getByRole("button", { name: "Hedges" }).click();

      await expect(book).toContainText("4 contracts");
      await expect(book).toContainText("Hedges $358 at risk and swings $0");
      await expect(page.getByRole("region", { name: "Book summary" })).toContainText(
        "77 contracts open",
      );
    });
  });
}

test("the hedge row shows max and risk markers", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");

  const nvda = page.getByTestId("sheet-table").getByRole("row", { name: /NVDA/ });

  await expect(nvda).toContainText("$782max");
  await expect(nvda).toContainText("$218risk");
  await expect(nvda).toContainText("359%RoR");
});

import { expect, test } from "@playwright/test";

test("the shell renders", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Trading Journal" })).toBeVisible();
});

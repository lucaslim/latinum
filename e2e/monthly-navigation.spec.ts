import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("phone navigation reaches monthly P/L and returns to the unchanged Sheet", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/test/reset")).status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Main" });
  await expect(navigation).toBeVisible();
  const monthly = navigation.getByRole("link", { name: "Monthly P/L", exact: true });
  await monthly.click();
  await expect(page).toHaveURL(/#\/pl$/);
  await expect(monthly).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Positions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("$14,450");
  await expect(page.getByRole("main")).toContainText("$458,398");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
});

import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("the journal stays locked until the password is entered, and logout locks it again", async ({
  page,
}) => {
  await page.goto("/");
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open positions" })).toHaveCount(0);
  expect((await page.request.get("/api/positions?status=open")).status()).toBe(401);

  await password.fill("wrong");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong password");
  await expect(page.getByRole("heading", { name: "Open positions" })).toHaveCount(0);

  await password.fill("journal");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();

  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/positions?status=open")).status()).toBe(401);
});

test("a resumed app with an expired session goes back to the login form", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("journal");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();

  await page.context().clearCookies();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
});

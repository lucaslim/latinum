import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("NVDL drill-down shows the complete campaign fixture without phone overflow", async ({
  page,
}) => {
  await page.goto("/");
  const nvdl = page
    .getByTestId("sheet-cards")
    .getByRole("link", { name: "NVDL", exact: true })
    .first();
  await expect(nvdl).toBeVisible();
  await expect(nvdl).toHaveAttribute("href", /^#\/campaigns\/[\da-f-]{36}$/i);
  await nvdl.click();

  await expect(page).toHaveURL(/#\/campaigns\/[\da-f-]{36}$/i);
  await expect(page.getByRole("heading", { name: "NVDL campaign", level: 1 })).toBeVisible();
  const campaign = page.getByRole("main");
  for (const amount of ["$2,350", "$72,500", "$218", "$1,000", "$2,132", "$3,132"]) {
    await expect(campaign).toContainText(amount);
  }
  for (const value of ["2.94%", "34.6%", "4.32%", "31 days"]) {
    await expect(campaign).toContainText(value);
  }
  await expect(campaign).toContainText(/0\.78\s*\/sh/);
  for (const basis of ["$72.20", "$68.10", "$71.42", "$67.32"]) {
    await expect(campaign).toContainText(basis);
  }

  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
  expect(widths.client).toBe(390);

  const back = page.getByRole("link", { name: "Back to positions", exact: true });
  await expect(back).toHaveAttribute("href", "#/");
  await back.click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("heading", { name: "Open positions" })).toBeVisible();
  await expect(page.getByTestId("sheet-cards")).toBeVisible();
});

for (const { underlying, price, unrealized } of [
  { underlying: "AAPL", price: "5.10", unrealized: "−$270" },
  { underlying: "CRWD", price: "471.30", unrealized: "+$805" },
]) {
  test(`${underlying} manual mark updates unrealized P/L and persists after reload`, async ({
    page,
  }) => {
    await page.goto("/");
    const position = page
      .getByTestId("sheet-cards")
      .getByRole("link", { name: underlying, exact: true })
      .first();
    await expect(position).toBeVisible();
    await position.click();
    await expect(
      page.getByRole("heading", { name: `${underlying} campaign`, level: 1 }),
    ).toBeVisible();

    await page.getByLabel(`Mark price for ${underlying}`, { exact: true }).fill(price);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/legs\/[\da-f-]{36}\/mark$/.test(response.url()),
    );
    await page.getByRole("button", { name: `Save mark for ${underlying}`, exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("main")).toContainText(unrealized);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: `${underlying} campaign`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText(unrealized);
  });
}

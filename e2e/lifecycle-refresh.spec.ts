import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("a close committed before its POST response is lost cannot be resubmitted before reload", async ({
  page,
  request,
}) => {
  const setup = await request.post("/api/test/lifecycle-fixture");
  expect(setup.status()).toBe(200);
  const { muu } = (await setup.json()) as { muu: { campaignId: string; positionId: string } };
  await page.goto(`/#/campaigns/${muu.campaignId}`);
  await page.getByRole("button", { name: "Close MUU position", exact: true }).click();
  await page.getByLabel("Quantity for MUU short put 25.00", { exact: true }).fill("5");
  await page.getByLabel("Close price for MUU short put 25.00", { exact: true }).fill("0");
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/positions/${muu.positionId}/close`))
      posts++;
  });
  await page.route(`**/positions/${muu.positionId}/close`, async (route) => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Lifecycle action outcome is uncertain");
  await expect(page.getByRole("button", { name: "Retry campaign", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record close", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toHaveCount(
    0,
  );
  expect(posts).toBe(1);
  await page.getByRole("button", { name: "Retry campaign", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("5 open contracts");
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toBeVisible();
  expect(posts).toBe(1);
  const read = await request.get(`/api/campaigns/${muu.campaignId}`);
  const campaign = (await read.json()) as {
    positions: { legs: { trades: { action: string; quantity: number }[] }[] }[];
  };
  expect(
    campaign.positions
      .flatMap((position) => position.legs.flatMap((leg) => leg.trades))
      .filter((trade) => trade.action === "close"),
  ).toEqual([expect.objectContaining({ quantity: 5 })]);
});

test("a committed close with failed refresh requires read-only retry before more actions", async ({
  page,
  request,
}) => {
  const setup = await request.post("/api/test/lifecycle-fixture");
  expect(setup.status()).toBe(200);
  const { muu } = (await setup.json()) as {
    muu: { campaignId: string; positionId: string; legId: string };
  };
  await page.goto(`/#/campaigns/${muu.campaignId}`);
  await page.getByRole("button", { name: "Close MUU position", exact: true }).click();
  await page.getByLabel("Quantity for MUU short put 25.00", { exact: true }).fill("5");
  await page.getByLabel("Close price for MUU short put 25.00", { exact: true }).fill("0");
  let posts = 0;
  let refreshFails = true;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/positions/${muu.positionId}/close`))
      posts++;
  });
  await page.route(`**/campaigns/${muu.campaignId}`, async (route) => {
    if (refreshFails)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Refresh unavailable" }),
      });
    else await route.continue();
  });
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/positions/${muu.positionId}/close`),
  );
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("alert")).toContainText("Lifecycle action was saved");
  await expect(page.getByRole("button", { name: "Retry campaign", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record close", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toHaveCount(
    0,
  );
  expect(posts).toBe(1);
  refreshFails = false;
  await page.getByRole("button", { name: "Retry campaign", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("5 open contracts");
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toBeVisible();
  expect(posts).toBe(1);
  const read = await request.get(`/api/campaigns/${muu.campaignId}`);
  const campaign = (await read.json()) as {
    positions: { legs: { trades: { action: string; quantity: number }[] }[] }[];
  };
  expect(
    campaign.positions
      .flatMap((position) => position.legs.flatMap((leg) => leg.trades))
      .filter((trade) => trade.action === "close"),
  ).toEqual([expect.objectContaining({ quantity: 5 })]);
});

import { expect, test } from "@playwright/test";
import type { CampaignResponse } from "../src/domain/campaign.ts";

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

test("a stale retry snapshot preserves the revision and rejects a second close after lost response", async ({
  page,
  request,
}) => {
  const setup = await request.post("/api/test/lifecycle-fixture");
  expect(setup.status()).toBe(200);
  const { muu } = (await setup.json()) as { muu: { campaignId: string; positionId: string } };
  const before = await request.get(`/api/campaigns/${muu.campaignId}`);
  expect(before.status()).toBe(200);
  const stale: CampaignResponse = await before.json();
  const observed = stale.positions.find((position) => position.id === muu.positionId);
  if (!observed) throw new Error("Lifecycle fixture position missing");
  const revision = observed.revision;
  expect(revision).toMatch(/^[a-f0-9]{64}$/);
  await page.goto(`/#/campaigns/${muu.campaignId}`);
  const intents: unknown[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith(`/positions/${muu.positionId}/close`))
      intents.push(sent.postDataJSON());
  });
  await page.getByRole("button", { name: "Close MUU position", exact: true }).click();
  await page.getByLabel("Quantity for MUU short put 25.00", { exact: true }).fill("5");
  await page.getByLabel("Close price for MUU short put 25.00", { exact: true }).fill("0");
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  await page.route(
    `**/positions/${muu.positionId}/close`,
    async (route) => {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Lifecycle action outcome is uncertain");
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toHaveCount(
    0,
  );

  await page.route(`**/campaigns/${muu.campaignId}`, (route) => route.fulfill({ json: stale }), {
    times: 1,
  });
  await page.getByRole("button", { name: "Retry campaign", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("10 open contracts");
  await page.getByRole("button", { name: "Close MUU position", exact: true }).click();
  await page.getByLabel("Quantity for MUU short put 25.00", { exact: true }).fill("5");
  await page.getByLabel("Close price for MUU short put 25.00", { exact: true }).fill("0");
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/positions/${muu.positionId}/close`),
  );
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  const conflict = await rejected;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toEqual({
    error: "Position changed. Reload the campaign before another action.",
    code: "stale_revision",
  });
  await expect(page.getByRole("alert")).toContainText(
    "Position changed. Reload the campaign before another action.",
  );
  await expect(page.getByRole("button", { name: "Record close", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toHaveCount(
    0,
  );
  expect(intents).toEqual([
    {
      expectedRevision: revision,
      tradeDate: "2026-10-16",
      fills: [expect.objectContaining({ quantity: 5, price: "0", fees: "-6.5000" })],
    },
    {
      expectedRevision: revision,
      tradeDate: "2026-10-16",
      fills: [expect.objectContaining({ quantity: 5, price: "0", fees: "-6.5000" })],
    },
  ]);

  await page.getByRole("button", { name: "Retry campaign", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("5 open contracts");
  await expect(page.getByRole("button", { name: "Close MUU position", exact: true })).toBeVisible();
  expect(intents).toHaveLength(2);
  const read = await request.get(`/api/campaigns/${muu.campaignId}`);
  expect(read.status()).toBe(200);
  const campaign: CampaignResponse = await read.json();
  const current = campaign.positions.find((position) => position.id === muu.positionId);
  if (!current) throw new Error("Lifecycle position missing");
  expect(current.revision).not.toBe(revision);
  expect(
    current.legs.flatMap((leg) => leg.trades).filter((trade) => trade.action === "close"),
  ).toEqual([expect.objectContaining({ quantity: 5 })]);
});

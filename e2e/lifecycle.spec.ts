import { expect, test } from "@playwright/test";

interface FixturePosition {
  positionId: string;
  campaignId: string;
  legId: string;
}
interface Fixtures {
  muu: FixturePosition;
  spxl: FixturePosition;
  dram: FixturePosition;
  hedge: { positionId: string; campaignId: string };
  targetCampaignId: string;
}
let fixtures: Fixtures;
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/lifecycle-fixture");
  expect(response.status()).toBe(200);
  fixtures = await response.json();
});

test("an open campaign offers a close action on phone", async ({ page }) => {
  await page.goto("/");
  await page
    .getByTestId("sheet-cards")
    .getByRole("link", { name: "AAPL", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Close AAPL position", exact: true }),
  ).toBeVisible();
});

test("partial close of five MUU contracts refreshes without reload and books pro-rata net P/L", async ({
  page,
}) => {
  await page.goto(`/#/campaigns/${fixtures.muu.campaignId}`);
  await page.getByRole("button", { name: "Close MUU position", exact: true }).click();
  await page.getByLabel("Quantity for MUU short put 25.00", { exact: true }).fill("5");
  await page.getByLabel("Close price for MUU short put 25.00", { exact: true }).fill("0");
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/positions/${fixtures.muu.positionId}/close`),
  );
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("main")).toContainText("5 open contracts");
  await expect(page.getByRole("status")).toContainText("Realized net P/L +$746.70");
  await expect(page.getByRole("region", { name: "Recorded timeline", exact: true })).toContainText(
    "close",
  );
});

test("SPXL close records both fees and the $537.40 net fixture", async ({ page }) => {
  await page.goto(`/#/campaigns/${fixtures.spxl.campaignId}`);
  await page.getByRole("button", { name: "Close SPXL position", exact: true }).click();
  await page.getByLabel("Close price for SPXL short put 240.00", { exact: true }).fill("0.4000");
  await page.getByLabel("Close fees for SPXL short put 240.00", { exact: true }).fill("-1.30");
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Realized net P/L +$537.40");
  await expect(page.getByRole("main")).toContainText("0 open contracts");
  await expect(page.getByRole("button", { name: "Close SPXL position", exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByRole("region", { name: "Recorded timeline", exact: true })).toContainText(
    "close",
  );
});

test("MUU expiration books $1,493.40 and a repeat is a conflict", async ({ page, request }) => {
  await page.goto(`/#/campaigns/${fixtures.muu.campaignId}`);
  await page.getByRole("button", { name: "Expire MUU options", exact: true }).click();
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  await page.getByRole("button", { name: "Record expiration", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Realized net P/L +$1,493.40");
  const timeline = page.getByRole("region", { name: "Recorded timeline", exact: true });
  await expect(timeline).toContainText("expire");
  await expect(timeline).toContainText("10 contracts at $0.00 · Cash +$0 · Fees $0.00");
  const repeat = await request.post(`/api/positions/${fixtures.muu.positionId}/expire`, {
    data: { tradeDate: "2026-10-16" },
  });
  expect(repeat.status()).toBe(409);
});

test("DRAM assignment preserves strike cash entry, displays wheel basis and retains unavailable CC offer", async ({
  page,
}) => {
  await page.goto(`/#/campaigns/${fixtures.dram.campaignId}`);
  await page.getByRole("button", { name: "Assign DRAM put", exact: true }).click();
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  await page.getByRole("button", { name: "Record assignment", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Realized net P/L +$2,990.10");
  await expect(page.getByRole("status")).toContainText("1,500 shares · Wheel basis $53.00");
  const swing = page.getByRole("region", { name: "DRAM swing", exact: true });
  await expect(swing).toContainText(/Quantity\s*1,500 shares/);
  await expect(swing).toContainText(/Entry\s*\$55\.00/);
  await expect(swing).toContainText(/Assigned share basis\s*\$53\.00/);
  await expect(
    page.getByRole("button", { name: "Sell covered call", exact: true }).first(),
  ).toBeDisabled();
  await expect(page.getByRole("main")).toContainText("Available after trade-form integration");
  await page.reload();
  await expect(page.getByRole("region", { name: "DRAM swing", exact: true })).toContainText(
    /Assigned share basis\s*\$53\.00/,
  );
  await expect(page.getByRole("button", { name: "Sell covered call", exact: true })).toBeDisabled();
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths).toEqual({ scroll: 390, client: 390 });
});

test("per-leg spread close rejects an unbalanced remainder and records both fills", async ({
  page,
}) => {
  await page.goto(`/#/campaigns/${fixtures.hedge.campaignId}`);
  await page.getByRole("button", { name: "Close NVDA position", exact: true }).click();
  await page.getByLabel("Include NVDA short put 8.00", { exact: true }).uncheck();
  await page.getByLabel("Close price for NVDA long put 10.00", { exact: true }).fill("1.00");
  await page.getByLabel("Trade date", { exact: true }).fill("2026-10-16");
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 400");
  await page.getByLabel("Include NVDA short put 8.00", { exact: true }).check();
  await page.getByLabel("Close price for NVDA short put 8.00", { exact: true }).fill("0.10");
  await page.getByRole("button", { name: "Record close", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Realized net P/L −$128.00");
  const timeline = page.getByRole("region", { name: "Recorded timeline", exact: true });
  await expect(timeline).toContainText("1 contracts at $1.00");
  await expect(timeline).toContainText("1 contracts at $0.10");
});

test("link hedge preserves the source and points to the target campaign", async ({
  page,
  request,
}) => {
  await page.goto(`/#/campaigns/${fixtures.hedge.campaignId}`);
  await page.getByRole("button", { name: "Link NVDA hedge", exact: true }).click();
  await page.getByLabel("Target campaign UUID", { exact: true }).fill(fixtures.targetCampaignId);
  await page.getByRole("button", { name: "Record hedge link", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Hedge moved; source campaign preserved");
  await expect(
    page.getByRole("link", { name: "Open target campaign", exact: true }),
  ).toHaveAttribute("href", `#/campaigns/${fixtures.targetCampaignId}`);
  const source = await request.get(`/api/campaigns/${fixtures.hedge.campaignId}`);
  expect(source.status()).toBe(200);
  await page.getByRole("link", { name: "Open target campaign", exact: true }).click();
  await expect(page.getByRole("main")).toContainText("NVDA");
});

test("pending disables duplicate submission and API errors leave feedback without retry", async ({
  page,
}) => {
  await page.goto(`/#/campaigns/${fixtures.muu.campaignId}`);
  await page.getByRole("button", { name: "Expire MUU options", exact: true }).click();
  let release: () => void = () => {
    throw new Error("No pending request");
  };
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  await page.route(`**/positions/${fixtures.muu.positionId}/expire`, async (route) => {
    posts += 1;
    await pending;
    await route.fulfill({ status: 400, json: { error: "Expiration cannot precede expiry" } });
  });
  await page.getByRole("button", { name: "Record expiration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record expiration", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Trade date", { exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText(
    "Expiration cannot precede expiry (HTTP 400)",
  );
  expect(posts).toBe(1);
  await expect(page.getByRole("button", { name: "Record expiration", exact: true })).toBeEnabled();
});

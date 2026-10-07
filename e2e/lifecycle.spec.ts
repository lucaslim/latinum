import { expect, test } from "@playwright/test";
import type { CampaignResponse } from "../src/domain/campaign.ts";
import type { TradeFormOptions } from "../src/shared/trade.ts";

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

test("DRAM assignment opens the real prefilled CC form and saves against the same stock without double capital", async ({
  page,
  request,
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
  const stockLegId = await swing.locator("[data-stock-leg-id]").getAttribute("data-stock-leg-id");
  expect(stockLegId).toMatch(/^[0-9a-f-]{36}$/);
  const offer = page.getByRole("button", { name: "Sell covered call", exact: true });
  await expect(offer).toBeEnabled();
  await offer.click();
  const form = page.getByRole("form", { name: "Add trade", exact: true });
  await expect(form.getByRole("button", { name: "CC", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(form.getByLabel("Ticker", { exact: true })).toHaveValue("DRAM");
  await expect(form.getByLabel("Quantity", { exact: true })).toHaveValue("15");
  await expect(form.getByLabel("Opened on", { exact: true })).toHaveValue("2026-10-16");
  await expect(form.getByRole("combobox", { name: "Covered shares", exact: true })).toHaveValue(
    stockLegId ?? "",
  );
  await expect(form.getByLabel("Share basis", { exact: true })).toHaveValue("53.0000");
  await expect(form.getByLabel("Share basis", { exact: true })).toHaveAttribute("readonly", "");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "DRAM swing", exact: true })).toContainText(
    /Assigned share basis\s*\$53\.00/,
  );
  await expect(offer).toBeEnabled();
  await offer.click();
  await expect(form.getByLabel("Share basis", { exact: true })).toHaveValue("53.0000");
  await form.getByLabel("Strike", { exact: true }).fill("55");
  await form.getByLabel("Fill price", { exact: true }).fill("1.10");
  await form.getByLabel("Expiry", { exact: true }).fill("2026-11-20");
  await form.getByLabel("Fees", { exact: true }).fill("9.75");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/positions") && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Save trade", exact: true }).click();
  const created = await saved;
  expect(created.status()).toBe(201);
  expect(created.request().postDataJSON()).toMatchObject({
    strategy: "cc",
    underlying: "DRAM",
    quantity: 15,
    cover: { kind: "assigned", stockLegId },
    price: "1.10",
    fees: "9.75",
  });
  expect(await created.json()).toMatchObject({ campaignId: fixtures.dram.campaignId });
  await expect(form).toHaveCount(0);
  const coveredCall = page.getByRole("region", { name: "DRAM covered call", exact: true });
  await expect(coveredCall).toContainText(/Assigned share basis\s*\$53\.00/);
  await expect(coveredCall).toContainText(/Adjusted share basis\s*\$51\.90/);
  await expect(coveredCall).toContainText(/Collateral\s*\$82,500/);
  const campaignResponse = await request.get(`/api/campaigns/${fixtures.dram.campaignId}`);
  expect(campaignResponse.status()).toBe(200);
  const campaign: CampaignResponse = await campaignResponse.json();
  const stocks = campaign.positions
    .flatMap((position) => position.legs)
    .filter((leg) => leg.kind === "stock");
  expect(stocks).toHaveLength(1);
  expect(stocks[0]).toMatchObject({ id: stockLegId });
  expect(stocks[0]?.trades).toHaveLength(1);
  expect(stocks[0]?.trades[0]).toMatchObject({
    action: "open",
    quantity: 1500,
    price: 550000,
    cash: -825000000,
  });
  const calls = campaign.positions
    .filter((position) => position.strategy === "cc")
    .flatMap((position) => position.legs);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ kind: "call", coveredLegId: stockLegId });
  await page.getByRole("link", { name: "Back to positions", exact: true }).click();
  const cards = page
    .getByTestId("sheet-cards")
    .getByRole("article")
    .filter({
      has: page
        .getByRole("link", { name: "DRAM", exact: true })
        .and(page.locator(`[href="#/campaigns/${fixtures.dram.campaignId}"]`)),
    });
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("$82,500");
  await expect(cards).not.toContainText("$165,000");
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths).toEqual({ scroll: 390, client: 390 });
});

test("covered call options load errors are retryable without leaving the campaign", async ({
  page,
  request,
}) => {
  const assigned = await request.post(`/api/positions/${fixtures.dram.positionId}/assign`, {
    data: { legId: fixtures.dram.legId, tradeDate: "2026-10-16" },
  });
  expect(assigned.status()).toBe(200);
  await page.goto(`/#/campaigns/${fixtures.dram.campaignId}`);
  await page.route(
    "**/api/trade-form/options",
    async (route) => {
      await route.fulfill({ status: 503, json: { error: "Options temporarily unavailable" } });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Sell covered call", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 503: Options temporarily unavailable");
  await page.getByRole("button", { name: "Retry covered call", exact: true }).click();
  await expect(page.getByRole("form", { name: "Add trade", exact: true })).toBeVisible();
  await expect(page.getByLabel("Share basis", { exact: true })).toHaveValue("53.0000");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("form", { name: "Add trade", exact: true })).toHaveCount(0);
});

for (const availability of ["missing", "insufficient"] as const) {
  test(`covered call resolves fresh authoritative options and refuses ${availability} shares`, async ({
    page,
    request,
  }) => {
    const assigned = await request.post(`/api/positions/${fixtures.dram.positionId}/assign`, {
      data: { legId: fixtures.dram.legId, tradeDate: "2026-10-16" },
    });
    expect(assigned.status()).toBe(200);
    const response = await request.get("/api/trade-form/options");
    expect(response.status()).toBe(200);
    const options: TradeFormOptions = await response.json();
    await page.goto(`/#/campaigns/${fixtures.dram.campaignId}`);
    await page.route(
      "**/api/trade-form/options",
      async (route) => {
        await route.fulfill({
          json: {
            ...options,
            assignedStock:
              availability === "missing"
                ? []
                : options.assignedStock.map((stock) => ({
                    ...stock,
                    uncoveredShares: 99,
                  })),
          },
        });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Sell covered call", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      availability === "missing"
        ? "Assigned shares are no longer available"
        : "Insufficient uncovered shares",
    );
    await expect(page.getByRole("form", { name: "Add trade", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry covered call", exact: true }).click();
    await expect(page.getByLabel("Quantity", { exact: true })).toHaveValue("15");
    await expect(page.getByLabel("Share basis", { exact: true })).toHaveValue("53.0000");
  });
}

for (const dismissal of ["cancel", "navigation"] as const) {
  test(`${dismissal} discards stale covered call option responses`, async ({ page, request }) => {
    const assigned = await request.post(`/api/positions/${fixtures.dram.positionId}/assign`, {
      data: { legId: fixtures.dram.legId, tradeDate: "2026-10-16" },
    });
    expect(assigned.status()).toBe(200);
    const response = await request.get("/api/trade-form/options");
    expect(response.status()).toBe(200);
    const options: TradeFormOptions = await response.json();
    await page.goto(`/#/campaigns/${fixtures.dram.campaignId}`);
    let release: () => void = () => {
      throw new Error("No options request pending");
    };
    let markIntercepted: () => void = () => {
      throw new Error("No request listener");
    };
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Promise<void>((resolve) => {
      markIntercepted = resolve;
    });
    await page.route(
      "**/api/trade-form/options",
      async (route) => {
        markIntercepted();
        await pending;
        await route.fulfill({ json: options });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Sell covered call", exact: true }).click();
    await intercepted;
    const loading = page.getByRole("region", { name: "Sell covered call", exact: true });
    await expect(loading).toContainText("Loading covered call options");
    if (dismissal === "cancel") {
      await loading.getByRole("button", { name: "Cancel", exact: true }).click();
    } else {
      await page.getByRole("link", { name: "Back to positions", exact: true }).click();
    }
    const stale = page.waitForResponse((result) =>
      result.url().endsWith("/api/trade-form/options"),
    );
    release();
    await stale;
    await expect(
      page.getByRole("heading", {
        name: dismissal === "cancel" ? "DRAM lifecycle campaign" : "Open positions",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("form", { name: "Add trade", exact: true })).toHaveCount(0);
    if (dismissal === "navigation") await page.goto(`/#/campaigns/${fixtures.dram.campaignId}`);
    await page.getByRole("button", { name: "Sell covered call", exact: true }).click();
    await expect(page.getByLabel("Share basis", { exact: true })).toHaveValue("53.0000");
  });
}

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

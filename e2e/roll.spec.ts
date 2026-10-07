import { expect, test } from "@playwright/test";
import type { RollRequest, RollResponse } from "../src/contracts/roll.ts";
import type { CampaignResponse } from "../src/domain/campaign.ts";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  expect(response.status()).toBe(200);
});

for (const width of [1400, 390]) {
  test(`QQQ atomic roll books October gross −56, cash −70, chain −210 and updates the ${width}px Sheet without reload`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const documentStarted = await page.evaluate(() => performance.timeOrigin);
    const sheet = page.getByTestId(width === 390 ? "sheet-cards" : "sheet-table");
    await sheet.getByRole("link", { name: "QQQ", exact: true }).click();
    const beforeRead = await request.get(`/api/campaigns/${page.url().split("/campaigns/")[1]}`);
    expect(beforeRead.status()).toBe(200);
    const before: CampaignResponse = await beforeRead.json();
    const position = before.positions.find((position) => position.underlying === "QQQ");
    if (!position) throw new Error("Seeded QQQ position missing");
    const long = position.legs.find((leg) => leg.side === "long");
    const short = position.legs.find((leg) => leg.side === "short");
    if (!long || !short) throw new Error("Seeded QQQ synthetic spread legs missing");
    await page.getByRole("button", { name: "Roll options", exact: true }).click();
    const form = page.getByRole("form", { name: "Roll position" });
    await form.getByLabel("Roll trade date", { exact: true }).fill("2026-10-01");
    await form.getByLabel("Close price for QQQ long put 670.00", { exact: true }).fill("0.42");
    await form.getByLabel("Open price for QQQ long put 670.00", { exact: true }).fill("0.77");
    await form.getByLabel("Close price for QQQ short put 665.00", { exact: true }).fill("0");
    await form.getByLabel("Open price for QQQ short put 665.00", { exact: true }).fill("0");
    for (const side of ["long put 670.00", "short put 665.00"]) {
      await form.getByLabel(`Close fees (charge) for QQQ ${side}`, { exact: true }).fill("0");
      await form.getByLabel(`Open fees (charge) for QQQ ${side}`, { exact: true }).fill("0");
    }
    await form.getByRole("button", { name: "2026-11-06", exact: true }).click();
    await expect(
      form.getByRole("group", { name: "Roll expiry quick choices" }).getByRole("button"),
    ).toHaveCount(6);
    const derived = form.getByRole("region", { name: "Derived roll metrics" });
    await expect(derived).toContainText("Closing realized gross−$56.00");
    await expect(derived).toContainText("Roll cash gross−$70.00");
    await expect(derived).toContainText("Chain cash gross−$210.00");
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths).toEqual({ scroll: width, client: width });
    const saved = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/rolls"),
    );
    await form.getByRole("button", { name: "Save roll", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const sent: RollRequest = response.request().postDataJSON();
    expect(sent).toEqual({
      positionId: position.id,
      expectedRevision: position.revision,
      tradeDate: "2026-10-01",
      expiry: "2026-11-06",
      fills: expect.arrayContaining([
        {
          legId: long.id,
          closePrice: "0.42",
          closeFees: "0.0000",
          strike: "670.0000",
          openPrice: "0.77",
          openFees: "0.0000",
        },
        {
          legId: short.id,
          closePrice: "0",
          closeFees: "0.0000",
          strike: "665.0000",
          openPrice: "0",
          openFees: "0.0000",
        },
      ]),
    });
    const result: RollResponse = await response.json();
    expect(result.metrics).toEqual({
      realizedGross: -560000,
      realizedNet: -560000,
      rollCashGross: -700000,
      rollCashNet: -700000,
      chainCashGross: -2100000,
      chainCashNet: -2100000,
    });
    expect(sent.fills).toHaveLength(2);
    expect(result.realized).toHaveLength(2);
    expect(result.realized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pnl: -560000, bookedMonth: "2026-10" }),
        expect.objectContaining({ pnl: 0, bookedMonth: "2026-10" }),
      ]),
    );
    const chain = page.getByRole("region", {
      name: `Roll chain ${result.rollChainId}`,
      exact: true,
    });
    await expect(chain).toContainText("Chain cash gross−$210.00");
    await expect(chain).toContainText("Chain cash net−$210.00");
    await expect(chain).toContainText("Realized gross −$56.00");
    await expect(chain).toContainText("Realized net −$56.00");
    await expect(chain).toContainText("Booked in 2026-10");
    await expect(page.getByRole("button", { name: "Roll options", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Roll options", exact: true }).click();
    await expect(page.getByRole("form", { name: "Roll position" })).toContainText(
      "Expiry 2026-11-06",
    );
    await expect(page.getByRole("button", { name: "2026-11-13", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to positions", exact: true }).click();
    const row =
      width === 390
        ? sheet
            .locator("article")
            .filter({ has: page.getByRole("link", { name: "QQQ", exact: true }) })
        : sheet
            .getByRole("row")
            .filter({ has: page.getByRole("link", { name: "QQQ", exact: true }) });
    await expect(row).toContainText("rolled");
    await expect(row).toContainText("Nov 6");
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStarted);
  });
}

test("a stale roll revision removes every mutation until a read-only campaign retry", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByTestId("sheet-table").getByRole("link", { name: "QQQ", exact: true }).click();
  const campaignId = page.url().split("/campaigns/")[1];
  const snapshotRead = await request.get(`/api/campaigns/${campaignId}`);
  expect(snapshotRead.status()).toBe(200);
  const snapshot: CampaignResponse = await snapshotRead.json();
  const position = snapshot.positions[0];
  if (!position) throw new Error("QQQ snapshot missing");
  await page.getByRole("button", { name: "Roll options", exact: true }).click();
  const external = await request.post(`/api/positions/${position.id}/close`, {
    data: {
      expectedRevision: position.revision,
      tradeDate: "2026-10-01",
      fills: position.legs.map((leg) => ({ legId: leg.id, quantity: 1, price: "0", fees: "0" })),
    },
  });
  expect(external.status()).toBe(200);
  const rejected = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/rolls"),
  );
  await page.getByRole("button", { name: "Save roll", exact: true }).click();
  const conflict = await rejected;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toEqual({
    error: "Position changed. Reload the campaign before another action.",
    code: "stale_revision",
  });
  await expect(page.getByRole("alert")).toContainText("Position changed");
  await expect(page.getByRole("button", { name: "Roll options", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close QQQ position", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Retry campaign", exact: true }).click();
  await page.getByRole("button", { name: "Roll options", exact: true }).click();
  await expect(page.getByRole("form", { name: "Roll position" })).toContainText("1 contracts");
});

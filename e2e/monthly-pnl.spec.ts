import { expect, test } from "@playwright/test";

// Transport fixture, not prototype history: exercises month selection and a zero gap.
const selectionData = {
  months: [
    {
      month: "2026-09",
      pnl: 1000000,
      cumulativePnl: 1000000,
      closed: 2,
      wins: 1,
      winRate: 0.5,
      grossWins: 1500000,
      grossLosses: 500000,
      profitFactor: 3,
      trades: [
        {
          id: "win",
          positionId: "p1",
          campaignId: "c1",
          underlying: "WIN",
          strategy: "csp",
          date: "2026-09-18",
          action: "expire",
          rollId: null,
          tradeIds: ["win-fill"],
          pnl: 1500000,
        },
        {
          id: "loss",
          positionId: "p2",
          campaignId: "c2",
          underlying: "LOSS",
          strategy: "csp",
          date: "2026-09-25",
          action: "close",
          rollId: null,
          tradeIds: ["loss-fill"],
          pnl: -500000,
        },
      ],
      byStrategy: [
        {
          strategy: "csp",
          pnl: 1000000,
          closed: 2,
          wins: 1,
          winRate: 0.5,
          grossWins: 1500000,
          grossLosses: 500000,
          profitFactor: 3,
        },
      ],
    },
    {
      month: "2026-10",
      pnl: -1000000,
      cumulativePnl: 0,
      closed: 1,
      wins: 0,
      winRate: 0,
      grossWins: 0,
      grossLosses: 1000000,
      profitFactor: 0,
      trades: [
        {
          id: "oct",
          positionId: "p3",
          campaignId: "c3",
          underlying: "OCT",
          strategy: "day_trade",
          date: "2026-10-01",
          action: "close",
          rollId: null,
          tradeIds: ["oct-fill"],
          pnl: -1000000,
        },
      ],
      byStrategy: [
        {
          strategy: "day_trade",
          pnl: -1000000,
          closed: 1,
          wins: 0,
          winRate: 0,
          grossWins: 0,
          grossLosses: 1000000,
          profitFactor: 0,
        },
      ],
    },
    {
      month: "2026-11",
      pnl: 0,
      cumulativePnl: 0,
      closed: 0,
      wins: 0,
      winRate: null,
      grossWins: 0,
      grossLosses: 0,
      profitFactor: null,
      trades: [],
      byStrategy: [],
    },
  ],
};

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/test/reset");
  expect(reset.status()).toBe(200);
});

for (const width of [390, 1400]) {
  test.describe(`Monthly P/L at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("seed reconciles September outcomes, strategies, campaign links and unchanged Sheet", async ({
      page,
    }) => {
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Monthly P/L" })
        .click();
      await expect(page).toHaveURL(/#\/pl$/);
      await expect(page.getByRole("heading", { name: "Monthly P/L", exact: true })).toBeVisible();
      const details = page.getByRole("region", { name: "September 2026 details" });
      const summary = details.getByRole("definition");
      await expect(summary).toHaveText([
        "+$6,624.67",
        "14",
        "9",
        "64.3%",
        "3.29",
        "$9,516.97",
        "$2,892.30",
      ]);
      const closures = details.getByRole("list", { name: "Closed trades" });
      await expect(closures.getByRole("listitem")).toHaveCount(14);
      await expect(
        closures
          .getByRole("listitem")
          .filter({ has: page.getByRole("link", { name: "DRAM", exact: true }) }),
      ).toContainText("+$2,990.10");
      await expect(
        closures
          .getByRole("listitem")
          .filter({ has: page.getByRole("link", { name: "TQQQ", exact: true }) }),
      ).toContainText("−$813.20");
      const strategies = details.getByRole("table", { name: "By strategy" });
      await expect(strategies).toContainText("Cash-secured put");
      await expect(strategies).toContainText("Day trade");
      const chart = page.getByRole("img", { name: "Monthly net P/L and cumulative P/L" });
      await expect(chart).toHaveAccessibleDescription(
        /Bars show monthly net P\/L; the line shows cumulative net P\/L/,
      );
      await expect(chart.locator("rect")).toHaveCount(1);
      await expect(page.getByRole("list", { name: "Months and exact chart values" })).toContainText(
        "September 2026: monthly +$6,624.67; cumulative +$6,624.67",
      );
      expect(
        await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          table:
            (document.querySelector(".monthly-strategies")?.scrollWidth ?? 0) -
            (document.querySelector(".monthly-strategies")?.clientWidth ?? 0),
        })),
      ).toEqual({ page: 0, table: 0 });
      const dram = closures.getByRole("link", { name: "DRAM", exact: true });
      await expect(dram).toHaveAttribute("href", /^#\/campaigns\/[\da-f-]{36}$/i);
      await dram.click();
      await expect(page.getByRole("heading", { name: "DRAM campaign", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to positions", exact: true }).click();
      const book = page.getByRole("region", { name: "Book summary" });
      for (const value of ["77 contracts open", "$14,450", "3.33%", "47% annualized", "$458,398"]) {
        await expect(book).toContainText(value);
      }
    });

    test("keyboard month selection updates closures and ratios, including a zero gap", async ({
      page,
    }) => {
      await page.route("**/api/pl/monthly", (route) => route.fulfill({ json: selectionData }));
      await page.goto("/#/pl");
      const november = page.getByRole("button", { name: "November 2026", exact: true });
      await expect(november).toHaveAttribute("aria-pressed", "true");
      const gap = page.getByRole("region", { name: "November 2026 details" });
      await expect(gap).toContainText("No closed outcomes in this month.");
      await expect(gap.getByRole("definition")).toHaveText([
        "$0.00",
        "0",
        "0",
        "—",
        "—",
        "$0.00",
        "$0.00",
      ]);
      const september = page.getByRole("button", { name: "September 2026", exact: true });
      await september.focus();
      await page.keyboard.press("Enter");
      await expect(september).toHaveAttribute("aria-pressed", "true");
      await expect(november).toHaveAttribute("aria-pressed", "false");
      const selected = page.getByRole("region", { name: "September 2026 details" });
      await expect(selected.getByRole("definition")).toHaveText([
        "+$100.00",
        "2",
        "1",
        "50.0%",
        "3.00",
        "$150.00",
        "$50.00",
      ]);
      await expect(
        selected.getByRole("list", { name: "Closed trades" }).getByRole("listitem"),
      ).toHaveCount(2);
      const october = page.getByRole("button", { name: "October 2026", exact: true });
      await october.focus();
      await page.keyboard.press("Space");
      const loss = page.getByRole("region", { name: "October 2026 details" });
      await expect(loss.getByRole("definition")).toHaveText([
        "−$100.00",
        "1",
        "0",
        "0.0%",
        "0.00",
        "$0.00",
        "$100.00",
      ]);
      await expect(loss.getByRole("link", { name: "OCT", exact: true })).toBeVisible();
      await november.click();
      await expect(gap).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    });
  });
}

test("route shows loading, HTTP error and a read-only retry to empty", async ({ page }) => {
  let requests = 0;
  let release: () => void = () => {
    throw new Error("Missing response gate");
  };
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/pl/monthly", async (route) => {
    requests += 1;
    expect(route.request().method()).toBe("GET");
    if (requests === 1) {
      await wait;
      await route.fulfill({ status: 503 });
    } else await route.fulfill({ json: { months: [] } });
  });
  await page.goto("/#/pl");
  await expect(page.getByRole("status")).toHaveText("Loading monthly P/L…");
  release();
  await expect(page.getByRole("alert")).toHaveText("Could not load monthly P/L (HTTP 503)");
  await page.getByRole("button", { name: "Retry monthly P/L" }).click();
  await expect(page.getByRole("status")).toHaveText("No realized P/L yet.");
  await expect(page.locator(".monthly-pnl svg")).toHaveCount(0);
  expect(requests).toBe(2);
});

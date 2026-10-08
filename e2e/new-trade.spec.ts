import { expect, type Page, test } from "@playwright/test";

const DISCARD = "Discard this trade?";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  await expect(response).toBeOK();
});

test.afterEach(async ({ request }) => {
  const response = await request.post("/api/test/reset");
  await expect(response).toBeOK();
});

// Answers every native dialog the same way until told otherwise, and records what was asked.
function watchDialogs(page: Page) {
  const messages: string[] = [];
  const types: string[] = [];
  let answer: "accept" | "dismiss" = "dismiss";
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    types.push(dialog.type());
    return answer === "accept" ? dialog.accept() : dialog.dismiss();
  });
  return {
    messages,
    types,
    accept: () => {
      answer = "accept";
    },
    dismiss: () => {
      answer = "dismiss";
    },
  };
}

const newTradeButton = (page: Page) => page.getByRole("button", { name: "New trade", exact: true });
const ticker = (page: Page) => page.getByLabel("Ticker", { exact: true });
const form = (page: Page) => page.getByRole("form", { name: "Add trade", exact: true });

async function openDirtyForm(page: Page) {
  await page.goto("/");
  await newTradeButton(page).click();
  await ticker(page).fill("DRAM");
  await page.getByLabel("Strike", { exact: true }).fill("50");
  // A remount would drop this attribute along with the typed values.
  await ticker(page).evaluate((element) => element.setAttribute("data-keep", "1"));
}

async function expectFormKept(page: Page) {
  await expect(page).toHaveURL(/#\/trades\/new$/);
  await expect(ticker(page)).toHaveValue("DRAM");
  await expect(ticker(page)).toHaveAttribute("data-keep", "1");
  await expect(page.getByLabel("Strike", { exact: true })).toHaveValue("50");
}

// Dispatching the event is the only way to observe a registered handler without unloading.
// Polled because the handler is added or removed in an effect after the keystroke renders.
const expectBeforeUnloadPrevented = (page: Page, prevented: boolean) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(prevented);

const layouts = [
  { width: 1400, height: 900, sheet: "sheet-table" },
  { width: 390, height: 844, sheet: "sheet-cards" },
] as const;

for (const { width, height, sheet } of layouts) {
  test.describe(`New trade screen at ${width}px`, () => {
    test.use({ viewport: { width, height } });

    test("the sidebar button opens the form on its own screen", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId(sheet)).toBeVisible();
      await expect(page.getByRole("button", { name: "Add trade" })).toHaveCount(0);
      await expect(page.getByRole("form", { name: "Add trade", exact: true })).toHaveCount(0);

      const button = newTradeButton(page);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);

      await button.click();
      await expect(page).toHaveURL(/#\/trades\/new$/);
      await expect(form(page)).toBeVisible();
      await expect(page.getByTestId(sheet)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Book summary" })).toHaveCount(0);
      await expect(page.locator('nav[aria-label="Main"] [aria-current="page"]')).toHaveCount(0);
    });
  });
}

test.describe("N shortcut", () => {
  test("opens the new trade screen from any route", async ({ page }) => {
    await page.goto("/#/pl");
    await expect(page.getByRole("link", { name: "Monthly P/L" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("n");
    await expect(page).toHaveURL(/#\/trades\/new$/);
    await expect(form(page)).toBeVisible();
  });

  test("is ignored with a modifier or while typing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    await page.keyboard.press("Control+n");
    await page.keyboard.press("Alt+n");
    await page.keyboard.press("Shift+n");
    await expect(page).toHaveURL("/");

    await page.evaluate(() => {
      for (const html of [
        '<input id="probe-input">',
        '<textarea id="probe-textarea"></textarea>',
        '<select id="probe-select"><option>a</option></select>',
        '<div id="probe-editable" contenteditable="true" tabindex="0">x</div>',
      ]) {
        document.body.insertAdjacentHTML("beforeend", html);
      }
    });
    for (const id of ["input", "textarea", "select", "editable"]) {
      await page.locator(`#probe-${id}`).focus();
      await page.keyboard.press("n");
      await expect(page).toHaveURL("/");
    }
  });

  test("does nothing while already on the new trade screen", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("n");
    await newTradeButton(page).click();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([]);
  });
});

test.describe("leaving the new trade screen", () => {
  test("opening fee and optional editors keeps a pristine form pristine", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await page.locator(".trade-fee-editor summary").click();
    await expect(page.getByLabel("Fees", { exact: true })).toBeVisible();
    await page.getByText("Tags, notes, opened date, adjusted contract", { exact: true }).click();
    await expect(page.getByLabel("Opened on", { exact: true })).toBeVisible();
    await expectBeforeUnloadPrevented(page, false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    expect(dialogs.messages).toEqual([]);
  });

  test("a pristine form leaves on Cancel without asking", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await expectBeforeUnloadPrevented(page, false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL("/#/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    expect(dialogs.messages).toEqual([]);
  });

  test("a pristine form lets Back and sidebar links through without asking", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await page.goBack();
    await expect(page).toHaveURL("/");
    await newTradeButton(page).click();
    await page.getByRole("link", { name: "Monthly P/L" }).click();
    await expect(page).toHaveURL(/#\/pl$/);
    expect(dialogs.messages).toEqual([]);
  });

  test("a form edited back to its initial values counts as pristine", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await ticker(page).fill("DRAM");
    await ticker(page).fill("");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL("/#/");
    expect(dialogs.messages).toEqual([]);
  });

  test("Cancel on a dirty form asks, and Stay keeps everything", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([DISCARD]);
  });

  test("Cancel on a dirty form asks, and Leave returns to the positions", async ({ page }) => {
    const dialogs = watchDialogs(page);
    dialogs.accept();
    await openDirtyForm(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL("/#/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    expect(dialogs.messages).toEqual([DISCARD]);
  });

  test("Back on a dirty form asks once, and Stay keeps the form and its state", async ({
    page,
  }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    await page.goBack();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([DISCARD]);

    // Stay must not have stacked history entries: one more Back still asks exactly once.
    dialogs.accept();
    await page.goBack();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    expect(dialogs.messages).toEqual([DISCARD, DISCARD]);
  });

  test("Back on a dirty form asks, and Leave returns to the positions", async ({ page }) => {
    const dialogs = watchDialogs(page);
    dialogs.accept();
    await openDirtyForm(page);
    await page.goBack();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    expect(dialogs.messages).toEqual([DISCARD]);
  });

  test("a sidebar link on a dirty form asks, and Stay keeps the form and its state", async ({
    page,
  }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    await page.getByRole("link", { name: "Monthly P/L" }).click();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([DISCARD]);

    // The refused click left no history entry behind: Back goes straight to the positions.
    dialogs.accept();
    await page.goBack();
    await expect(page).toHaveURL("/");
    expect(dialogs.messages).toEqual([DISCARD, DISCARD]);
  });

  test("a sidebar link on a dirty form asks, and Leave follows the link once", async ({ page }) => {
    const dialogs = watchDialogs(page);
    dialogs.accept();
    await openDirtyForm(page);
    await page.getByRole("link", { name: "Positions" }).click();
    await expect(page).toHaveURL("/#/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    expect(dialogs.messages).toEqual([DISCARD]);
  });

  test("a click on empty sidebar space never asks, and a later Cancel still does", async ({
    page,
  }) => {
    const dialogs = watchDialogs(page);
    dialogs.accept();
    await openDirtyForm(page);
    const nav = page.locator('nav[aria-label="Main"]');
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    // The nav stretches below its links: the bottom corner is empty space, not a link.
    await nav.click({ position: { x: 4, y: (box?.height ?? 0) - 4 } });
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([]);
    await expectBeforeUnloadPrevented(page, true);

    dialogs.dismiss();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([DISCARD]);
  });

  test("a sidebar link to the current screen never asks", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    // The new trade screen has no sidebar link of its own: the link to it is the sidebar button.
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.id = "probe-self";
      link.href = "#/trades/new";
      link.textContent = "probe";
      document.querySelector('nav[aria-label="Main"]')?.append(link);
    });
    await page.locator("#probe-self").click();
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([]);
  });

  test("repeated outside hash changes with Stay keep one history entry and the form", async ({
    page,
  }) => {
    const dialogs = watchDialogs(page);
    await openDirtyForm(page);
    const before = await page.evaluate(() => history.length);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.evaluate(() => {
        window.location.hash = "#/pl";
      });
      await expect.poll(() => dialogs.messages.length).toBe(attempt);
      await expectFormKept(page);
    }
    expect(dialogs.messages).toEqual([DISCARD, DISCARD, DISCARD]);
    // The browser creates one entry for the first assignment; Stay never adds another, and the
    // next assignment overwrites the rejected forward entry.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);

    // Back goes to the positions, not to the rejected Monthly P/L entry.
    dialogs.accept();
    await page.goBack();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    expect(dialogs.messages).toEqual([DISCARD, DISCARD, DISCARD, DISCARD]);
  });

  test("Back with Stay keeps the history intact, so Forward still reaches the next entry", async ({
    page,
  }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await page.getByRole("link", { name: "Monthly P/L" }).click();
    await expect(page).toHaveURL(/#\/pl$/);
    await page.goBack();
    await expect(form(page)).toBeVisible();
    await ticker(page).fill("DRAM");
    await ticker(page).evaluate((element) => element.setAttribute("data-keep", "1"));
    await page.getByLabel("Strike", { exact: true }).fill("50");
    const before = await page.evaluate(() => history.length);

    await page.goBack();
    await expect.poll(() => dialogs.messages.length).toBe(1);
    await expectFormKept(page);
    expect(await page.evaluate(() => history.length)).toBe(before);

    // Forward still reaches the Monthly P/L entry, and asks because the form is dirty.
    dialogs.accept();
    await page.goForward();
    await expect(page).toHaveURL(/#\/pl$/);
    await expect(page.getByRole("link", { name: "Monthly P/L" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(dialogs.messages).toEqual([DISCARD, DISCARD]);
  });

  test("Forward with Stay keeps the form and the history", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await newTradeButton(page).click();
    await page.getByRole("link", { name: "Monthly P/L" }).click();
    await page.goBack();
    await ticker(page).fill("DRAM");
    await ticker(page).evaluate((element) => element.setAttribute("data-keep", "1"));
    await page.getByLabel("Strike", { exact: true }).fill("50");
    const before = await page.evaluate(() => history.length);

    await page.goForward();
    await expect.poll(() => dialogs.messages.length).toBe(1);
    await expectFormKept(page);
    expect(await page.evaluate(() => history.length)).toBe(before);
    expect(dialogs.messages).toEqual([DISCARD]);

    // Back from the restored form still asks exactly once and reaches the positions.
    dialogs.accept();
    await page.goBack();
    await expect(page).toHaveURL("/");
    expect(dialogs.messages).toEqual([DISCARD, DISCARD]);
  });

  test("Stay never reloads when an older entry shares the form's ordinal", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.addInitScript(() => {
      const calls: number[] = [];
      Object.assign(window, { goCalls: calls });
      const original = history.go.bind(history);
      history.go = (delta) => {
        calls.push(delta ?? 0);
        return original(delta);
      };
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Monthly P/L" }).click();
    await expect(page).toHaveURL(/#\/pl$/);
    await page.goBack();
    await expect(page).toHaveURL("/");
    // Entries created before ordinals shipped get stamped from whatever the session committed
    // last, so one can collide with the form's entry (ordinal 2 once the form is opened below).
    await page.evaluate(() => history.replaceState({ tradingJournalEntry: 2 }, ""));
    await page.goForward();
    await expect(page).toHaveURL(/#\/pl$/);
    await newTradeButton(page).click();
    await ticker(page).fill("DRAM");
    await page.getByLabel("Strike", { exact: true }).fill("50");
    await ticker(page).evaluate((element) => element.setAttribute("data-keep", "1"));

    await page.evaluate(() => history.go(-2));
    await expect.poll(() => dialogs.messages.length).toBe(1);
    await expectFormKept(page);
    expect(dialogs.messages).toEqual([DISCARD]);
    expect(dialogs.types).toEqual(["confirm"]);
    expect(await page.evaluate(() => Reflect.get(window, "goCalls"))).toEqual([-2]);
  });

  test("beforeunload is registered only while the form has unsaved input", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    await expectBeforeUnloadPrevented(page, false);
    await newTradeButton(page).click();
    await expectBeforeUnloadPrevented(page, false);
    await ticker(page).fill("DRAM");
    await expectBeforeUnloadPrevented(page, true);
    await ticker(page).fill("");
    await expectBeforeUnloadPrevented(page, false);
    await ticker(page).fill("DRAM");
    await expectBeforeUnloadPrevented(page, true);
    dialogs.accept();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL("/#/");
    await expectBeforeUnloadPrevented(page, false);
  });

  test("saving lands on the positions without asking", async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto("/");
    const dramRows = page
      .getByTestId("sheet-table")
      .locator("tbody tr")
      .filter({ hasText: "DRAM" });
    await expect(page.getByTestId("sheet-table")).toBeVisible();
    const initialDramRows = await dramRows.count();
    await newTradeButton(page).click();
    await page.getByRole("button", { name: "CSP", exact: true }).click();
    await ticker(page).fill("DRAM");
    await page.getByText("Tags, notes, opened date, adjusted contract", { exact: true }).click();
    await page.getByLabel("Opened on", { exact: true }).fill("2026-09-25");
    await page.getByRole("button", { name: "Other…", exact: true }).click();
    await page.getByLabel("Expiry", { exact: true }).fill("2026-10-09");
    await page.getByLabel("Quantity", { exact: true }).fill("10");
    await page.getByLabel("Strike", { exact: true }).fill("50");
    await page.getByLabel("Fill price", { exact: true }).fill("1.85");
    await page.getByRole("button", { name: "Save trade", exact: true }).click();
    await expect(page).toHaveURL("/#/");
    await expect(dramRows).toHaveCount(initialDramRows + 1);
    await expectBeforeUnloadPrevented(page, false);
    expect(dialogs.messages).toEqual([]);
  });
});

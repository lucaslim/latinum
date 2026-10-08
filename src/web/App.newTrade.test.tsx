import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

vi.mock("./components/ThemeSelect.tsx", () => ({ ThemeSelect: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the new trade hash opens the form route with the sidebar button marked current", () => {
  vi.stubGlobal("window", { location: { hash: "#/trades/new" } });
  const html = renderToStaticMarkup(<App onLogOut={() => {}} />);
  expect(html).toContain("Loading trade form");
  expect(html).not.toContain("Loading positions");
  expect(html).toContain('aria-label="New trade"');
  expect(html).toContain('aria-keyshortcuts="N"');
  expect(html).toMatch(/class="new-trade"[^>]*aria-current="page"/);
  expect(html).not.toContain('href="#/" aria-current="page"');
});

test("the positions route offers the button without an inline add form", () => {
  vi.stubGlobal("window", { location: { hash: "" } });
  const html = renderToStaticMarkup(<App onLogOut={() => {}} />);
  expect(html).toContain("Loading positions");
  expect(html).toContain('aria-label="New trade"');
  expect(html).not.toMatch(/class="new-trade"[^>]*aria-current/);
  expect(html).toContain('href="#/" aria-current="page"');
});

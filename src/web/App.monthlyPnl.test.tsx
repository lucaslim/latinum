import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

vi.mock("./components/ThemeSelect.tsx", () => ({ ThemeSelect: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the monthly hash opens its dashboard instead of the positions Sheet", () => {
  vi.stubGlobal("window", { location: { hash: "#/pl" } });
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("Loading monthly P/L");
  expect(html).not.toContain("Loading positions");
  expect(html).toContain('href="#/pl" aria-current="page"');
  expect(html).not.toContain('href="#/" aria-current="page"');
});

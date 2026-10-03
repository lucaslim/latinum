import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, OS_LIGHT_THEME, STORAGE_KEY, THEMES } from "./themes.ts";

const css = readFileSync("src/web/theme/tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const COLOUR_TOKENS = [
  ...["bg", "stage", "panel", "panel2", "raise", "line", "line2", "text", "muted", "dim"],
  ...["accent", "on-accent", "focus", "credit", "debit", "spread", "cc", "warn", "info"],
  ...["ccrow", "hedgerow", "swingrow", "hover"],
  ...["credit-bg", "credit-line", "info-bg", "info-line", "debit-bg"],
];
const SHARED_TOKENS = [
  "sans",
  "mono",
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`fs-${n}`, `sp-${n}`]),
  ...[1, 2, 3].map((n) => `r-${n}`),
];

/** Every `selector { declarations }` rule, including the one nested in the OS media query. */
function rules() {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({
    selectors: selector.split(",").map((s) => s.trim()),
    declared: new Map(
      [...body.matchAll(/(?:--)?([\w-]+)\s*:\s*([^;]+);/g)].map(([, k = "", v = ""]) => [
        k,
        v.trim(),
      ]),
    ),
  }));
}
const rule = (selector: string) => {
  const found = rules().filter((r) => r.selectors.includes(selector));
  expect(found, `rules for ${selector}`).toHaveLength(1);
  return found[0]?.declared ?? new Map<string, string>();
};

describe("token contract", () => {
  it("ships one block per theme, each with the full colour token set", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "ember",
      "paper",
      "graphite",
      "porcelain",
      "midnight",
      "terminal",
      "moss",
      "signal",
    ]);
    for (const { id } of THEMES) {
      const declared = rule(`[data-theme="${id}"]`);
      expect(
        COLOUR_TOKENS.filter((t) => !declared.has(t)),
        id,
      ).toEqual([]);
      expect(["dark", "light"]).toContain(declared.get("color-scheme"));
    }
  });

  it("makes the default theme the :root fallback", () => {
    expect(DEFAULT_THEME).toBe("ember");
    expect(rules().find((r) => r.selectors.includes(":root"))?.selectors).toContain(
      `[data-theme="${DEFAULT_THEME}"]`,
    );
  });

  it("follows the OS light setting with the Paper values until a theme is saved", () => {
    expect(OS_LIGHT_THEME).toBe("paper");
    expect(css).toMatch(
      /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme\]\)/,
    );
    expect(rule(":root:not([data-theme])")).toEqual(rule(`[data-theme="${OS_LIGHT_THEME}"]`));
  });

  it("defines type, spacing and radius tokens on :root", () => {
    const declared = rules().find((r) => r.selectors.includes(":root") && r.declared.has("sans"));
    expect(SHARED_TOKENS.filter((t) => !declared?.declared.has(t))).toEqual([]);
  });

  it("uses no colour literals outside tokens.css", () => {
    const offenders = sourceFiles("src/web")
      .filter((file) => !file.includes("/theme/") && !file.endsWith(".test.tsx"))
      .filter((file) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("applies the saved theme before first paint with the same storage key", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain(JSON.stringify(STORAGE_KEY));
    expect(html).toMatch(/<script>[^<]*dataset\.theme[^<]*<\/script>/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

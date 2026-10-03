import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Diagnostic {
  category: string;
  location: { path: string; start: { line: number } };
}

const fixtures = join(import.meta.dirname, "fixtures");

/**
 * The overrides in `biome.json` match on path, so a fixture only proves a rule once it sits under
 * `src/domain`. Copy it there for the length of one `biome lint` run; nothing else reads the dir.
 */
function lintAs(fixture: string, target: string): Diagnostic[] {
  const root = join(import.meta.dirname, "..", "domain");
  const dir = mkdtempSync(join(root, "guardrail-"));
  try {
    copyFileSync(join(fixtures, fixture), join(dir, target));
    const stdout = (() => {
      try {
        return execFileSync(
          "pnpm",
          ["exec", "biome", "lint", dir, "--reporter=json", "--max-diagnostics=100"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        // Biome exits non-zero when it reports errors; the JSON is still on stdout.
        return (error as { stdout: string }).stdout;
      }
    })();
    return (JSON.parse(stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hits = (diagnostics: Diagnostic[]) =>
  diagnostics.map((d) => `${d.category}:${d.location.start.line}`);

describe("lint guardrails fire on deliberately bad fixtures", () => {
  it("bans I/O, framework and layer imports in src/domain", () => {
    expect(hits(lintAs("impure-domain.txt", "impure.ts"))).toEqual([
      "lint/style/noRestrictedImports:1",
      "lint/style/noRestrictedImports:2",
      "lint/style/noRestrictedImports:3",
    ]);
  });

  it("bans float conversion in src/domain", () => {
    expect(hits(lintAs("float-money.txt", "float.ts"))).toEqual([
      "plugin:1",
      "plugin:2",
      "plugin:3",
    ]);
  });

  it("bans weak matchers, including the .not. form", () => {
    expect(hits(lintAs("weak-matchers.txt", "weak.test.ts"))).toEqual([
      "plugin:5",
      "plugin:6",
      "plugin:7",
      "plugin:8",
      "plugin:9",
      "plugin:10",
      "plugin:11",
      "plugin:12",
    ]);
  });

  it("leaves literal assertions alone", () => {
    expect(hits(lintAs("literal-matchers.txt", "literal.test.ts"))).toEqual([]);
  });
});

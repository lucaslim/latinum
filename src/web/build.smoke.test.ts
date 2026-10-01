import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

const outDir = mkdtempSync(join(tmpdir(), "tj-build-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("vite build", () => {
  it("emits a static shell that references its bundled assets", async () => {
    await build({ logLevel: "silent", build: { outDir, emptyOutDir: true } });

    const indexPath = join(outDir, "index.html");
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
    expect(readdirSync(join(outDir, "assets")).some((f) => f.endsWith(".js"))).toBe(true);
  }, 60_000);
});

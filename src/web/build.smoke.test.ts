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
    const html = readFileSync(indexPath, "utf8");
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+crossorigin="use-credentials"/);
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.webmanifest"), "utf8"));
    expect(manifest.start_url).toBe(
      "https://trading-journal-r8lqy6j1u-lucaslims-projects-af1d1be4.vercel.app/",
    );
    expect(manifest.display).toBe("standalone");
    for (const size of [192, 512]) {
      const icon = manifest.icons.find(
        (icon: { sizes: string }) => icon.sizes === `${size}x${size}`,
      );
      expect(icon.type).toBe("image/png");
      const png = readFileSync(join(outDir, icon.src));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    const sw = readFileSync(join(outDir, "sw.js"), "utf8");
    expect(sw).toContain("/^\\/api\\//");
  }, 60_000);
});

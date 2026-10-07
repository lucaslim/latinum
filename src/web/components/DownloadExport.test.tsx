import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DownloadExport } from "./DownloadExport.tsx";

describe("DownloadExport", () => {
  it("offers a native Download disclosure without depending on positions data", () => {
    const html = renderToStaticMarkup(<DownloadExport />);

    expect(html).toMatch(/^<details class="download-export">/);
    expect(html).toContain("<summary>Download</summary>");
  });

  it("provides same-origin attachment links for JSON backup and raw trade CSV", () => {
    const html = renderToStaticMarkup(<DownloadExport />);
    const links = [...html.matchAll(/<a href="([^"]+)" download="([^"]+)">([^<]+)<\/a>/g)].map(
      ([, href, download, label]) => ({ href, download, label }),
    );

    expect(links).toEqual([
      {
        href: "/api/export?format=json",
        download: "trading-journal-backup.json",
        label: "JSON backup",
      },
      {
        href: "/api/export?format=csv",
        download: "trading-journal-trades.csv",
        label: "Raw trade CSV",
      },
    ]);
  });
});

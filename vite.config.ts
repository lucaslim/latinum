import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const apiTarget = `http://localhost:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      useCredentials: true,
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Trading Journal",
        short_name: "Journal",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#111827",
        background_color: "#111827",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  build: { outDir: "dist" },
  server: { proxy: { "/api": apiTarget } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    expect: { requireAssertions: true },
    coverage: {
      provider: "v8",
      include: [
        "src/domain/**/*.ts",
        "src/db/repository.ts",
        "src/db/money.ts",
        "src/db/book.ts",
        "src/db/campaigns.ts",
        "src/db/export.ts",
        "src/api/export.ts",
        "src/web/components/DownloadExport.tsx",
        "src/db/tradeRepository.ts",
        "src/shared/*.ts",
        "src/api/trades.ts",
        "src/ops/*.ts",
      ],
      reporter: ["text", "lcov", "json-summary"],
      exclude: [
        "src/domain/**/*.test.ts",
        "src/domain/test/**",
        "src/domain/index.ts",
        "src/ops/*.test.ts",
        "src/shared/*.test.ts",
      ],
      thresholds: { lines: 95, "src/domain/**": { lines: 95 } },
    },
  },
});

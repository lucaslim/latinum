import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_WEB_PORT ?? 4173);
const apiPort = Number(process.env.E2E_API_PORT ?? 8788);

export default defineConfig({
  testDir: "e2e",
  // Browser writes share one local book; each mutating spec resets before using it.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The local API on a seeded in-memory PGlite; `vite preview` proxies /api to it.
      command: "tsx src/api/server.ts",
      env: { API_PORT: String(apiPort), E2E_MODE: "1" },
      url: `http://localhost:${apiPort}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `vite preview --port ${port} --strictPort`,
      env: { API_PORT: String(apiPort) },
      url: `http://localhost:${port}`,
      reuseExistingServer: false,
    },
  ],
});

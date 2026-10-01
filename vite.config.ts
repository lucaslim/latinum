import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = `http://localhost:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: { proxy: { "/api": apiTarget } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});

import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "visibility.spec.ts",
  outputDir: "../test-results",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
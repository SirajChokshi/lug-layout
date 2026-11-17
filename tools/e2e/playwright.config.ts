import { defineConfig } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const chromePath = process.env["CHROME"];

export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  ...(process.env["CI"] ? { workers: 2 } : {}),
  retries: 0,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
      args: ["--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: `pnpm --filter @brr/web exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

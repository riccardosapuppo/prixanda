// The console's end-to-end tests: headless Chromium (Playwright 1.62.1, the
// browser already installed for it: nothing is downloaded), against the
// whole system that e2e/run.ts starts (PostgreSQL, the engine, the gateway,
// the console's static build). One worker: the tests share one database and
// one demo session store, and they follow one story in order.
import { defineConfig } from "@playwright/test";

const base = process.env["CONSOLE_URL"] ?? `http://127.0.0.1:${process.env["CONSOLE_PORT"] ?? 4631}`;
const reports = process.env["E2E_REPORTS"] ?? "../../../reports";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  reporter: [["list"], ["junit", { outputFile: `${reports}/console-e2e.xml` }]],
  outputDir: `${reports}/console-e2e-results`,
  use: {
    baseURL: base,
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
});

/**
 * Playwright config for the DEV-ONLY browser harness (see web-test/shim.ts).
 *
 * Two servers come up: the zero-dep mock provider and the app's own vite dev server on a
 * non-Tauri port (1430 — 1420 belongs to `tauri dev`, 1421 to its HMR socket). The mock is a
 * dependency of the tests, not of the app, so it is a webServer entry rather than a globalSetup
 * child process: Playwright then owns its lifecycle and reuses an already-running instance.
 */
import { defineConfig, devices } from "@playwright/test";

const ROOT = import.meta.dirname;

export default defineConfig({
  testDir: "./web-test",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // one in-memory store per browser page; serialize to keep stories independent
  workers: 1,
  // CI-only retries, and the reason is measured rather than assumed: across three 2026-10-03 CI
  // runs a different timing-sensitive spec failed each time on a ~30 s UI stall (composer's
  // /clear, then the shortcuts palette, then both again) while every one of them passed locally,
  // in under a second, on the same commits. A runner stall is not a regression; failing the
  // whole gate on it taught the operator to re-run blind. Local runs keep zero retries — a
  // failure here is real and should be seen at once.
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000, // the wizard runs real probes + AI rounds + a QuickJS gate; allow headroom
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never", outputFolder: "web-test/.report" }]],

  use: {
    baseURL: "http://127.0.0.1:1430",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: "node web-test/mock.mjs",
      url: "http://127.0.0.1:18901/v1/models",
      cwd: ROOT,
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm exec vite --port 1430 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:1430/web-test/",
      cwd: ROOT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

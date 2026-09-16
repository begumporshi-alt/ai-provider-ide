/**
 * vitest config — the live acceptance suite lives in e2e/ and drives real HTTP against spawned
 * mock providers, so it needs node (not jsdom), generous timeouts for server boot + streaming,
 * and must not be confused with the app's src/ (no unit tests there).
 *
 * Vitest (via esbuild) is also the reason the suite can import @aiprovider/router at all: node's
 * type-stripping does not rewrite `./x.js` specifiers to `.ts`, but esbuild does.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Keep going past a failure so one flaky mock does not hide the rest of the pass.
    bail: false,
  },
});

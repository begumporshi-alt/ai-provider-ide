/**
 * vitest config — the live acceptance suite lives in e2e/ and drives real HTTP against spawned
 * mock providers, so it needs node (not jsdom), generous timeouts for server boot + streaming,
 * and must not be confused with the app's src/ (no unit tests there).
 *
 * Vitest (via esbuild) is also the reason the suite can import @aiprovider/router-core at all: node's
 * type-stripping does not rewrite `./x.js` specifiers to `.ts`, but esbuild does.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Keep going past a failure so one flaky mock does not hide the rest of the pass.
    bail: false,

    /**
     * Coverage is a **report, not a gate** — see docs/PRODUCT_COMPLETION_PLAN.md §4.2. There is no
     * threshold here on purpose: a percentage that fails a build punishes an unrelated refactor and
     * teaches people to lower the number rather than read it.
     *
     * `include` is stated rather than left to the default so the measured surface is explicit:
     * `src/**` is what this package owns. `exclude` drops the test files, which are not coverage of
     * the product — vitest excludes them by default, but naming them means a config change cannot
     * quietly start counting them.
     */
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx"],
    },
  },
});

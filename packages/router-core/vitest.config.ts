import { defineConfig } from "vitest/config";

/**
 * This package had no vitest config, so `pnpm test` has always run under vitest's defaults. That is
 * deliberate and stays true: **no `include` is set here.** Naming a test glob now would silently
 * narrow the suite to whatever this file happened to say, and the tests live in `test/` today by
 * convention rather than by configuration.
 *
 * Only coverage is configured — see docs/PRODUCT_COMPLETION_PLAN.md §4.2. It is a report, not a
 * gate: no threshold, because a percentage that fails a build teaches people to lower the number
 * instead of reading it.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});

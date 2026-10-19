import { configDefaults, defineConfig } from "vitest/config";

/**
 * No `include` glob, matching the other two packages: the tests live in `test/` by convention
 * rather than by configuration, and naming a glob here would silently narrow the suite to
 * whatever this file happened to say.
 *
 * `.verify-build/` is generated verification output — compiled JS copies of the same tests, not
 * a second suite. Vitest's defaults exclude `build`/`dist` but not this directory, so leaving it
 * in reported eleven phantom "No test suite found" failures beside the 252 real cases.
 *
 * Coverage is a report, not a gate — no threshold, because a percentage that fails a build
 * teaches people to lower the number instead of reading it.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.verify-build/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});

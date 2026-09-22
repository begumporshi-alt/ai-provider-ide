#!/usr/bin/env node
/**
 * One coverage number across three packages.
 *
 * `pnpm -r test:coverage` runs three separate vitest processes, so it writes three separate reports.
 * Three percentages and no aggregate is exactly the gap this closes
 * (docs/PRODUCT_COMPLETION_PLAN.md §4.2): without a single figure, "did this change make things
 * worse" has no answer.
 *
 * The combination is **weighted**: raw counts are summed and the percentage is recomputed. Averaging
 * the three `pct` values would weight a 300-line package the same as a 6,000-line one — a wrong
 * number that looks entirely plausible.
 *
 * A missing report is a hard error, never a zero. Summing two of three and printing a confident
 * percentage is the failure mode this script exists to prevent.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PACKAGES = [
  { name: "desktop", dir: "apps/desktop" },
  { name: "router-core", dir: "packages/router-core" },
  { name: "adapter-spec", dir: "packages/adapter-spec" },
];

const METRICS = ["statements", "branches", "functions", "lines"];

const rows = [];
const missing = [];

for (const { name, dir } of PACKAGES) {
  const file = join(ROOT, dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) {
    missing.push(`${name} — expected ${dir}/coverage/coverage-summary.json`);
    continue;
  }
  rows.push({ name, total: JSON.parse(readFileSync(file, "utf8")).total });
}

if (missing.length > 0) {
  console.error("coverage-summary: refusing to print a combined number — report(s) missing:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("\nRun `pnpm test:coverage`, which runs each package's suite first.");
  process.exit(1);
}

const combined = {};
for (const metric of METRICS) {
  combined[metric] = rows.reduce(
    (acc, row) => ({
      total: acc.total + row.total[metric].total,
      covered: acc.covered + row.total[metric].covered,
    }),
    { total: 0, covered: 0 },
  );
}

const pct = (m) => (m.total === 0 ? 100 : (m.covered / m.total) * 100);
const cell = (s) => String(s).padStart(12);
const W = 14;
const rule = "-".repeat(W + 12 * METRICS.length);

console.log(`\n${"package".padEnd(W)}${METRICS.map((m) => cell(m)).join("")}`);
console.log(rule);
for (const { name, total } of rows) {
  console.log(name.padEnd(W) + METRICS.map((m) => cell(pct(total[m]).toFixed(1) + "%")).join(""));
}
console.log(rule);
console.log("COMBINED".padEnd(W) + METRICS.map((m) => cell(pct(combined[m]).toFixed(1) + "%")).join(""));

console.log(
  `\nweighted across ${rows.length} packages: ` +
    METRICS.map((m) => `${m} ${combined[m].covered}/${combined[m].total}`).join(" · "),
);
console.log("Report only — no threshold, and not a gate step. See docs/PRODUCT_COMPLETION_PLAN.md §4.2.\n");

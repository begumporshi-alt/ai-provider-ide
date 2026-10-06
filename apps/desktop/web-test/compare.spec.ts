/**
 * web-test/compare.spec.ts — the Compare screen (one prompt, N models, side by side).
 *
 * The lane runner's semantics are pinned by vitest (`lib/compare/lane.test.ts`); this file pins
 * what a type-check cannot: the screen comes up in the sidebar, two lanes really fire the same
 * prompt at two models through the gateway ingress, both stream to done, and the per-lane
 * footers render the figures the feature exists to compare.
 */
import { expect, test } from "@playwright/test";

const APP = "/web-test/";

test("compare: two lanes stream the same prompt to done with per-lane figures", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Compare" })).toBeVisible();

  await page
    .getByLabel("Model for lane 1")
    .selectOption({ value: "sysai/oracle-mini" });
  await page
    .getByLabel("Model for lane 2")
    .selectOption({ value: "sysai/oracle-flash" });

  await page
    .getByPlaceholder("The prompt every model receives…")
    .fill("Say hello in one short sentence.");
  await page.getByRole("button", { name: "Run", exact: true }).click();

  // Both lanes settle. The mock oracle answers the same text either way — the point is that the
  // screen fires both and renders both to completion.
  await expect(page.getByText("done", { exact: true })).toHaveCount(2, { timeout: 30_000 });

  // The figures the feature exists to compare are rendered per lane: latency at minimum (total
  // is always known once a lane settles), plus the served-by line when attribution rode the wire.
  await expect(page.getByText(/total \d+ ms/)).toHaveCount(2);
  await expect(page.getByText(/served by sysai/)).toHaveCount(2);
});

test("compare: running with no model picked says so instead of silently doing nothing", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("heading", { name: "Compare" }).waitFor();

  await page.getByPlaceholder("The prompt every model receives…").fill("hello");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Pick at least one model");
});

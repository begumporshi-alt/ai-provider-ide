/**
 * web-test/settings-retention.spec.ts — history pruning is visible and opt-in.
 *
 * The store has no background deleter for transcripts or the context graph. The Settings section
 * defaults to "forever", disables the actions, and requires a preview before the confirm button is
 * even enabled. The shim returns an empty preview (it has no session age clock), which is enough to
 * pin the UI contract; the Rust retention test owns the actual deletion.
 */
import { expect, test } from "@playwright/test";

const APP = "/web-test/";

test("history retention is off by default and previews before pruning", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Router Settings", exact: true }).click();

  await expect(page.getByRole("heading", { name: "History retention" })).toBeVisible();
  const select = page.getByLabel("Keep history for");
  await expect(select).toHaveValue("0");
  await expect(page.getByText("Nothing is deleted while retention is set to forever.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview what would go" })).toBeDisabled();

  await select.selectOption("90");
  await expect(page.getByText("Nothing is deleted while retention is set to forever.")).toHaveCount(0);
  const preview = page.getByRole("button", { name: "Preview what would go" });
  await expect(preview).toBeEnabled();
  await preview.click();

  // The shim's preview is empty; the summary is rendered from the host response, not from the
  // chosen age, so the user sees what would actually go.
  await expect(page.getByText(/0 sessions · 0 messages · 0 graph nodes · 0 edges/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prune now" })).toBeDisabled();
});

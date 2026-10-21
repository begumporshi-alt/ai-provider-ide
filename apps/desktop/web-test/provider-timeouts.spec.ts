/**
 * The provider editor's per-provider timeout profile.
 *
 * The profile is stored in the `router` settings row, not the manifest, so saving it must not mint
 * a new adapter version. `?seed=systemai` gives one enabled provider, which is enough for the
 * unscoped card menu.
 */
import { expect, test, type Page } from "@playwright/test";

import { cardAction } from "./card-menu";

const APP = "/web-test/";

async function openTimeouts(page: Page): Promise<void> {
  await cardAction(page, /Edit/);
  await page.getByText("Timeouts & retries").click();
}

/** Save stays on the modal by design (`onDone` only refreshes the card), so close it explicitly. */
async function saveAndClose(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });
  // The header's ✕ also has the accessible name "Close"; the footer button is the text one.
  await page.getByText("Close", { exact: true }).click();
}

test("a timeout profile saves and is shown again on reopen", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  await openTimeouts(page);
  await page.getByLabel("Headers (seconds)").fill("60");
  await page.getByLabel("First byte (seconds)").fill("60");
  await page.getByLabel("Plan budget (seconds)").fill("180");
  await page.getByLabel("Max attempts").fill("4");
  await saveAndClose(page);

  // Reopen: the values must come back from the settings row, not from component state.
  await openTimeouts(page);
  await expect(page.getByLabel("Headers (seconds)")).toHaveValue("60");
  await expect(page.getByLabel("Plan budget (seconds)")).toHaveValue("180");
  await expect(page.getByLabel("Max attempts")).toHaveValue("4");
});

test("clearing every field removes the profile", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  await openTimeouts(page);
  await page.getByLabel("Headers (seconds)").fill("60");
  await saveAndClose(page);

  await openTimeouts(page);
  await expect(page.getByLabel("Headers (seconds)")).toHaveValue("60");
  await page.getByLabel("Headers (seconds)").fill("");
  await saveAndClose(page);

  await openTimeouts(page);
  await expect(page.getByLabel("Headers (seconds)")).toHaveValue("");
});

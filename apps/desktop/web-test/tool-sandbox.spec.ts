/**
 * web-test/tool-sandbox.spec.ts — Settings → Agent tool sandbox (2026-10-13).
 *
 * The screen edits the *additions* to `run_command`'s program allowlist, and three properties are
 * worth a browser test rather than a unit test, because each is a claim about what the user sees:
 *
 *  1. The boundary is published. The baseline count and the never-allowed list are on screen, so a
 *     user who adds `sudo` learns why it is refused instead of reading the refusal as a bug.
 *  2. The list rendered is the **host's** answer, not the typed input. The host trims, de-duplicates
 *     and sorts; a screen that echoed its own draft would pass a test that asserted the draft.
 *  3. A refusal from the host is shown, not swallowed. This is the failure mode the whole section
 *     exists around — a settings write that silently does nothing is worse than no setting.
 *
 * The shim mirrors `core::tools::normalize_extra_programs` deliberately (see `shim.ts`), so the
 * refusal asserted here is the same rule production applies rather than a test-only shortcut.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

/** The section itself, so a program name never matches the same string elsewhere on the screen. */
function sandbox(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Agent tool sandbox" }) });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({ timeout: 10_000 });
  await expect(sandbox(page).getByRole("heading", { name: "Agent tool sandbox" })).toBeVisible();
}

test("the boundary is published: a baseline count and the refused list, before anything is added", async ({
  page,
}) => {
  await openSettings(page);
  const s = sandbox(page);

  await expect(s.getByText("No additions — only the baseline programs start.")).toBeVisible();

  // The summary carries both counts, and the detail names the refused programs. Asserting the
  // count and not the copy is deliberate: the baseline list grows, the rule does not.
  await expect(s.getByText(/\d+ baseline programs · \d+ refused/)).toBeVisible();
  await s.locator("summary").click();
  await expect(s.getByText(/Refused even when added: .*sudo/)).toBeVisible();
});

test("adding a program renders the host's normalised list, and removing it returns to none", async ({
  page,
}) => {
  await openSettings(page);
  const s = sandbox(page);

  // Whitespace on purpose: the host trims, so a screen that rendered its draft would show the
  // padding and fail here.
  await s.getByLabel("Additional program").fill("  cargo  ");
  await s.getByRole("button", { name: "Add program" }).click();

  await expect(s.getByText("cargo", { exact: true })).toBeVisible();
  // The input clears on success — proof the response landed rather than the request being sent.
  await expect(s.getByLabel("Additional program")).toHaveValue("");

  await s.getByRole("button", { name: "Remove cargo" }).click();
  await expect(s.getByText("No additions — only the baseline programs start.")).toBeVisible();
});

test("a refused program surfaces the host's reason instead of silently doing nothing", async ({
  page,
}) => {
  await openSettings(page);
  const s = sandbox(page);

  await s.getByLabel("Additional program").fill("sudo");
  await s.getByRole("button", { name: "Add program" }).click();

  await expect(s.getByRole("alert")).toContainText("never allowed");
  // And it is not in the list: a refusal that still rendered the name would read as success.
  await expect(s.getByText("No additions — only the baseline programs start.")).toBeVisible();
});

/**
 * web-test/tool-result-rendering.spec.ts — a file mutation reaches the transcript as a diff.
 *
 * The gap this closes: `edit_file` / `write_file` were shown as raw JSON arguments and plain text,
 * so the one thing a coding agent produces most — a change to a file — was the one thing you could
 * not read. The diff is computed from the *call's* arguments, which live on the assistant turn, so
 * this also proves the result is joined back to its call by `tool_call_id`.
 *
 * The oracle emits the `edit_file` call for any prompt containing "edit" (see `mock.mjs`), against
 * the shim's virtual FS where `README.md` holds "hello\nworld\n".
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

test("tool result: an edit_file call renders as a diff, not a JSON argument blob", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByLabel("agent mode").check();
  // Root setup lives in its own tab now; set it there, then go back to the chat.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("edit the readme greeting");
  await page.getByRole("button", { name: "Send" }).click();

  // Approve the one mutating call. The title says "change" rather than "tool call" because this
  // call declares `effect: "mutate"` — the modal names what it is actually about to do.
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // The change is rendered, keyed by its path, with the added and removed lines visible.
  // `.first()` keeps this scoped to the transcript's own diff (the thing the defect was about)
  // rather than the run's change-set panel below it. Since 2026-10-01 the panel opens collapsed —
  // showing both copies expanded put one run's change on screen twice — so the transcript's is
  // normally the only one, and the locator is a guard rather than a necessity.
  const diff = page.getByRole("group", { name: "Diff of README.md" }).first();
  await expect(diff).toBeVisible({ timeout: 30_000 });
  await expect(diff.locator('[data-kind="add"]').filter({ hasText: "there" })).toBeVisible();
  await expect(diff.locator('[data-kind="del"]').filter({ hasText: "world" })).toBeVisible();

  // The raw argument JSON is NOT what reaches the transcript — that was the whole defect.
  await expect(page.getByText(/"old":\s*"world"/)).toHaveCount(0);
});

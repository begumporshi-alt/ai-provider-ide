/**
 * web-test/subagents.spec.ts — drive a real dispatch_agent delegation end to end.
 *
 * The oracle's chat/completions mock emits a dispatch_agent call when the user's prompt mentions
 * "delegate"; the nested run's own first round (its only user turn is the task text) falls through
 * to the list_dir branch, so the child gets a tool call of its own to record. This is the path
 * that proves the whole chain in the genuine UI: the child run is recorded with the parent's run
 * id, the confirm gate prompts for the sub-agent's read exactly as it would in the main loop, and
 * the Subagents screen lists the child with its parent linkage, its steps, and its ending.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("a delegation lands on the Subagents screen with its parent link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  // --- set up the Assistant for agent mode (same path as agent-turn.spec) ------------
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  // --- send the delegating task -------------------------------------------------------
  await page.getByPlaceholder(/Describe a task for the agent/).fill("delegate a file listing");
  await page.getByRole("button", { name: "Send" }).click();

  // --- approve the delegation itself ---------------------------------------------------
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // --- the sub-agent's read prompts too: a nested run is not a permission upgrade ------
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // --- the loop completes: sub summary, then the parent's answer on top of it ----------
  await expect(
    page.getByText("Done. Here is what I found in the workspace.").last(),
  ).toBeVisible({ timeout: 30_000 });

  // --- the Subagents screen shows the child run ----------------------------------------
  // Row content is asserted on its cell, not page-wide text: the mounted-but-hidden Assistant
  // still holds the delegation's arguments (the task string) in its transcript DOM.
  await page.getByRole("button", { name: "Subagents", exact: true }).click();
  await expect(page.getByText("1 delegated runs · 0 running · 0 hit budget · 0 failed")).toBeVisible({
    timeout: 15_000,
  });
  // The row names the child's task and the parent run it was cut from.
  await expect(page.getByRole("cell", { name: "list the files in the workspace" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /delegate a file listing/ })).toBeVisible();
  // Rounds are the child's own model round-trips (task → tool result → summary: 2); tools its own.
  await expect(page.getByRole("cell", { name: "ok", exact: true })).toBeVisible();

  // Click the row: the child's steps open, showing the tool call it made under the parent.
  await page.getByRole("cell", { name: "list the files in the workspace" }).click();
  const panel = page.getByTestId("subagent-steps");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText("1 steps")).toBeVisible();
  await expect(panel.getByText("tool_call", { exact: true })).toBeVisible();
});

test("the parent run still leads the Agents screen ledger", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("delegate a file listing");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(
    page.getByText("Done. Here is what I found in the workspace.").last(),
  ).toBeVisible({ timeout: 30_000 });

  // The Agents dashboard's ledger lists every run — parent and child are two rows there; the
  // Subagents screen is the children-only view of the same table. Both ended ok. Anchored on
  // cells for the same reason as above.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("2 runs · 0 running · 2 ok · 0 failed · 0 stopped")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("cell", { name: "delegate a file listing" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "list the files in the workspace" })).toBeVisible();
});

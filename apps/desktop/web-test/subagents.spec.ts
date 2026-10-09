/**
 * web-test/subagents.spec.ts — the Subagents screen is the agent-types manager.
 *
 * The delegated-runs *history* left this screen (it lives in the Assistant's live drawer and
 * the Agents screen's ledger); what remains — and what these specs pin — is the ZCode-style
 * agent-types manager: builtins seeded, a specialist added, dispatched for real, and the whole
 * run tree still inspectable on the Agents ledger.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("the Subagents screen is the agent-types manager, not a run history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Subagents", exact: true }).click();

  // The management card, with the builtin set seeded.
  await expect(page.getByTestId("agent-types-card")).toBeVisible();
  await expect(page.getByTestId("agent-type-row").filter({ hasText: "Codebase Mapper" })).toBeVisible();

  // No run history here anymore: the runs table's columns are gone.
  await expect(page.getByText("DELEGATED BY")).toHaveCount(0);
  await expect(page.getByText(/delegated runs ·/)).toHaveCount(0);
});

test("a delegation still lands on the Agents ledger with its parent link", async ({ page }) => {
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

  // --- approve the delegation itself, then the child's read ---------------------------
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // --- the loop completes --------------------------------------------------------------
  await expect(
    page.getByText("Done. Here is what I found in the workspace.").last(),
  ).toBeVisible({ timeout: 30_000 });

  // The Agents dashboard's ledger lists every run — parent and child are two rows there, the
  // child linked to its delegating run. Row content is asserted on its cell, not page-wide
  // text: the mounted-but-hidden Assistant still holds the task string in its transcript DOM.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("2 runs · 0 running · 2 ok · 0 failed · 0 stopped")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("cell", { name: "delegate a file listing" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "list the files in the workspace" })).toBeVisible();
});

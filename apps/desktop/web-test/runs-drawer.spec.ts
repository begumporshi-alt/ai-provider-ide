/**
 * web-test/runs-drawer.spec.ts — the transcript's live subagents panel.
 *
 * The drawer is a reader over the runs ledger pinned to the Chat tab's right edge, showing
 * delegated runs ONLY — the parent's own turns are the transcript, and repeating them here
 * would be a second transcript. Collapsed it names the running count; expanded, each child run
 * expands to its steps, including the tool_result half that answers "what did it come back
 * with" and not only "what did it call".
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

async function setupAgentMode(page: import("@playwright/test").Page) {
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
}

async function runDelegation(page: import("@playwright/test").Page) {
  await page.getByPlaceholder(/Describe a task for the agent/).fill("delegate a file listing");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(
    page.getByText("Done. Here is what I found in the workspace.").last(),
  ).toBeVisible({ timeout: 30_000 });
}

test("before any delegation the drawer stays out of the way", async ({ page }) => {
  await setupAgentMode(page);
  // The parent's own turns are transcript material, not drawer material: with no delegated run
  // in the ledger there is nothing for the drawer to say, so no rail renders at all.
  await expect(page.getByTestId("runs-drawer-rail")).toHaveCount(0, { timeout: 15_000 });
});

test("the drawer lists the delegated run — and only it — with its steps", async ({ page }) => {
  await setupAgentMode(page);
  await runDelegation(page);

  // The rail appeared once a delegation exists, and names the ended count.
  const rail = page.getByTestId("runs-drawer-rail");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("runs-drawer")).toHaveCount(0);

  await rail.click();
  const drawer = page.getByTestId("runs-drawer");
  await expect(drawer).toBeVisible();

  // ONE row: the delegated child. The delegating parent run is not listed — it is this
  // conversation, not a sub-agent.
  const rows = drawer.getByTestId("runs-drawer-row");
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(drawer.getByText("list the files in the workspace")).toBeVisible();
  await expect(drawer.getByText("delegate a file listing")).toHaveCount(0);

  // Expanding it shows the compacted activity — one row per tool call with its outcome, not the
  // ledger's raw `tool_call` / `tool_result` wire kinds.
  await drawer.getByText("list the files in the workspace").click();
  const steps = drawer.getByTestId("runs-drawer-steps");
  await expect(steps).toBeVisible();
  await expect(steps.getByText("list_dir", { exact: true })).toBeVisible();
  await expect(steps.getByText("tool_call", { exact: true })).toHaveCount(0);
  await expect(steps.getByText("tool_result", { exact: true })).toHaveCount(0);
});

test("the drawer's fold toggles closed and open again", async ({ page }) => {
  await setupAgentMode(page);
  await runDelegation(page);

  const rail = page.getByTestId("runs-drawer-rail");
  await expect(rail).toBeVisible({ timeout: 15_000 });

  await rail.click();
  await expect(page.getByTestId("runs-drawer")).toBeVisible();

  await page.getByRole("button", { name: "Close subagents drawer" }).click();
  await expect(rail).toBeVisible();
  await expect(page.getByTestId("runs-drawer")).toHaveCount(0);
});

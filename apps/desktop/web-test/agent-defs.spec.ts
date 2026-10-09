/**
 * web-test/agent-defs.spec.ts — user-authored dispatch_agent specialists, end to end.
 *
 * The definition is added through the Agent types card on the Subagents screen (a real write of
 * a real JSON file by the host), toggled, searched — and then dispatched for real: the
 * Assistant's turn names the specialist, and the child's summary proves the definition's own
 * system prompt reached the child loop (the mock echoes a marker the default researcher's
 * prompt never carries).
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("an agent type added in the UI is dispatched with its own prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP}?seed=systemai`);

  // --- add the definition through the Subagents screen's management card -------------
  await page.getByRole("button", { name: "Subagents", exact: true }).click();
  await expect(page.getByTestId("agent-types-card")).toBeVisible();
  // The builtin set ships seeded — the ZCode-style cards are there on a fresh install.
  await expect(page.getByTestId("agent-type-row")).toHaveCount(5, { timeout: 15_000 });
  await expect(page.getByText("Codebase Mapper")).toBeVisible();
  await expect(page.getByText("Bug Hunter")).toBeVisible();

  await page.getByRole("button", { name: "Add agent type" }).first().click();
  await page.getByLabel(/^Id /).fill("doc-sweeper");
  await page.getByLabel(/^Name/).fill("Doc Sweeper");
  await page.getByLabel(/^Description/).fill("Surfaces documentation that drifted from the code.");
  await page
    .getByLabel(/^System prompt/)
    .fill("You sweep documentation for drift. DEFMARKER-doc-sweeper");
  // Narrow the toolset to list_dir only: the child's tool call must still run.
  await page.getByRole("checkbox", { name: "list_dir" }).check();
  await page.getByRole("button", { name: "Add agent type" }).last().click();

  const row = page.getByTestId("agent-type-row").filter({ hasText: "Doc Sweeper" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("Doc Sweeper")).toBeVisible();
  await expect(row.getByText("1 tools")).toBeVisible();

  // --- the per-row controls: search, disable, re-enable -------------------------------
  await page.getByLabel("Search agent types").fill("doc");
  await expect(row).toBeVisible();
  await page.getByLabel("Search agent types").fill("zzz-no-match");
  await expect(row).toHaveCount(0);
  await page.getByLabel("Search agent types").fill("");

  // The toggle is a real switch, ZCode-style: same assertion shape either state.
  await page.getByRole("switch", { name: "Disable Doc Sweeper" }).click();
  await expect(page.getByRole("switch", { name: "Enable Doc Sweeper" })).toBeVisible();
  await page.getByRole("switch", { name: "Enable Doc Sweeper" }).click();
  await expect(page.getByRole("switch", { name: "Disable Doc Sweeper" })).toBeVisible();

  // --- dispatch it for real ------------------------------------------------------------
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("run the specialist doc sweep");
  await page.getByRole("button", { name: "Send" }).click();

  // The delegation prompts (the gate rides along for specialist dispatches too)…
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  // …and so does the child's list_dir under its narrowed toolset.
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // The child's summary is the mock's marker echo — only reachable if the definition's own
  // system prompt (not the default researcher's) ran the child loop.
  await expect(page.getByText("Specialist summary — the doc-sweeper prompt reached the child loop.").last()).toBeVisible({
    timeout: 30_000,
  });
});

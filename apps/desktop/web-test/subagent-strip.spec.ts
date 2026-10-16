/**
 * web-test/subagent-strip.spec.ts — the live delegation strip, driven through the real loop.
 *
 * A `dispatch_agent` child's transcript is deliberately invisible (isolation is the point of
 * delegating), but until now that meant the row sat on a silent "calling" state for the whole
 * child run — indistinguishable from a hang. The strip under the delegating row shows the live
 * snapshot the loop emits: the child's slot, its tool-call count and the tool it last called.
 * Its end state is pinned at the loop and timeline level; this spec pins what a person actually
 * sees while the child works.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

type WebTest = {
  __webTest: { holdTool: (name: string, ms: number, output?: string) => void };
};

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
  // Approvals off: this spec is about visibility during a delegation, not the gate, and a modal
  // would sit exactly where the strip renders.
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

test("a delegation shows its child working in the strip, not a silent row", async ({ page }) => {
  await setupAgentMode(page);

  // Hold the child's one read open, so the running state is observably long, not a flash.
  await page.evaluate(() =>
    (window as unknown as WebTest).__webTest.holdTool("list_dir", 5_000, "README.md"),
  );
  await page.getByPlaceholder(/Describe a task for the agent/).fill("delegate a file listing");
  await page.getByRole("button", { name: "Send" }).click();

  const strip = page.getByTestId("subagent-strip");
  await expect(strip).toBeVisible({ timeout: 30_000 });
  // The default researcher's slot, named and alive.
  await expect(strip).toContainText("research");
  await expect(strip).toContainText(/running/);

  // The child's work shows as counts and tool names — and as nothing else: no snapshot carries
  // the child's intermediate prose or tool output, which would undo the delegation's isolation.
  await expect(strip).toContainText(/1 call · list_dir/, { timeout: 15_000 });

  // The turn ends normally; the strip supplements the transcript, it does not delay it.
  await expect(page.getByText("Done. Here is what I found in the workspace.").last()).toBeVisible({
    timeout: 30_000,
  });
});

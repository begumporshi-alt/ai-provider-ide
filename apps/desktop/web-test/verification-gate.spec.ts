/**
 * web-test/verification-gate.spec.ts — a done claim with no proof behind it does not stand.
 *
 * The loop's verification gate: a turn that wrote files, answered "done", and ran nothing that
 * checks either, is sent back — the claim lands on the transcript, an automatic demand follows
 * it, and the model gets another round WITH its tools to produce evidence. This spec drives the
 * whole shape end to end: the write, the bare claim, the gate's notice in the live timeline, the
 * check the model then runs, and the persisted record showing claim → demand → evidence.
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
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

test("a bare done claim is followed by the demand, and the check answers it", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("fix the login bug and say when it is done");
  await page.getByRole("button", { name: "Send" }).click();

  // The turn ends on evidence, not on the bare claim.
  await expect(page.getByText(/the fix is verified/)).toBeVisible({ timeout: 60_000 });
  const check = page.getByTestId("tool-call-row").filter({ hasText: "run_command" }).first();
  await expect(check).toBeVisible({ timeout: 60_000 });

  // The persisted record shows the whole arc: the bare claim, the automatic demand as its own
  // turn, then the check — a reader sees the claim was challenged, not silently accepted.
  // (The live-timeline notice is pinned in timeline.test.ts; the mock answers too fast for a
  // live assertion to be anything but a race.)
  await expect(page.getByText(/AUTOMATED VERIFICATION GATE/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/The login bug is fixed/)).toBeVisible();
});

/**
 * web-test/stop-mid-tool.spec.ts — Stop must reach the tool that is actually running.
 *
 * The gap this pins, from the user's own words: *"sometimes i can't stop a process by clicking in
 * stop while ai/agent working."* Two causes were fixed before this spec existed (a run parked on
 * the approval gate; a mid-stream abort recorded as success). This one is the third and the most
 * literal: a `run_command` in flight could not be cancelled at all — the loop checked its abort
 * flag only between steps, so a 60-second command kept running after Stop, and the button read as
 * broken.
 *
 * The chain under test, end to end:
 *   Stop → AbortController → the host fires `tool_cancel` with the model's call id
 *   → the Rust registry SIGINTs (then SIGKILLs) the child's process group
 *   → `tool_run` answers "stopped by you" → the loop throws at its next boundary.
 *
 * Playwright cannot press the real button on a real `sleep`, so the harness holds the tool open
 * (`__webTest.holdTool`) for 30 s and the assertion is on the CLOCK: a stop that takes the timeout
 * path would need 30 s, and this spec requires the turn to end in single-digit seconds. The Rust
 * half — signalling the real process group — is pinned by the cargo test
 * `a_running_command_can_be_cancelled_and_reports_stopped_by_you`.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

type WebTest = { __webTest: { holdTool: (name: string, ms: number, output?: string) => void } };

test("stop cancels a command that is running, instead of waiting for it", async ({ page }) => {
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

  // Approvals off: this spec is about Stop, not the gate, and a modal would cover the button.
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);

  // The tool answers, if ever, after 30 seconds. Any pass under that is the cancel path working.
  await page.evaluate(() =>
    (window as unknown as WebTest).__webTest.holdTool("run_command", 30_000, "(held command finished)"),
  );

  await page.getByPlaceholder(/Describe a task for the agent/).fill("run the long job");
  await page.getByRole("button", { name: "Send" }).click();

  // The live status line names the call in flight — the state the user is looking at when they
  // reach for Stop.
  await expect(page.getByTestId("agent-status")).toContainText("Running run_command", { timeout: 15_000 });
  // The call is real: the live transcript shows it as its own row.
  await expect(page.getByTestId("tool-call-row").first()).toContainText("run_command", { timeout: 15_000 });

  const t0 = Date.now();
  await page.getByRole("button", { name: /Stop$/ }).click();

  // The turn ends with the user's action named — not with the tool's output, and not with a
  // timeout error 30 seconds later.
  await expect(page.getByText(/stopped by you/).first()).toBeVisible({ timeout: 10_000 });
  const elapsed = Date.now() - t0;
  expect(elapsed, "a cancelled tool must not mean waiting out its runtime").toBeLessThan(15_000);

  // The composer is live again, so the loop really unwound.
  await expect(page.getByRole("button", { name: /Send/ })).toBeVisible();
  // And the live status line is gone with the turn.
  await expect(page.getByTestId("agent-status")).toHaveCount(0);
});

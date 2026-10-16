/**
 * web-test/browser-debug.spec.ts — the browser observers, driven through the real agent loop.
 *
 * The browser tools could act on a page, but the model could not hear it: a click that threw, a
 * request that 404'd, a confirmation that never rendered — "the click did nothing" with no way to
 * learn why. browser_console / browser_network / browser_wait_for close that. This spec runs the
 * whole debugging sequence the tools exist for — navigate a fixture page, click the button that
 * throws, wait for a confirmation that never comes, then read the console — against the shim's
 * virtual page (same observable surface as the Rust CDP client) and asserts on the answer the
 * model gives, which is the only place all five rounds meet.
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
  // Approvals off: this spec is about what the tools let the model see, not the gate — and the
  // sequence has two mutating calls (navigate, click) that would each raise a modal.
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

test("a click that throws is diagnosed by the console, not guessed at", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("debug the broken page");
  await page.getByRole("button", { name: "Send" }).click();

  // The turn's answer is the whole point: after wait_for timed out on a confirmation that never
  // rendered, the console named the reason. The tool rows above it carry each step; the final
  // text proves the chain worked end to end.
  await expect(
    page.getByText(/The click threw ReferenceError: saveData is not defined/),
  ).toBeVisible({ timeout: 60_000 });

  // The failed wait is honest in the transcript too — a timeout is the tool doing its job, and it
  // must read as its own outcome, not a silent pass.
  await expect(page.getByText(/never appeared within 1000ms/).first()).toBeVisible();
});

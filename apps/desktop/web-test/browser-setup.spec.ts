/**
 * web-test/browser-setup.spec.ts — a browser call with no browser answers points at the fix.
 *
 * The browser tools attach to a Chrome the user starts with --remote-debugging-port; forgetting
 * that step used to surface as a collapsed error line naming a flag. When a browser call fails
 * with the no-browser error, its row now shows the exact launch command. This spec drives a real
 * turn that hits the miss and asserts the hint is on screen with the command in it.
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

test("a browser call that finds no browser shows the launch command in its row", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("open the offline page");
  await page.getByRole("button", { name: "Send" }).click();

  // The hint, not just the error: what to start, with the flag the port demands.
  const hint = page.getByTestId("browser-setup-hint");
  await expect(hint).toBeVisible({ timeout: 60_000 });
  await expect(hint).toContainText(/no browser is listening on the debugger port/);
  await expect(hint).toContainText(/--remote-debugging-port=9222/);
  await expect(hint).toContainText(/open -a "Google Chrome"/);

  // The turn still concludes — the hint supplements the answer, it does not replace it.
  // (No apostrophes here: the Markdown renderer smart-quotes them.)
  await expect(page.getByText(/names the exact command/)).toBeVisible();
});

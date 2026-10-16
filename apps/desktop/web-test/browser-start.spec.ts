/**
 * web-test/browser-start.spec.ts — the setup miss has a one-click fix, and the model can fix it too.
 *
 * Two ways `browser_start` closes the no-browser dead end:
 *  1. The model's own recovery — navigate misses, the model starts the browser, navigates again,
 *     and the turn concludes with the page actually open.
 *  2. The person's recovery — the row's hint carries a button that runs `browser_start` through
 *     the sandbox, so setup never has to leave the conversation.
 *
 * The harness's virtual browser refuses offline.local until something is started, so both flows
 * exercise the real gate: only `browser_start` can flip it.
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

test("the model recovers from a dead browser call by starting one and navigating again", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("start the browser and open the page");
  await page.getByRole("button", { name: "Send" }).click();

  // The failed navigate is on the record, and so is the start that answered it.
  const failedNav = page.getByTestId("tool-call-row").filter({ hasText: "browser_navigate" }).first();
  await expect(failedNav).toBeVisible({ timeout: 60_000 });
  const startRow = page.getByTestId("tool-call-row").filter({ hasText: "browser_start" }).first();
  await expect(startRow).toBeVisible({ timeout: 60_000 });
  await expect(startRow).toContainText(/a browser is up on 127\.0\.0\.1:9222/);

  // And the turn concludes on the second navigate, not the first failure.
  // (No apostrophes: the Markdown renderer smart-quotes them.)
  await expect(page.getByText(/the recovery worked/)).toBeVisible({ timeout: 60_000 });
});

test("the hint carries a button that starts the browser without leaving the conversation", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("open the offline page");
  await page.getByRole("button", { name: "Send" }).click();

  const hint = page.getByTestId("browser-setup-hint");
  await expect(hint).toBeVisible({ timeout: 60_000 });

  // One click, the sandbox's own browser_start does the rest. The in-flight "starting…" state
  // resolves faster than an expect poll can catch it, so the assertions are the end states.
  await page.getByTestId("browser-start-button").click();
  await expect(hint).toContainText(/a browser is up on 127\.0\.0\.1:9222/, { timeout: 60_000 });
  await expect(hint).toContainText(/the browser is up — ask again and the call will go through/);
});

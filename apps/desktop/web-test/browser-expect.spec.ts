/**
 * web-test/browser-expect.spec.ts — an assertion tool closes the loop on a browser test.
 *
 * `browser_wait_for` answers "is it there yet"; a test wants to *assert* and get a diagnosis on
 * a miss. `browser_expect` is that form: retry until a deadline across four kinds (text,
 * element, url, title), and a miss reports what the page showed. This spec drives a real turn —
 * navigate, click, assert the click's effect — and checks the assertion's verdict is on screen.
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

test("a browser assertion reports its verdict in the run", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("expect the loaded page");
  await page.getByRole("button", { name: "Send" }).click();

  // The expect call ran and its verdict is readable without opening anything.
  const row = page.getByTestId("tool-call-row").filter({ hasText: "browser_expect" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(/is on the page/);

  // The turn concluded on the assertion, not on a shrug.
  await expect(page.getByText(/The assertion held/)).toBeVisible();
});

/**
 * web-test/run-config.ts — the door to the run-configuration panel.
 *
 * The screen's behaviour switches (agent mode, memory, approval, plan mode, the no-tools guard,
 * the step budget) live in one panel behind a sliders icon beside "＋ Add context", not inline in
 * the composer row. Two rules every spec must follow:
 *
 * 1. Open the panel before touching a switch — the controls do not exist until the panel does.
 * 2. Close it before clicking anything else. The panel's outside-click overlay covers the whole
 *    screen while it is open, so a Send or tab click made with the panel up would be swallowed
 *    by the overlay and close the panel instead.
 */
import { expect, type Page } from "@playwright/test";

const TOGGLE = { name: "Run configuration" };

/** Open the run-configuration panel and wait for its controls to be there. */
export async function openRunConfig(page: Page): Promise<void> {
  await page.getByRole("button", TOGGLE).click();
  await expect(page.getByRole("dialog", TOGGLE)).toBeVisible();
}

/** Close the panel via its overlay (it sits above the toggle itself while open). */
export async function closeRunConfig(page: Page): Promise<void> {
  await page.getByTestId("run-config-overlay").click();
  await expect(page.getByRole("dialog", TOGGLE)).toHaveCount(0);
}

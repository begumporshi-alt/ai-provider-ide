/**
 * web-test/prompt-enhancer.spec.ts — the composer's Enhance button rewrites the draft in place.
 *
 * The feature (2026-10-06): a prompt enhancer beside Send. The draft goes to the turn's own model
 * with an instruction to sharpen it, and the rewrite **replaces** the draft — the point is a
 * better prompt, not an appendix under the original one. What is testable here without a real
 * model is the composer's half of the contract:
 *
 *   - the button exists beside Send and is **disabled on an empty draft** (nothing to enhance);
 *   - clicking it swaps the draft for the enhancer's answer, and the caret is parked at the end
 *     so the user can keep editing the rewrite immediately.
 *
 * The oracle (see `mock.mjs`) answers every tools-less round-trip with `Hello from <model>`, so
 * the rewrite is deterministic in the harness and the assertions read on the swap, not on prose.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

test("the prompt enhancer replaces the draft with the model's rewrite", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  const input = page.getByTestId("composer-input");
  const enhance = page.getByTestId("enhance-button");

  // Disabled on an empty draft — the composer refuses to spend a model call on nothing.
  await expect(enhance).toBeDisabled();

  await input.fill("make my prompt better");
  await expect(enhance).toBeEnabled();
  await enhance.click();

  // The swap: the draft is the rewrite now, and the caret sits after it.
  await expect(input).toHaveValue("Hello from oracle-mini", { timeout: 30_000 });
  const caret = await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
  expect(caret).toBe((await input.inputValue()).length);
});

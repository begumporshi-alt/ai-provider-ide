/**
 * web-test/browser-shot.spec.ts — a browser capture renders as a picture, not a text row.
 *
 * `browser_screenshot` saves a PNG into the workspace so a vision model can see the page; the
 * person got a row of path text. The loop's marker protocol now gives the call a short receipt
 * on the wire (its base64 used to flood the transcript exactly like read_image's once did), and
 * the tool card loads the saved file through the sandbox's own read-only `read_image` and shows
 * it. This spec drives a real turn — navigate, capture, answer — and asserts the picture is
 * actually on screen.
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
  // Approvals off: the sequence has two mutating calls (navigate, screenshot) that would each
  // raise a modal, and the gate is not what this spec is about.
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

test("a browser capture shows inline in its tool row", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("screenshot the page");
  await page.getByRole("button", { name: "Send" }).click();

  // The row renders the image itself — loaded from the workspace through the sandbox bridge,
  // not a paste of the marker's base64 (which the receipt protocol keeps off the wire).
  const shot = page.getByTestId("browser-shot");
  await expect(shot).toBeVisible({ timeout: 60_000 });
  await expect(shot).toContainText(/images\/browser/);
  const img = shot.locator("img");
  await expect(img).toBeVisible();
  expect(await img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

  // The turn concluded normally — the capture supplements the answer, it does not replace it.
  // The Markdown renderer smart-quotes, so the apostrophe is matched loosely (`page.s`).
  await expect(page.getByText(/Captured\. The page.s screenshot is saved/)).toBeVisible();
});

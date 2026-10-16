/**
 * web-test/browser-cache.spec.ts — a capture's preview survives the workspace file being cleaned.
 *
 * The transcript keeps only the capture's path; when a revert or a clean takes the file away, a
 * replayed preview had nothing to load and silently vanished. The agent loop now deposits a
 * content-addressed copy in the session image cache at attach time, and the receipt carries the
 * cache name. This spec takes a real capture, deletes the workspace file out from under it,
 * replays the session, and asserts the picture is still on screen.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

type WebTest = { __webTest: { dropFile: (rel: string) => boolean } };

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

test("a replayed capture still shows after the workspace file is gone", async ({ page }) => {
  await setupAgentMode(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("screenshot the page");
  await page.getByRole("button", { name: "Send" }).click();

  // The live run rendered the capture from the workspace file.
  await expect(page.getByTestId("browser-shot")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Captured\. The page.s screenshot is saved/)).toBeVisible();

  // Now take the workspace copy away — what a revert or a clean does.
  const dropped = await page.evaluate(() =>
    (window as unknown as WebTest).__webTest.dropFile("images/browser-fixture.png"),
  );
  expect(dropped, "the fixture file existed before the drop").toBe(true);

  // Empty the pane with a fresh session, then replay this one — the same affordance
  // rich-cards.spec.ts uses for its resume assertions.
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(page.getByRole("button", { name: /untitled session/ })).toBeVisible();
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /screenshot the page/ }).click();

  // The picture is back — read_image has no file to give, so only the cache can supply it.
  await expect(page.getByTestId("browser-shot")).toBeVisible({ timeout: 30_000 });
  const img = page.getByTestId("browser-shot").locator("img");
  await expect(img).toBeVisible();
  expect(await img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
});

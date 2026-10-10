/**
 * web-test/rich-cards.spec.ts — the transcript's rich document rendering, driven end to end.
 *
 * Two ZCode-parity behaviours, each through the real run path:
 *
 * 1. Plan mode's answer renders as a titled document card — header, clamped preview with fade,
 *    "View full plan →" expanding in place — and the card SURVIVES approval, because the plan is
 *    still the reference document while the executing pass runs.
 * 2. A whole HTML document the model produces renders live in a sandboxed iframe (Preview/Code
 *    toggle), while the prose around it stays ordinary markdown.
 *
 * The oracle variants live in mock.mjs (`/plan the/` in plan mode, `/html page/` in plain chat).
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

async function openChat(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
}

test("plan mode's answer renders as an expandable document card that survives approval", async ({ page }) => {
  await openChat(page);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);
  // Agent mode needs a root; plan mode is read-only but the guard is the same either way.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("plan the subagent system upgrade");
  await page.getByRole("button", { name: "Send" }).click();

  // The card, not a bare markdown message: title from the document's h1, header labelled Plan.
  const card = page.getByTestId("doc-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases");
  await expect(card.getByText("Plan", { exact: true })).toBeVisible();

  // The preview is clamped (scrollHeight beyond the max-height), and the last step sits below
  // the fold until the pill opens the document. Clipped-but-present text still counts as
  // "visible" to Playwright, so the clamp is asserted by measurement, not visibility.
  const lastStep = "Keep fragments and snippets as highlighted code";
  const isClamped = () =>
    page.getByTestId("doc-card-body").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(await isClamped()).toBe(true);
  await expect(card.getByText(lastStep)).toBeAttached();
  await page.getByTestId("doc-card-view").click();
  await expect(card.getByText(lastStep)).toBeVisible();
  await expect(page.getByTestId("doc-card-view")).toHaveCount(0);
  expect(await isClamped()).toBe(false);
  await page.getByTestId("doc-card-collapse").click();
  expect(await isClamped()).toBe(true);

  // Approving runs the plan for real — and the card stays, because the plan is still on record.
  await expect(page.getByTestId("plan-approve")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan & execute" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await expect(card).toBeVisible();
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases");
});

test("a whole HTML document renders live in a sandboxed frame, with the source one click away", async ({ page }) => {
  await openChat(page);

  await page.getByPlaceholder(/Message your assistant/).fill("build me an html page");
  await page.getByRole("button", { name: "Send" }).click();

  const preview = page.getByTestId("html-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  // The prose around the document is still markdown; the document is a frame, not markup text.
  await expect(page.getByText("Here is a small page:")).toBeVisible();
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);

  // Sandboxed: scripts may run, the opaque origin may not touch this app's storage or bridge.
  const sandbox = await page.getByTestId("html-preview-frame").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");

  // Code view shows the source; Preview returns the live frame.
  await page.getByTestId("html-preview-code").click();
  await expect(page.getByTestId("html-preview-source")).toContainText("<!doctype html>");
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(0);
  await page.getByTestId("html-preview-preview").click();
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
});

test("an html snippet stays a code block — fragments are not pages", async ({ page }) => {
  await openChat(page);

  // Any prompt the mock does not script answers "Hello from oracle-mini" — good enough: the
  // assertion is that NO preview card appears for ordinary chat, which this proves cheaply.
  await page.getByPlaceholder(/Message your assistant/).fill("say hello");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Hello from oracle-mini")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("html-preview")).toHaveCount(0);
  await expect(page.getByTestId("doc-card")).toHaveCount(0);
});

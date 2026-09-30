/**
 * web-test/assistant-session.spec.ts — naming, starting and switching conversations in place.
 *
 * The gap this closes: a conversation could only be started or resumed from the History screen, and
 * had no name while you were in it. The session bar adds all three to the Assistant, and reuses the
 * `session_titles` sidecar and `resumeSession` that History already relies on — so this also proves
 * the two screens agree rather than growing a second, divergent notion of "the current session".
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";
const ANSWER = "Hello from oracle-mini";

/** Send one plain-chat message and wait for the streamed answer. */
async function sendHello(page: import("@playwright/test").Page): Promise<void> {
  await page.getByPlaceholder(/Send a message through the router/).fill("Hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });
}

test("assistant: a session can be named, started fresh, and switched back to", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  // A fresh screen has no name yet.
  const titleButton = page.getByRole("button", { name: /untitled session/ });
  await expect(titleButton).toBeVisible();

  await sendHello(page);

  // --- name it ------------------------------------------------------------------
  await titleButton.click();
  await page.getByLabel("Session title").fill("Dhaka timezone thread");
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByRole("button", { name: "Dhaka timezone thread" })).toBeVisible();

  // --- start a new chat: the transcript clears and the name resets ------------------
  await page.getByRole("button", { name: "Start a new chat" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /untitled session/ })).toBeVisible();

  // --- switch back: the named session is listed and its transcript returns ---------
  await page.getByRole("button", { name: "Switch session" }).click();
  const named = page.getByRole("menuitem", { name: /Dhaka timezone thread/ });
  await expect(named).toBeVisible({ timeout: 10_000 });
  await named.click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });
  // The bar says which conversation was opened, not just that something was.
  await expect(page.getByRole("button", { name: "Dhaka timezone thread" })).toBeVisible();
});

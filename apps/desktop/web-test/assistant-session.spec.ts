/**
 * web-test/assistant-session.spec.ts — naming, starting and switching conversations in place.
 *
 * The gap this closes: a conversation could only be started or resumed from the History screen, and
 * had no name while you were in it. The session chip — one control that names the conversation you
 * are in and opens the panel holding rename, new, and resume — brings all three to the Assistant,
 * and reuses the `session_titles` sidecar and `resumeSession` that History already relies on — so
 * this also proves the two screens agree rather than growing a second, divergent notion of "the
 * current session".
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";
const ANSWER = "Hello from oracle-mini";

/** Send one plain-chat message and wait for the streamed answer. */
async function sendHello(page: import("@playwright/test").Page): Promise<void> {
  await page.getByPlaceholder(/Message your assistant/).fill("Hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });
}

test("assistant: a session can be named, started fresh, and switched back to", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  // A fresh screen has no name yet — the chip shows the fallback.
  const chip = page.getByRole("button", { name: /untitled session/ });
  await expect(chip).toBeVisible();

  await sendHello(page);

  // --- name it: chip → panel → rename field --------------------------------------
  await chip.click();
  await page.getByLabel("Rename session").click();
  await page.getByLabel("Session title").fill("Dhaka timezone thread");
  await page.getByLabel("Session title").press("Enter");
  // The panel closes on commit; the chip carries the new name.
  await expect(page.getByRole("button", { name: "Dhaka timezone thread" })).toBeVisible();

  // --- start a new chat: the transcript clears and the name resets ------------------
  // The chip is still the named session — it is the single door into the panel.
  await page.getByRole("button", { name: "Dhaka timezone thread" }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /untitled session/ })).toBeVisible();

  // --- switch back: the named session is listed and its transcript returns ---------
  await page.getByRole("button", { name: /untitled session/ }).click();
  const named = page.getByRole("menuitem", { name: /Dhaka timezone thread/ });
  await expect(named).toBeVisible({ timeout: 10_000 });
  await named.click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });
  // The chip says which conversation was opened, not just that something was.
  await expect(page.getByRole("button", { name: "Dhaka timezone thread" })).toBeVisible();
});

test("assistant: resuming a session restores the full text of its turns, not the graph preview", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  // Long enough that the 120-character graph label clips it: the marker lives past the clip, so
  // only the FULL text surviving the round-trip can satisfy the assertion below.
  const longText =
    "Please keep these project notes in mind: " + "alpha beta gamma delta epsilon ".repeat(9) + "RESUME-MARKER-XYZ";
  await page.getByPlaceholder(/Message your assistant/).fill(longText);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });

  // Name it, then empty the transcript with a fresh session.
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByLabel("Rename session").click();
  await page.getByLabel("Session title").fill("Long notes thread");
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByRole("button", { name: "Long notes thread" })).toBeVisible();
  await page.getByRole("button", { name: "Long notes thread" }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(page.getByRole("button", { name: /untitled session/ })).toBeVisible();

  // Resume it: every turn comes back, including the tail the label never carried.
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /Long notes thread/ }).click();
  await expect(
    page.locator("div.whitespace-pre-wrap").filter({ hasText: "RESUME-MARKER-XYZ" }).first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("assistant: selecting the session you are already in does not fork it", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  await sendHello(page);
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByLabel("Rename session").click();
  await page.getByLabel("Session title").fill("Solo thread");
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByRole("button", { name: "Solo thread" })).toBeVisible();

  // Click the CURRENT session's own row — a no-op, not a fork.
  await page.getByRole("button", { name: "Solo thread" }).click();
  await page.getByRole("menuitem", { name: /Solo thread/ }).click();
  await expect(page.getByRole("button", { name: "Solo thread" })).toBeVisible();

  await sendHello(page);

  // One session, one row. A fork would surface here as a second thread carrying the same name.
  await page.getByRole("button", { name: "Solo thread" }).click();
  await expect(page.getByRole("menuitem", { name: /Solo thread/ })).toHaveCount(1);
});

test("assistant: resuming a session continues it in place — no same-named duplicate", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  await sendHello(page);
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByLabel("Rename session").click();
  await page.getByLabel("Session title").fill("Dhaka timezone thread");
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByRole("button", { name: "Dhaka timezone thread" })).toBeVisible();

  // Start fresh, then resume the named thread and keep working in it.
  await page.getByRole("button", { name: "Dhaka timezone thread" }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /Dhaka timezone thread/ }).click();
  await sendHello(page);

  // The resume adopted the session, it did not fork it. History shows ONE row carrying the name —
  // the old fork-first design showed two (the frozen prefix plus a same-named continuation), and
  // a week of that read as the cascade of identical sessions it was.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByTestId("history-session").filter({ hasText: "Dhaka timezone thread" })).toHaveCount(1);
});

test("assistant: switching screens and back restores the open conversation", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  await sendHello(page);

  // Leave the Assistant entirely and come back. Screens unmount on switch, so the transcript
  // state dies with the component — the mount restore must rebuild it from the stored session.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  await expect(page.locator("div.whitespace-pre-wrap").filter({ hasText: ANSWER }).last()).toBeVisible({
    timeout: 30_000,
  });
  // And the restored pane still records into the SAME session: the next turn continues it rather
  // than opening a second thread under the same name.
  await sendHello(page);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByTestId("history-session")).toHaveCount(1);
});

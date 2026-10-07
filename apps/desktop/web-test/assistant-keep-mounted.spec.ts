/**
 * web-test/assistant-keep-mounted.spec.ts — the transcript survives leaving the Assistant.
 *
 * The reported bug (2026-10-06): start a turn, leave for another screen, come back a few seconds
 * later — the Assistant showed the conversation as it *was*, stopped, with the running turn's
 * output gone. App.tsx unmounted the screen on every switch; the in-flight turn kept streaming
 * into the dead component, and the way back in re-read the session's stored turns over the live
 * transcript. The cure keeps the screen mounted and hidden with CSS — the same one its own
 * Chat/Image tabs got — so these assertions pin three facts:
 *
 *   1. while away, the Assistant's header controls do not bleed onto the other screen;
 *   2. coming back mid-turn, the transcript is exactly as it was left, still streaming;
 *   3. the turn completes on screen with its full reply.
 *
 * The oracle's `slow:` prefix streams 40 words over ~5 s, which is the room the navigation
 * round-trip needs.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

test("leaving mid-turn and coming back keeps the live transcript", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  await page.getByPlaceholder(/Message your assistant/).fill("slow: hello");
  await page.getByRole("button", { name: "Send" }).click();

  // The reply is streaming.
  await expect(page.getByText(/tick\d+/).first()).toBeVisible({ timeout: 30_000 });

  // --- leave while the turn runs --------------------------------------------------------
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  // On the other screen the Assistant's header portal must be gone: the session bar and the
  // Chat/Image/Root tabs live in one shared slot, and a screen that stays mounted must not
  // paint them over every other screen's header.
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // --- come back mid-turn ----------------------------------------------------------------
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  // The transcript is exactly as it was left — the user turn and the partial reply, not a
  // re-read of the (still empty) stored session.
  await expect(page.getByText("slow: hello")).toBeVisible();
  await expect(page.getByText(/tick\d+/).first()).toBeVisible({ timeout: 30_000 });
  // And the header portal came back with the screen.
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();

  // --- the turn finishes on screen --------------------------------------------------------
  // tick39 is the stream's last word; nothing but a live component still attached to the
  // running turn can render it.
  await expect(page.getByText(/tick39/)).toBeVisible({ timeout: 30_000 });
});

/**
 * web-test/tool-call-grouping.spec.ts — a turn's tool traffic is one card, and the calls are named.
 *
 * Two reported problems, both presentational and both measured here rather than asserted in the
 * abstract:
 *
 * 1. *"every tool call showing in ui not presenting professionally"* — a completed turn rendered as
 *    a flat run of bubbles, one per message, where a persisted result read `tool result · …` with
 *    **no indication of which tool produced it**. A turn that made several calls read as several
 *    anonymous blocks. The card now names each call and groups the turn.
 * 2. *"the assistant screen is very narrow"* — the column was capped at `max-w-3xl` (768px). This
 *    measures the rendered width, because a class name in the source is not the property the user
 *    complained about.
 *
 * The oracle (see `mock.mjs`) emits one `edit_file` call for any prompt containing "edit", against
 * the shim's virtual FS. One call is enough for both claims: the header's count, the tool's name,
 * and the absence of the anonymous bubble are all properties of the grouping, not of the arity.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

test("tool calls: one grouped card per turn, the tool's name on it, and a wider column", async ({ page }) => {
  // Wide enough that `max-w-6xl` (72rem) is the binding limit, so the width assertion measures the
  // column's own cap and not the window.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByLabel("agent mode").check();
  // Root setup lives in its own tab now; set it there, then go back to the chat.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("edit the readme greeting");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // The turn's card, with its count in the header.
  const card = page.getByRole("button", { name: /1 tool call/ });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The call is named. This is the defect: the result used to be the only thing rendered, under a
  // label that said "tool result" and nothing about which tool it was.
  await expect(page.getByText("edit_file").first()).toBeVisible();

  // And no anonymous per-result bubble survives beside the card.
  await expect(page.getByRole("button", { name: /^▸ tool result/ })).toHaveCount(0);

  // The column the user found narrow: 768px before, and the window here is 1600px wide.
  const box = await page.getByTestId("assistant-column").boundingBox();
  expect(box!.width).toBeGreaterThan(900);
});

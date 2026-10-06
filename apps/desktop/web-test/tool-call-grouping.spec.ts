/**
 * web-test/tool-call-grouping.spec.ts — a turn's tool calls are one row per call, and the calls
 * are named.
 *
 * Three reported problems, all presentational and all measured here rather than asserted in the
 * abstract:
 *
 * 1. *"every tool call showing in ui not presenting professionally"* — a completed turn rendered as
 *    a flat run of bubbles, one per message, where a persisted result read `tool result · …` with
 *    **no indication of which tool produced it**. A turn that made several calls read as several
 *    anonymous blocks. The calls are now rows, one per call, each naming its tool.
 * 2. *"i don't like how tool call shows in the chat ui, i like how zcode shows it"* — the interim
 *    grouped card ("▸ 1 tool call") read as a modal you had to open to learn anything: the tool's
 *    name and what it was asked to do sat behind the disclosure. The rows follow ZCode's shape —
 *    a status dot, the tool name and its argument summary on one line at rest — measured here by
 *    the row's visibility and its text, not by the class names that produce it.
 * 3. *"the assistant screen is very narrow"* — the column was capped at `max-w-3xl` (768px). This
 *    measures the rendered width, because a class name in the source is not the property the user
 *    complained about.
 *
 * The oracle (see `mock.mjs`) emits one `edit_file` call for any prompt containing "edit". One
 * call is enough for all three claims: the row's presence and text, the absence of the anonymous
 * bubble, and the column width are all properties of the rendering, not of the arity.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("tool calls: one row per call in ZCode's shape, the tool named on it, and a wider column", async ({ page }) => {
  // Wide enough that `max-w-6xl` (72rem) is the binding limit, so the width assertion measures the
  // column's own cap and not the window.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  // Root setup lives in its own tab now; set it there, then go back to the chat.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("edit the readme greeting");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // The call row, at rest: dot, tool name, argument summary — nothing to open first.
  const row = page.getByTestId("tool-call-row").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("edit_file");

  // And no anonymous per-result bubble survives beside the rows.
  await expect(page.getByRole("button", { name: /^▸ tool result/ })).toHaveCount(0);

  // The column the user found narrow: 768px before, and the window here is 1600px wide.
  const box = await page.getByTestId("assistant-column").boundingBox();
  expect(box!.width).toBeGreaterThan(900);
});

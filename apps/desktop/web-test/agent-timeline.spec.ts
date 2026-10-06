/**
 * web-test/agent-timeline.spec.ts — a turn's thinking and its tool calls interleave, in the order
 * the model produced them.
 *
 * # The reported gap
 *
 * *"if you see the zcode chat interface you will see how it thinking/thought first than tool calls
 * then again thinking/thought. i also like how it shows in the ui."* (2026-10-06). In this app the
 * two channels were accumulated separately — all reasoning into one blob, all calls into one list —
 * so a run that thought → acted → thought → answered rendered as "all the thinking, then all the
 * tools", an order no model ever produced.
 *
 * # What is pinned, and where
 *
 * The ordering rules themselves are unit-tested (`src/lib/chat/turn/timeline.test.ts`) with no DOM.
 * What only a browser can show is that the **persisted transcript** — not just the live view —
 * comes out interleaved: the reasoning attribution runs at the moment the loop hands its messages
 * back (`attachReasoning`), and a bug there would leave the live turn looking right and the
 * finished one collapsing back into two blobs.
 *
 * The oracle (see `mock.mjs`) emits reasoning deltas before its work when the prompt starts with
 * `think:` — before the tool call in the acting round, and again before the closing answer — so
 * this spec's four ordered elements are: thought, call, thought, answer.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("agent turn: thought, tool, thought, answer — in that order in the finished transcript", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  // Root setup lives in its own tab; the edit targets the shim's virtual FS inside it.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  // Approvals off: this spec is about the transcript's shape, and a modal in the middle of the
  // run would make every ordered assertion race the gate.
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);

  await page.getByPlaceholder(/Describe a task for the agent/).fill("think: edit the readme greeting");
  await page.getByRole("button", { name: "Send" }).click();

  // The turn finished: its call row and its closing answer are both on screen.
  const rows = page.getByTestId("tool-call-row");
  await expect(rows.first()).toContainText("edit_file", { timeout: 30_000 });
  const answer = page.getByText(/Done\. Here is what I found in the workspace\./);
  await expect(answer).toBeVisible({ timeout: 30_000 });

  // One thought per round-trip: the one before the edit, and the one before the summary. Two, not
  // one — a single panel would mean the rounds' deliberation was merged back into a blob.
  const thoughts = page.getByTestId("reasoning-panel");
  await expect(thoughts).toHaveCount(2);

  // And they are *ordered*: thought, call, thought, answer. Measured on the rendered boxes, since
  // DOM order and visual order are the same thing here — but only the boxes prove it.
  const thought1 = await thoughts.nth(0).boundingBox();
  const call = await rows.first().boundingBox();
  const thought2 = await thoughts.nth(1).boundingBox();
  const close = await answer.boundingBox();
  expect(thought1!.y, "the first thought leads").toBeLessThan(call!.y);
  expect(call!.y, "the call follows the thinking that chose it").toBeLessThan(thought2!.y);
  expect(thought2!.y, "the closing thought precedes the answer it produced").toBeLessThan(close!.y);

  // The rounds' deliberations are their own — a blob would show the first round's sentence inside
  // the second panel too. Each panel has to be opened first: a finished reasoning block folds, and
  // it renders its body only when open.
  await thoughts.nth(0).getByTestId("reasoning-toggle").click();
  await expect(thoughts.nth(0), "round one's own deliberation").toContainText("I should read the file");
  await expect(thoughts.nth(0), "and not round two's").not.toContainText("The tool answered");
  await thoughts.nth(1).getByTestId("reasoning-toggle").click();
  await expect(thoughts.nth(1), "round two's own deliberation").toContainText("The tool answered");
});

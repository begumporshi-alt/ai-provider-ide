/**
 * web-test/reasoning.spec.ts — the model's reasoning is shown, not discarded.
 *
 * # The defect this pins, in full
 *
 * On 2026-10-02 the assistant answered a message with **nothing**. The ledger row said
 * `✕ PARSE_ERROR`, `out: 8192`, and "every delta was model reasoning (delta.thinking) and no text
 * was sent". Probes against `agentrouter.org` reproduced it exactly: the provider enables extended
 * thinking by default, `max_tokens` covers the reasoning **and** the answer, and on a prompt that
 * needs real deliberation the thinking consumed all 8192 tokens, so the stream ended at
 * `stop_reason: max_tokens` without ever opening a text block. At `max_tokens: 64000` the same
 * prompt answered normally. The model was working the whole time; the app had no channel for
 * reasoning, so it threw the work away and then filed the turn as a parse error against a manifest
 * that was correct.
 *
 * # What a unit test cannot prove here
 *
 * `stream-shape.test.ts` proves the classification and `ledger-honesty.test.ts` proves the ledger
 * row. Neither can show that the reasoning reaches a **person**: that is composer → router →
 * interpreter → engine → `onReasoning` → React state → a rendered panel. So this spec drives a real
 * streamed turn through the whole stack and asserts on what is on screen.
 *
 * The mock streams `reasoning_content` deltas and no `content` at all, which is the OpenAI-compatible
 * spelling of the same failure — chosen because the harness's provider is OpenAI-compatible, and
 * because a fix that only understood Anthropic's `delta.thinking` would be a fix for one wire format.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

/**
 * The prompt the mock's reasoning stream is keyed on (`mock.mjs`). Fixed there so this can assert
 * on the text that reached the panel rather than merely that *something* rendered.
 */
const REASONING_HEAD = "The user is asking";
const REASONING_TAIL = "report only the differences";

async function openAssistant(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  // Memory off: distillation issues a second model call after the turn, which would race every
  // assertion below — this spec is about exactly one deliberate request.
  await openRunConfig(page);
  await page.getByLabel("memory").uncheck();
  await closeRunConfig(page);
  await pickModel(page, /oracle-mini/);
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder(/Message your assistant/).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a reasoning-only reply shows the model's thinking instead of an empty bubble", async ({ page }) => {
  await openAssistant(page);
  await send(page, "think: what changed in this release?");

  // Open and filling *while the turn runs*. This is the state that separates "working" from
  // "hung": 46 seconds of an unchanging empty bubble is what the user actually reported. The
  // assertion is on a leading phrase rather than the whole sentence, because the whole sentence
  // does not exist yet — it is still arriving.
  const body = page.getByTestId("reasoning-body");
  await expect(body).toBeVisible();
  await expect(body).toContainText(REASONING_HEAD);

  // No answer was sent, and none is invented. The mock's normal reply must not appear — if it does,
  // this spec is exercising the ordinary path and proves nothing about the failure.
  await expect(page.getByText(/Hello from/)).toHaveCount(0);

  // Once the turn ends the panel folds itself: a finished reasoning block is noise on top of an
  // answer, and the header keeps the fact that it happened.
  const toggle = page.getByTestId("reasoning-toggle");
  await expect(toggle).toContainText("Thought process");
  await expect(body).toBeHidden();

  // The reader can still open it, and gets the whole thing — including the tail that only exists
  // after the stream closed, which is why the final flush is not optional.
  await toggle.click();
  await expect(body).toBeVisible();
  await expect(body).toContainText(REASONING_TAIL);
});

test("the panel is labelled with how much reasoning there was", async ({ page }) => {
  await openAssistant(page);
  await send(page, "think: what changed in this release?");

  // The character count is not decoration: a 40-character thought and a 25 000-character one are
  // different findings, and "the model reasoned" is only actionable with the size attached.
  const toggle = page.getByTestId("reasoning-toggle");
  await expect(toggle).toContainText("characters");
  await expect(toggle).toContainText("Thought process");
});

test("an ordinary reply has no reasoning panel at all", async ({ page }) => {
  await openAssistant(page);
  await send(page, "hello there");

  // The panel must be driven by the stream, not shown empty for every turn. A blank "Thought
  // process" on a plain answer would teach the reader to ignore it.
  await expect(page.getByText(/Hello from/)).toBeVisible();
  await expect(page.getByTestId("reasoning-panel")).toHaveCount(0);
});

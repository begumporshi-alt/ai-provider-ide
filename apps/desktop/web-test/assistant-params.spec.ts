/**
 * web-test/assistant-params.spec.ts — Phase 7: the composer's request controls, and the readouts
 * that describe what the request cost.
 *
 * # What this proves that a typecheck cannot
 *
 * `TextRequest` declared `temperature`/`maxTokens` long before anything in the UI could set them,
 * and the interesting failure is not "the field is missing from the type" — it is "the value
 * reaches the React state and dies there". So the assertions are on the **request body the mock
 * provider actually received**, read out of the harness's egress log, rather than on the input
 * element's value.
 *
 * Same reasoning for the system-prompt editor: a saved string that the request does not carry is
 * a text box, not a feature, so the test asserts the custom prompt is the first message on the wire.
 *
 * # Why the numbers are asserted against the seed
 *
 * `?seed=systemai` publishes `oracle-mini` with `contextWindow: 8192` and pricing of $1/M in and
 * $2/M out. The context meter's denominator and the cost readout are therefore both predictable
 * from the fixture rather than from whatever the machine happens to hold.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

type Store = Record<string, (...a: unknown[]) => unknown>;

interface EgressLogEntry { url: string; body: string | null }
interface WireMessage { role: string; content?: unknown }

async function store<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) => (window as unknown as { __webTest: { store: Store } }).__webTest.store[k]!(),
    key,
  ) as Promise<T>;
}

/** Select the priced seed model (`oracle-mini`, 8192 window). */
async function selectModel(page: Page): Promise<void> {
  await pickModel(page, /oracle-mini/);
}

/** Wait until at least one chat-completions request has been sent, then return it parsed. */
async function lastChatBody(page: Page): Promise<Record<string, unknown>> {
  await expect
    .poll(
      async () =>
        (await store<EgressLogEntry[]>(page, "requests")).some(
          (r) => r.url.endsWith("/chat/completions") && r.body,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const reqs = await store<EgressLogEntry[]>(page, "requests");
  const last = [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body);
  return JSON.parse(last!.body!) as Record<string, unknown>;
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  // Memory off before anything is sent. Recall only prepends a system turn (harmless), but
  // distillation issues a SECOND model call after the turn — so with memory on, "the last
  // chat-completions body" and the ledger totals both depend on a background request that races
  // the assertions. Every test here is about one deliberate request, so the second one is noise.
  await page.getByLabel("memory").uncheck();
  await selectModel(page);
}

test("temperature and max tokens reach the provider", async ({ page }) => {
  await openAssistant(page);

  await page.getByLabel(/Temperature for this request/).fill("0.3");
  await page.getByLabel(/Maximum response tokens for this request/).fill("256");
  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await lastChatBody(page);
  // `{{temperature?}}`/`{{maxTokens?}}` in the openai-compat template are optional placeholders:
  // a value present here means the whole path — composer -> runTurn -> TextRequest -> template —
  // carried it, and a value absent would mean it was dropped somewhere along that path.
  expect(body.temperature).toBe(0.3);
  expect(body.max_tokens).toBe(256);
});

test("blank parameters are omitted rather than sent as zero", async ({ page }) => {
  await openAssistant(page);

  // Nothing touched: the fields start blank, which means "the provider's own default". Sending
  // `temperature: 0` instead would silently make every reply deterministic.
  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await lastChatBody(page);
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("max_tokens");
});

test("the context meter shows the chosen model's window and a growing estimate", async ({ page }) => {
  await openAssistant(page);

  // The denominator comes from the catalog row, not from a constant: 8192 is the seed's window.
  const meter = page.getByTitle(/estimated prompt tokens/);
  await expect(meter).toContainText("8,192");

  // Typing raises the estimate — the meter is about the NEXT send, so it counts the draft.
  await page.getByPlaceholder(/Send a message through the router/)
    .fill("count these words please, thank you very much indeed");
  await expect(meter).not.toContainText("0 / 8,192");
});

test("a custom no-tools system prompt is what the model receives", async ({ page }) => {
  await openAssistant(page);

  await page.getByRole("button", { name: /system prompt/ }).click();
  const CUSTOM = "Answer only in haiku.";
  await page.getByLabel(/no-tools guard/).fill(CUSTOM);
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await lastChatBody(page);
  const msgs = body.messages as WireMessage[];
  // "tell the model it has no tools" is on by default, so this prompt is the first system turn.
  // Blank-vs-custom matters: the assertion is equality, which would also fail if the built-in
  // guard were sent alongside the custom one.
  expect(msgs[0]).toEqual({ role: "system", content: CUSTOM });
});

test("a blank editor field falls back to the built-in prompt", async ({ page }) => {
  await openAssistant(page);

  await page.getByRole("button", { name: /system prompt/ }).click();
  // The fields are empty on a fresh store precisely so this is the default path.
  await expect(page.getByLabel(/no-tools guard/)).toHaveValue("");
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await lastChatBody(page);
  const msgs = body.messages as WireMessage[];
  expect(msgs[0]!.role).toBe("system");
  expect(String(msgs[0]!.content)).toContain("no tools, functions, plugins");
});

test("the session readout accumulates the ledger's tokens and cost", async ({ page }) => {
  await openAssistant(page);

  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();
  await lastChatBody(page);

  // The mock reports `usage: { prompt_tokens: 5, completion_tokens: 3 }` on the stream's final
  // chunk, and the router writes that into the ledger; the readout is a re-read of the same rows,
  // so it shows those numbers. Waiting on the readout rather than on the answer is the point: it
  // is the piece that can lag.
  const readout = page.getByTitle(/Totals for every request this app has routed/);
  await expect(readout).toContainText("5 in", { timeout: 30_000 });
  await expect(readout).toContainText("3 out");

  // 5 * $1/M + 3 * $2/M = 11 micro-USD, which the shared formatter prints as `$0.000011` (sub-cent
  // amounts keep six decimals — two would render this as `$0.00`, i.e. "free"). No `≥` prefix:
  // `oracle-mini` is the priced seed model, so the total is complete.
  await expect(readout).toContainText("$0.000011", { timeout: 30_000 });
});

test("an unpriced model reports its cost as unknown, not as free", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByLabel("memory").uncheck();
  // `oracle-flash` is the seed's deliberately unpriced model: same window, no `pricing_json`.
  await pickModel(page, /oracle-flash/);

  await page.getByPlaceholder(/Send a message through the router/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();
  await lastChatBody(page);

  const readout = page.getByTitle(/Totals for every request this app has routed/);
  // The tokens are known even when the price is not, so they are still shown.
  await expect(readout).toContainText("5 in", { timeout: 30_000 });
  // `—`, not `$0.00`: the ledger row's cost is 0 because no price was published, and "$0.00" would
  // state that the request was free. The tooltip says which requests the total could not price.
  await expect(readout).toContainText("—");
  await expect(readout).not.toContainText("$0.00");
});

test("parameters and a custom prompt survive a reload, and clearing one survives it too", async ({ page }) => {
  await openAssistant(page);

  const temp = page.getByLabel(/Temperature for this request/);
  const prompt = page.getByLabel(/no-tools guard/);
  await temp.fill("0.7");
  await page.getByRole("button", { name: /system prompt/ }).click();
  await prompt.fill("Answer only in haiku.");
  await page.getByRole("button", { name: "Done" }).click();
  // These writes are immediate (the debounced path is `root` only), but give the POST a moment to
  // land rather than racing it.
  await page.waitForTimeout(400);

  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByLabel(/Temperature for this request/)).toHaveValue("0.7");
  await page.getByRole("button", { name: /system prompt/ }).click();
  await expect(page.getByLabel(/no-tools guard/)).toHaveValue("Answer only in haiku.");

  // Clearing has to be as durable as setting. `undefined` is dropped by `JSON.stringify`, so a
  // cleared field saved as `undefined` left the previous value in the row: the box emptied, the
  // setting did not, and the old value reappeared here. The write sends an explicit null/"" now.
  await page.getByLabel(/no-tools guard/).fill("");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel(/Temperature for this request/).fill("");
  await page.waitForTimeout(400);

  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByLabel(/Temperature for this request/)).toHaveValue("");
  await page.getByRole("button", { name: /system prompt/ }).click();
  await expect(page.getByLabel(/no-tools guard/)).toHaveValue("");
});

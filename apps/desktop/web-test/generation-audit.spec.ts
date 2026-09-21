/**
 * web-test/generation-audit.spec.ts — the AI generation trail on Providers.
 *
 * The gap this closes: `generator_audit` has been written since the onboarding wizard existed —
 * every adapter the assistant wrote for us, with the model, the text volume and a hash of the
 * redacted prompt — and **nothing read it back**. Same failure as the gateway log: the trail was
 * evidence nobody could consult, so "an AI wrote the code that routes my traffic" had no answer
 * beyond the database file.
 *
 * Two producers write it (the wizard's candidate generation, and drift repair), and the rows are
 * produced by the app's own audit callbacks. Rather than seed the table directly, these tests drive
 * `generator_audit_record` through `__webTest.invoke` — so each one proves the **write and read
 * shapes agree on field names**, which is the failure a hand-seeded row would hide.
 *
 * Branches are cross-checked, so none of the assertions is vacuous:
 *   1. **Empty is not failed.** "Nothing recorded yet" and "Could not read the trail" are asserted in
 *      separate tests, and each asserts the *other's* copy is absent — a card that rendered one
 *      sentence for both would pass either test alone.
 *   2. **The counts are labelled as estimates.** Both producers send `chars / 4`, not a tokenizer
 *      count. A card that printed a bare number would be claiming a precision nobody measured, so the
 *      header carries `≈` *and* the copy says "estimates" — two marks for one rule, either of which
 *      alone would leave the claim unqualified.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Host = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  failNext: (cmd: string, message: string, afterMs?: number) => void;
};

/** The audit table, scoped so a row elsewhere on the screen cannot satisfy an assertion. */
function audit(page: Page) {
  return page.getByRole("table", { name: "AI generation audit" });
}

/**
 * Write a generation through the app's own record command — the same path both producers use.
 *
 * Must run **before** the screen is opened: the card reads on mount, so a row recorded afterwards
 * would not appear until a refresh.
 */
async function record(
  page: Page,
  modelUsed: string,
  promptTokens: number,
  completionTokens: number,
  redactionHash: string,
): Promise<void> {
  await page.evaluate(
    (e) => (window as unknown as { __webTest: Host }).__webTest.invoke("generator_audit_record", { e }),
    { modelUsed, promptTokens, completionTokens, redactionHash },
  );
}

/**
 * Open Providers so the card mounts **after** the arrangement.
 *
 * `providers` is the app's default screen (`ui-state.ts:17`), so `page.goto` has already mounted the
 * card and read an empty trail by the time a test arranges anything. Clicking "AI Providers" while it
 * is already showing does not remount it — the store's `screen` value does not change — so the read
 * would never happen again and every populated assertion would fail against the mount-time empty
 * state. Going to another screen first makes the switch a real one.
 */
async function openProviders(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "AI Providers", exact: true }).click();
  await expect(page.getByText("AI generation audit")).toBeVisible({ timeout: 10_000 });
}

test("recorded generations render newest first, with the model and a truncated hash", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "anthropic/claude-sonnet-4", 1_200, 340, "b".repeat(64));
  await record(page, "openai/gpt-5", 800, 210, "c".repeat(64));
  await openProviders(page);

  const rows = audit(page).getByRole("row");
  // The header row plus two data rows.
  await expect(rows).toHaveCount(3);

  // Newest first: the trail is read for "what did it just do", so the recent end belongs at the top.
  await expect(rows.nth(1)).toContainText("openai/gpt-5");
  await expect(rows.nth(2)).toContainText("anthropic/claude-sonnet-4");

  // The counts reached the right columns — 800/210 on the newer row, not the older one's 1200/340.
  await expect(rows.nth(1)).toContainText("800");
  await expect(rows.nth(1)).toContainText("210");

  // The digest is truncated to a prefix, not dropped and not printed whole.
  await expect(rows.nth(1)).toContainText("cccccccccccc…");
  await expect(rows.nth(1)).not.toContainText("c".repeat(64));
});

test("the token counts are marked as estimates, not measurements", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "m", 10, 20, "d".repeat(64));
  await openProviders(page);

  // The copy says so...
  await expect(page.getByText(/estimates/)).toBeVisible();
  // ...and both numeric columns carry the marker, so a reader skimming the table alone is not misled.
  await expect(audit(page).getByRole("columnheader", { name: /Prompt ≈/ })).toBeVisible();
  await expect(audit(page).getByRole("columnheader", { name: /Reply ≈/ })).toBeVisible();
});

test("an empty trail reads as 'nothing recorded', not as a failure", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await openProviders(page);

  await expect(page.getByText(/Nothing recorded yet/)).toBeVisible();
  // The distinction the card exists to make, asserted from both sides.
  await expect(page.getByText(/Could not read the trail/)).toHaveCount(0);
  await expect(audit(page)).toHaveCount(0);
});

test("an overlapping read that fails does not leave an error beside fresh data", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  /**
   * Deferred by 200 ms, and the deferral is the whole point.
   *
   * The harness runs `vite` **dev** with `React.StrictMode` (`main.tsx:7`), so the effect fires twice
   * on mount and two reads are in flight. An *immediate* arranged failure is consumed and rejected
   * inside a microtask, so it always lands before the second read resolves — the second read's success
   * then clears the first one's error whichever way the card is written, and the test passes with the
   * supersession guard deleted. (Measured: it did. The first two versions of this test were decoration.)
   *
   * Deferring the rejection puts the superseded read **last**, which is the only ordering where the
   * guard is load-bearing: without it the card renders "Could not read the trail" directly above
   * "Nothing recorded yet" — a pair that cannot both be true, and the state this test was written
   * after seeing.
   */
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "generator_audit_list",
      "web-test shim: arranged failure",
      200,
    ),
  );
  await openProviders(page);

  /**
   * The wait is load-bearing, not padding — and this is the part that is easy to get wrong twice.
   *
   * A deferred rejection lands *after* the newer read has resolved, so an assertion that runs
   * immediately after `openProviders` passes whether or not the guard exists: the test would finish
   * before the state it is about ever existed. It must outlive the deferral.
   *
   * 800 ms is four times the deferral, and the failure mode is *permanent* rather than transient —
   * once a superseded read writes its error, nothing clears it — so there is no race to lose here.
   */
  await page.waitForTimeout(800);

  await expect(page.getByText(/Nothing recorded yet/)).toBeVisible();
  await expect(page.getByText(/Could not read the trail/)).toHaveCount(0);
  await expect(page.getByText(/arranged failure/)).toHaveCount(0);
});

test("a read that fails says so, and does not read as an empty trail", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "openai/gpt-5", 800, 210, "e".repeat(64));
  await openProviders(page);

  // Fail the read the operator explicitly asks for. A one-shot injector cannot fail the *first* read
  // deterministically — StrictMode's second read answers successfully and is the authoritative one —
  // so the failure is arranged against a single deliberate Refresh instead.
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "generator_audit_list",
      "web-test shim: arranged failure",
    ),
  );
  // Named exactly, because Providers now carries two trail cards and both render a "Refresh" — an
  // unqualified `{ name: "Refresh" }` matches both and is a strict-mode violation, which is the
  // selector telling us the accessible names were not distinct.
  await page.getByRole("button", { name: "Refresh generation audit", exact: true }).click();

  await expect(page.getByText(/Could not read the trail/)).toBeVisible();
  await expect(page.getByText(/arranged failure/)).toBeVisible();
  // If these two shared a sentence, "the table could not be read" would look like "nothing has run".
  await expect(page.getByText(/Nothing recorded yet/)).toHaveCount(0);
});

test("a failed refresh drops the previous rows rather than leaving them under the error", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "openai/gpt-5", 800, 210, "e".repeat(64));
  await openProviders(page);

  // The first read succeeded, so there is something on screen to go stale.
  await expect(audit(page).getByRole("row")).toHaveCount(2); // header + one

  // The host stops answering, and the operator asks again.
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "generator_audit_list",
      "web-test shim: arranged failure",
    ),
  );
  // Named exactly, because Providers now carries two trail cards and both render a "Refresh" — an
  // unqualified `{ name: "Refresh" }` matches both and is a strict-mode violation, which is the
  // selector telling us the accessible names were not distinct.
  await page.getByRole("button", { name: "Refresh generation audit", exact: true }).click();

  await expect(page.getByText(/Could not read the trail/)).toBeVisible();
  // The row is gone, not merely annotated: a stale trail under a failure notice is a claim about
  // *now*, and this is the one card that must not claim a generation is current when the read that
  // would have shown it is the read that failed.
  await expect(page.getByText("openai/gpt-5")).toHaveCount(0);
  await expect(audit(page)).toHaveCount(0);
});

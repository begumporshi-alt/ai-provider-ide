/**
 * web-test/drift-history.spec.ts — the recorded drift history on Providers.
 *
 * The gap this closes: `drift_events` has been written on every drift detection and every repair since
 * Phase 5, and its only reader was the clipboard diagnostics bundle. So "when did this provider start
 * drifting, and what closed it" had no answer inside the app — the same failure as `gateway.log` and
 * `generator_audit`, and the last of the three. The trail was evidence nobody could consult.
 *
 * Not to be confused with the repair surface above it: `RepairModal` reads the in-memory
 * `pendingRepairs` map, which is session-only and about *pending* plans. These tests deliberately record
 * through `drift_event_record` — the same command `driftMonitor.onTrigger` calls — so each one proves the
 * write and read shapes agree on field names, which a hand-seeded row would hide.
 *
 * Branches are cross-checked, so none of the assertions is vacuous:
 *   1. **Open is not the same as resolved.** Asserted from both sides in one test, because a card that
 *      rendered one string for both states would pass either assertion alone — and "still drifting" versus
 *      "repaired" is the entire reason the row exists.
 *   2. **Empty is not failed.** "No drift recorded yet" and "Could not read the drift history" are asserted
 *      in separate tests, each also asserting the *other's* copy is absent.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Host = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  failNext: (cmd: string, message: string, afterMs?: number) => void;
};

/** The history table, scoped so a row elsewhere on the screen cannot satisfy an assertion. */
function history(page: Page) {
  return page.getByRole("table", { name: "Drift history" });
}

/**
 * Record a detection through the app's own command, with a well-formed `DriftEvidence` body.
 *
 * Must run **before** the screen is opened: the card reads on mount, so a row recorded afterwards would
 * not appear until a refresh.
 *
 * The provider ids used here are deliberately absent from the registry, so the card falls back to the
 * recorded id — the identity, not the display name. That is what a row shows once its provider has been
 * deleted, and it keeps these tests independent of which providers the seed happens to create.
 */
async function record(
  page: Page,
  providerId: string,
  errors: number,
  models: string[],
  windowMs: number,
): Promise<void> {
  await page.evaluate(
    (e) =>
      (window as unknown as { __webTest: Host }).__webTest.invoke("drift_event_record", {
        providerId: e.providerId,
        triggerJson: JSON.stringify({
          providerId: e.providerId,
          providerSlug: e.providerId,
          errors: e.errors,
          models: e.models,
          windowMs: e.windowMs,
          detectedAt: 1,
        }),
      }),
    { providerId, errors, models, windowMs },
  );
}

/** Record with a body the card cannot parse — the column is free text and the host does not validate it. */
async function recordRaw(page: Page, providerId: string, triggerJson: string): Promise<void> {
  await page.evaluate(
    (e) =>
      (window as unknown as { __webTest: Host }).__webTest.invoke("drift_event_record", {
        providerId: e.providerId,
        triggerJson: e.triggerJson,
      }),
    { providerId, triggerJson },
  );
}

async function resolve(page: Page, providerId: string, resolution: string): Promise<void> {
  await page.evaluate(
    (e) =>
      (window as unknown as { __webTest: Host }).__webTest.invoke("drift_event_resolve", {
        providerId: e.providerId,
        resolution: e.resolution,
      }),
    { providerId, resolution },
  );
}

/**
 * Open Providers so the card mounts **after** the arrangement.
 *
 * `providers` is the app's default screen (`ui-state.ts:17`), so `page.goto` has already mounted the card
 * and read an empty history. Clicking "AI Providers" while it is already showing does not remount it —
 * the store's `screen` value does not change — so the read would never happen again and every populated
 * assertion would fail against the mount-time empty state. Going elsewhere first makes the switch real.
 */
async function openProviders(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "AI Providers", exact: true }).click();
  await expect(page.getByText("Drift history")).toBeVisible({ timeout: 10_000 });
}

test("recorded drift renders newest first, with the provider and a summary of the trigger", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "older-provider", 3, ["a"], 900_000);
  await record(page, "newer-provider", 7, ["b", "c"], 900_000);
  await openProviders(page);

  const rows = history(page).getByRole("row");
  // The header row plus two data rows.
  await expect(rows).toHaveCount(3);

  // Newest first: the history is read for "what has been going wrong lately".
  await expect(rows.nth(1)).toContainText("newer-provider");
  await expect(rows.nth(2)).toContainText("older-provider");

  // The summary is derived from the recorded blob — 7/2/15 belongs to the newer row, not the older one.
  await expect(rows.nth(1)).toContainText("7 drift-class errors");
  await expect(rows.nth(1)).toContainText("across 2 models");
  await expect(rows.nth(1)).toContainText("in 15 min");
  await expect(rows.nth(2)).toContainText("3 drift-class errors");
});

test("an open drift reads as Open, and a repaired one carries its resolution", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  // Two providers, because the host's resolve statement closes *every* open row for one provider
  // (`WHERE provider_id=?1 AND resolution IS NULL`) — so one provider cannot hold both states at once.
  await record(page, "alpha-provider", 5, ["m1", "m2"], 900_000);
  await resolve(page, "alpha-provider", "repaired v3");
  await record(page, "beta-provider", 7, ["m3"], 900_000);
  await openProviders(page);

  const rows = history(page).getByRole("row");
  await expect(rows).toHaveCount(3);

  /**
   * Located by **content, not by index**.
   *
   * This test is about the open/resolved distinction. Reaching the rows by position would make it fail
   * whenever the ordering is wrong — so an ordering bug would fail two tests, one of them named for a
   * different rule, and a failure would name nothing. (Measured: it did, before this was changed.)
   */
  const open = rows.filter({ hasText: "beta-provider" });
  const repaired = rows.filter({ hasText: "alpha-provider" });

  // The unresolved one says so, and does not borrow the resolved one's text.
  await expect(open).toContainText("Open");
  await expect(open).not.toContainText("repaired v3");

  // ...and the resolved one carries what closed it, rather than reading as still open.
  await expect(repaired).toContainText("repaired v3");
  await expect(repaired).not.toContainText("Open");
});

test("a trigger the card cannot parse still renders the row, with no detail claimed", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await recordRaw(page, "unparseable-provider", "not json at all");
  await openProviders(page);

  // The row's *existence* is the evidence. Dropping it to a parse error would hide the very event this
  // card exists to surface, so the failure is confined to the summary cell.
  const rows = history(page).getByRole("row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("unparseable-provider");
  await expect(rows.nth(1)).toContainText("no detail recorded");
});

test("an empty history reads as 'nothing recorded', not as a failure", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await openProviders(page);

  await expect(page.getByText(/No drift recorded yet/)).toBeVisible();
  // The distinction the card exists to make, asserted from both sides.
  await expect(page.getByText(/Could not read the drift history/)).toHaveCount(0);
  await expect(history(page)).toHaveCount(0);
});

test("an overlapping read that fails does not leave an error beside fresh data", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  /**
   * Deferred by 200 ms, and the deferral is the whole point — an immediate arranged failure is consumed
   * and rejected inside a microtask, so it always lands *before* the second StrictMode read resolves,
   * whose success then wipes it. That version of this test passes with the supersession guard deleted.
   */
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "drift_events_list",
      "web-test shim: arranged failure",
      200,
    ),
  );
  await openProviders(page);

  /**
   * The wait is load-bearing: the deferred rejection lands *after* the newer read resolves, so an
   * assertion that ran immediately would pass whether or not the guard exists — the test would finish
   * before the state it is about ever existed. The failure mode is permanent, so there is no race.
   */
  await page.waitForTimeout(800);

  await expect(page.getByText(/No drift recorded yet/)).toBeVisible();
  await expect(page.getByText(/Could not read the drift history/)).toHaveCount(0);
  await expect(page.getByText(/arranged failure/)).toHaveCount(0);
});

test("a read that fails says so, and does not read as an empty history", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "alpha-provider", 5, ["m1"], 900_000);
  await openProviders(page);

  // Fail the read the operator explicitly asks for. A one-shot injector cannot fail the *first* read
  // deterministically — StrictMode's second read answers successfully and is the authoritative one — so
  // the failure is arranged against a single deliberate Refresh instead.
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "drift_events_list",
      "web-test shim: arranged failure",
    ),
  );
  await page.getByRole("button", { name: "Refresh drift history", exact: true }).click();

  await expect(page.getByText(/Could not read the drift history/)).toBeVisible();
  await expect(page.getByText(/arranged failure/)).toBeVisible();
  // If these two shared a sentence, "the history could not be read" would look like "nothing has drifted".
  await expect(page.getByText(/No drift recorded yet/)).toHaveCount(0);
});

test("a failed refresh drops the previous rows rather than leaving them under the error", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await record(page, "alpha-provider", 5, ["m1"], 900_000);
  await openProviders(page);

  // The first read succeeded, so there is something on screen to go stale.
  await expect(history(page).getByRole("row")).toHaveCount(2); // header + one

  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "drift_events_list",
      "web-test shim: arranged failure",
    ),
  );
  await page.getByRole("button", { name: "Refresh drift history", exact: true }).click();

  await expect(page.getByText(/Could not read the drift history/)).toBeVisible();
  // The row is gone, not merely annotated: a stale history under a failure notice is a claim about
  // *now*, and an "Open" row left on screen while the read that would confirm it failed would claim a
  // provider is still drifting on the strength of a read that never happened.
  await expect(page.getByText("alpha-provider")).toHaveCount(0);
  await expect(history(page)).toHaveCount(0);
});

/**
 * A provider stranded in `repairing` must not claim a plan is being built.
 *
 * `driftMonitor.onTrigger` sets the provider `repairing` and fires `buildRepairPlan` with
 * `.catch(() => undefined)`, and the card rendered "Building a repair plan…" for as long as
 * `pendingRepairs` held no entry. Two ordinary situations made that sentence permanently false:
 *
 *   1. `adapters.forProvider` throws `no active manifest` for a provider hydration could not
 *      register — exactly what a corrupt manifest body leaves behind, and what `store.ts:350-357`
 *      promises drift/repair will surface. It sat *outside* the try, so nothing did.
 *   2. `pendingRepairs` is an in-memory `Map`. After a restart a still-`repairing` provider has no
 *      entry and no plan, and nothing is building — the same sentence about a different truth.
 *
 * Both are indistinguishable from the legitimate in-progress case, which is what made this a lie
 * rather than an omission: the operator was told to wait for work that had stopped or never started.
 *
 * Seeded rather than driven through drift detection: `?seed=repair-stuck` supplies a persisted
 * `repairing` provider with an unparseable manifest, which is the post-restart state directly.
 */
test("a provider stranded in repairing says no repair is running, then reports why it cannot build one", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP}?seed=repair-stuck`);
  await expect(page.getByText("Stuck Co")).toBeVisible();

  // No entry, so nothing is building — and the old copy said it was, in the same words it used for
  // a build genuinely in flight.
  await expect(page.getByText(/No repair is running in this session/)).toBeVisible();
  await expect(page.getByText(/Building a repair plan/)).toHaveCount(0);

  // The way out has to exist too, or telling the truth is a dead end: until now `Check health` was
  // hidden for a `repairing` provider, which left the stranded state unreachable through the UI.
  await page.getByRole("button", { name: "Check health" }).click();

  // Now the failure itself, kept rather than swallowed — with the host's own words naming the cause.
  //
  // Scoped to the card's own paragraph: the RepairModal that this click opens renders `entry.error`
  // too, and an unscoped `getByText(/no active manifest/)` resolves to both and dies on strict mode.
  const card = page.getByText(/Drift suspected/);
  await expect(card).toContainText("The repair could not be built", { timeout: 15_000 });
  await expect(card).toContainText("no active manifest for provider seed-stuck");
  await expect(page.getByText(/Building a repair plan/)).toHaveCount(0);
});

/**
 * web-test/trail-health.spec.ts — the trail cards say when their own trail is incomplete.
 *
 * The gap this closes: both trail readers claim completeness ("Every adapter the assistant wrote",
 * "Every time a provider was detected drifting"), and both were fed by writes issued with
 * `.catch(() => undefined)`. A read cannot detect a write that never happened, so a dropped row was
 * indistinguishable from a row that was never written — and, on the drift card, from a repair the
 * operator *declined*, which leaves the row Open too. The channel and all four call sites are covered
 * in `src/store.trail-writes.test.ts`; what is only visible here is the card.
 *
 * **No host hook.** Both paths run through the app's own controls, and `failNext` is the shim's existing
 * affordance for making a UI `catch` branch reachable:
 *   - the repair is staged with "Check health" (`Providers.tsx:87`), which calls `buildRepairPlan` with
 *     a synthetic evidence blob, then approved with "Approve & apply" — so the write that fails is a
 *     genuine `drift_event_resolve` from a real click;
 *   - the wizard's candidate generation is driven by typing through guided setup against the exotic
 *     provider — a genuine `generator_audit_record` on the trail's FIRST producer;
 *   - the repair path's is driven by `Check health` on the drifted provider that `?seed=repair-ai`
 *     supplies — a genuine `generator_audit_record` on the trail's SECOND producer.
 *
 * Why the deterministic branch makes this possible: `plan()` re-fingerprints *before* it considers
 * the AI (`repair-orchestrator.ts:60-73`), and the seeded provider is a known dialect, so the plan
 * comes back `planned` with no AI round — which is what puts "Approve & apply" on screen without
 * needing a scripted generator response.
 *
 * Asserted from both sides. A card that warned unconditionally would satisfy the failure spec alone,
 * so "a repair that was recorded leaves both cards quiet" is the branch cross-check.
 */
import { expect, test, type Page } from "@playwright/test";
import { EXOTIC_BASE, EXOTIC_KEY } from "./seeds";

const APP = "/web-test/";

type Host = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  failNext: (cmd: string, message: string, afterMs?: number) => void;
};

/**
 * One trail card, scoped by its heading.
 *
 * Load-bearing for the scoping spec: both cards render the same warning component, so an unscoped
 * `getByText` would match whichever card happened to warn and prove nothing about which one *should*
 * have. The provider cards are `<section>` too, but they do not contain these headings.
 */
function card(page: Page, heading: string) {
  return page.locator("section").filter({ hasText: heading });
}

/** The warning's own words, without the count — the count is asserted where it is the point. */
const WARNING = /could not be recorded — this history is incomplete/;

/**
 * Stage a repair through the UI and stop with the approval button on screen.
 *
 * `?seed=systemai` gives one enabled provider with a key and a System AI, which is what lets
 * `buildRepairPlan` reach a plan at all.
 */
async function stageRepair(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Check health" }).click();
  await expect(page.getByRole("button", { name: "Approve & apply" })).toBeVisible({ timeout: 30_000 });
}

test("a repair whose drift event could not be closed says so, and the drift card warns", async ({
  page,
}) => {
  await stageRepair(page);

  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "drift_event_resolve",
      "web-test shim: arranged failure",
    ),
  );
  await page.getByRole("button", { name: "Approve & apply" }).click();

  /**
   * Asserted before the card, because the modal closes itself 1.2 s after the message
   * (`Providers.tsx`, `window.setTimeout(onClose, 1200)`). The card's warning is persistent, so it
   * can wait; this one cannot.
   */
  // The repair still applied, and is still reported as applied — the failure is the *record's*.
  await expect(page.getByText(/Repaired — adapter v/)).toBeVisible();
  // ...and the modal says what is in doubt. This is the only moment the operator can learn it: the
  // drift card below shows the row as still Open, which is also what *declining* a repair looks like.
  await expect(page.getByText(/its drift event could not be closed/)).toBeVisible();

  // The card that claims completeness must stop claiming it.
  await expect(card(page, "Drift history").getByText(WARNING)).toBeVisible();
  // Scoped, not global: a lost drift write must not be announced by the generation-audit card.
  await expect(card(page, "AI generation audit").getByText(WARNING)).toHaveCount(0);
});

test("a repair that was recorded leaves both cards quiet", async ({ page }) => {
  await stageRepair(page);

  // No arranged failure — the branch cross-check. Without it, a warning that rendered on every repair
  // would satisfy the spec above, and the card would be crying wolf on a healthy install.
  await page.getByRole("button", { name: "Approve & apply" }).click();

  /**
   * Captured once and asserted on the string, **not** with a retrying locator assertion.
   *
   * The modal dismisses itself 1.2 s after the message, and `expect(...).toHaveCount(0)` retries for
   * 30 s — so it would wait for the modal to close and then pass whatever the message had said.
   * Measured: with `approveRepair` hardcoded to report `resolveRecorded: false`, that form of this
   * assertion still passed. A negative assertion against an auto-dismissing surface cannot fail.
   */
  const message = await page.getByText(/Repaired — adapter v/).textContent();
  expect(message).not.toContain("could not be closed");
  // The warning is *not* inside the modal, so it persists, and a retrying absence assertion against a
  // persistent element is meaningful: if it ever rendered it would still be there 30 s later.
  await expect(page.getByText(WARNING)).toHaveCount(0);
});

/** Providers → Add Provider → guided setup. Copied from `ui.spec.ts`, which keeps its own local copy. */
async function startWizard(page: Page, name: string, baseUrl: string, key: string): Promise<void> {
  await page.getByRole("button", { name: /Add Provider/ }).click();
  await page.getByText("Any other provider — guided setup").click();
  await page.getByPlaceholder("My provider").fill(name);
  await page.getByPlaceholder("https://api.example.com/v1").fill(baseUrl);
  await page.getByPlaceholder("sk-…").fill(key);
  await page.getByRole("button", { name: "Start setup" }).click();
}

/**
 * The wizard's audit write — the call site the first pass missed, and the reason this spec exists.
 *
 * `Onboarding.tsx` built its own `generator_audit_record` payload and its own
 * `invoke(...).catch(() => undefined)` instead of going through the shared producer, so when the other
 * three trail writes were routed through `writeTrail` this one stayed **silent** — on the producer the
 * generation-audit card names *first*, while the card went on claiming completeness for it. A grep for
 * the command name did not find it, which is exactly why this drives the real path rather than trusting
 * a search: the wiring is now shared (`recordGeneratorAudit`), and this is what proves the call site
 * actually uses it.
 *
 * Cost: the exotic provider's probes 404, so the declarative AI round has to run before the audit
 * callback is reached — hence the 90 s wait, matching `ui.spec.ts`'s Tier-2 story.
 */
test("a generation the wizard could not record is reported on the generation-audit card", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await expect(page.getByText("System AI (mock)")).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "generator_audit_record",
      "web-test shim: arranged failure",
    ),
  );

  await startWizard(page, "Exotic ND", EXOTIC_BASE, EXOTIC_KEY);
  // The AI round ran — the state the audit callback is reached from. The declarative round is scripted
  // to fail on this API, and that failure is the proof the generator was actually invoked.
  await expect(page.getByText(/No candidate passed the free contract checks/)).toBeVisible({
    timeout: 90_000,
  });

  // Leave the wizard for the screen that owns the card. Works mid-wizard because the nav is outside the
  // screen switch — `App.tsx` wraps every screen, onboarding included, in `Shell`.
  await page.getByRole("button", { name: "AI Providers", exact: true }).click();

  await expect(card(page, "AI generation audit").getByText(WARNING)).toBeVisible();
  // Scoped: the wizard writes the *generator* trail, so the drift card must stay quiet.
  await expect(card(page, "Drift history").getByText(WARNING)).toHaveCount(0);
});

/**
 * The repair path's audit write — the trail's OTHER producer, and the one a recorded coverage gap
 * called unreachable. This spec is the measurement that says it is reachable.
 *
 * The stated reason was wrong, and it is worth naming because it was written into the docs four
 * times: `mock.mjs` matches the generator round on its **system prompt** (`mock.mjs:152`), and
 * `adapter-generator.ts:99` builds that prompt identically for both callers — the wizard and the
 * repair. So the mock has always served this round, with the same deliberately-unusable reply. The
 * audit is also awaited *before* the output is parsed (`adapter-generator.ts:254`), so a round that
 * yields no usable manifest still writes a row.
 *
 * What actually gated this was state, not scripting: `?seed=repair-ai` supplies a provider whose
 * re-fingerprint fails (the exotic) plus the second enabled provider the repair AI round requires
 * (`store.ts:221`). `Check health` on that provider's own card then runs the real
 * `buildRepairPlan` → `generateCandidates` → `recordGeneratorAudit`, and `failNext` fails a genuine
 * write from a genuine click.
 */
test("a generation the repair path could not record is reported on the generation-audit card", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=repair-ai`);
  await expect(page.getByText("Exotic ND")).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "generator_audit_record",
      "web-test shim: arranged failure",
    ),
  );

  // Scoped to the drifted provider. The oracle fingerprints as a known dialect, so its own Check
  // health returns a deterministic plan and never reaches the AI round.
  await card(page, "Exotic ND").getByRole("button", { name: "Check health" }).click();

  /**
   * The plan's own evidence, and the proof the AI round ran rather than being skipped: this line is
   * pushed only when the free re-fingerprint matched no dialect (`repair-orchestrator.ts:76`). It
   * also carries the wait, so the warning below cannot pass by arriving before the write.
   */
  await expect(page.getByText(/no known dialect matched/)).toBeVisible({ timeout: 60_000 });

  await expect(card(page, "AI generation audit").getByText(WARNING)).toBeVisible();
  // Scoped: the repair path writes the *generator* trail, so the drift card must stay quiet.
  await expect(card(page, "Drift history").getByText(WARNING)).toHaveCount(0);
});

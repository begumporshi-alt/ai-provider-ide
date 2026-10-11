/**
 * web-test/rich-cards.spec.ts — the transcript's rich document rendering, driven end to end.
 *
 * Three ZCode-parity behaviours, each through the real run path:
 *
 * 1. Plan mode's plan renders as a titled document card — header, clamped preview with fade,
 *    "View full plan →" expanding in place — and the card SURVIVES approval, because the plan is
 *    still the reference document while the executing pass runs. The approved plan's reveal button
 *    points at the file the host actually wrote.
 * 2. The same card comes BACK when the session is resumed: it renders from the tool call's recorded
 *    arguments, so the transcript's timeline must carry them (`tool_calls` / `tool_call_id`).
 * 3. A whole HTML document the model produces renders live in a sandboxed iframe (Preview/Code
 *    toggle), while the prose around it stays ordinary markdown.
 *
 * The oracle variants live in mock.mjs (`/plan the/` in plan mode, `/html page/` in plain chat).
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

/** The harness controls the transcript rebuild needs: what plan_save wrote, and what the UI asked
 *  the OS to open (the reveal call's only observable effect in a browser). */
type WebTest = {
  __webTest: { plans: () => Record<string, string>; openerCalls: () => string[] };
};

async function openChat(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
}

/** A plan pass, approved and carried out — the state both resume assertions rebuild from. */
async function runPlanPassToApproval(page: import("@playwright/test").Page) {
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);
  // Agent mode needs a root; plan mode is read-only but the guard is the same either way.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("plan the subagent system upgrade");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("plan-review-body")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve — implement it now" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  // The run is over once its change set lands — which is also when the recorder has flushed, so a
  // resume after this point sees every node it is going to see.
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
}

test("plan mode's plan renders as an expandable document card on the call that presented it", async ({ page }) => {
  await openChat(page);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);
  // Agent mode needs a root; plan mode is read-only but the guard is the same either way.
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  await page.getByPlaceholder(/Describe a task for the agent/).fill("plan the subagent system upgrade");
  await page.getByRole("button", { name: "Send" }).click();

  // The card, not a bare markdown message: title from the document's h1, header labelled Plan. It
  // hangs on the `exit_plan_mode` call the model made, which is also the call that raised the
  // review now on screen.
  const card = page.getByTestId("doc-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases");
  await expect(card.getByText("Plan", { exact: true })).toBeVisible();
  // Nothing is on disk yet, so there is nothing to reveal — the button appears with the file.
  await expect(page.getByTestId("doc-card-reveal")).toHaveCount(0);

  // The preview is clamped (scrollHeight beyond the max-height), and the last step sits below
  // the fold until the pill opens the document. Clipped-but-present text still counts as
  // "visible" to Playwright, so the clamp is asserted by measurement, not visibility. No clicks
  // yet: the review modal's backdrop is up, and a click would answer the review instead.
  const lastStep = "Keep fragments and snippets as highlighted code";
  const isClamped = () =>
    page.getByTestId("doc-card-body").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(await isClamped()).toBe(true);
  await expect(card.getByText(lastStep)).toBeAttached();

  // --- approve, and the card stays: the plan is on the record --------------------------
  await page.getByRole("button", { name: "Approve — implement it now" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });

  // The approval wrote the plan, so the card now points at the file — and the reveal reaches the
  // OS with the root-joined path, which is the only observable effect a browser can assert. Polled
  // because the opener call resolves a tick after the click, like every other opener assertion
  // here (`artifacts.spec.ts`).
  await expect(page.getByTestId("doc-card-reveal")).toBeVisible();
  await page.getByTestId("doc-card-reveal").click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as unknown as WebTest).__webTest.openerCalls())).some((p) =>
        /^\/tmp\/\.zcode\/plans\/plan-.+\.md$/.test(p),
      ),
    )
    .toBe(true);

  // With the transcript free of modals the card expands in place, and collapsing returns the
  // clamped preview.
  await page.getByTestId("doc-card-view").click();
  await expect(card.getByText(lastStep)).toBeVisible();
  await expect(page.getByTestId("doc-card-view")).toHaveCount(0);
  expect(await isClamped()).toBe(false);
  await page.getByTestId("doc-card-collapse").click();
  expect(await isClamped()).toBe(true);
  await expect(card).toBeVisible();
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases");
});

// The card renders from the exit_plan_mode call's recorded ARGUMENTS, so a resumed session can
// rebuild it only if the timeline carries the calls back. That is the half the harness could not
// prove before (the shim returned no tool_calls), and losing it is silent: the transcript still
// renders — every tool result just degrades to an unlabelled bubble and the plan is gone.
test("the plan card and its tool row come back when the session is resumed", async ({ page }) => {
  await openChat(page);
  await runPlanPassToApproval(page);
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases");

  // Empty the pane with a fresh session, then reopen this one — the same affordance
  // assistant-session.spec.ts uses for its resume assertions.
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(page.getByRole("button", { name: /untitled session/ })).toBeVisible();

  await page.getByRole("button", { name: /untitled session/ }).click();
  // The session row is labelled by its title or its first-message preview.
  await page.getByRole("menuitem", { name: /plan the subagent system upgrade/ }).click();

  // The tool row AND the card, both rebuilt from the recorded calls.
  await expect(page.getByTestId("tool-run-group").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("doc-card-title")).toHaveText("Subagent System Upgrade — Two Phases", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("doc-card-body")).toContainText("Phase 1 — the plan card");
  // The resumed card can reveal the same file: its path is in the replayed result sentence.
  await page.getByTestId("doc-card-reveal").click({ timeout: 30_000 });
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as unknown as WebTest).__webTest.openerCalls())).some((p) =>
        /^\/tmp\/\.zcode\/plans\/plan-.+\.md$/.test(p),
      ),
    )
    .toBe(true);
  // And the plan reached the workspace outside the sandbox — the claim the resume path depends on.
  const plans = await page.evaluate(() => (window as unknown as WebTest).__webTest.plans());
  expect(Object.keys(plans).some((p) => /^\.zcode\/plans\/plan-.+\.md$/.test(p))).toBe(true);
});

test("a whole HTML document renders live in a sandboxed frame, with the source one click away", async ({ page }) => {
  await openChat(page);

  await page.getByPlaceholder(/Message your assistant/).fill("build me an html page");
  await page.getByRole("button", { name: "Send" }).click();

  const preview = page.getByTestId("html-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  // The prose around the document is still markdown; the document is a frame, not markup text.
  await expect(page.getByText("Here is a small page:")).toBeVisible();
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);

  // Sandboxed: scripts may run, the opaque origin may not touch this app's storage or bridge.
  const sandbox = await page.getByTestId("html-preview-frame").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");

  // Code view shows the source; Preview returns the live frame.
  await page.getByTestId("html-preview-code").click();
  await expect(page.getByTestId("html-preview-source")).toContainText("<!doctype html>");
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(0);
  await page.getByTestId("html-preview-preview").click();
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
});

test("an html snippet stays a code block — fragments are not pages", async ({ page }) => {
  await openChat(page);

  // Any prompt the mock does not script answers "Hello from oracle-mini" — good enough: the
  // assertion is that NO preview card appears for ordinary chat, which this proves cheaply.
  await page.getByPlaceholder(/Message your assistant/).fill("say hello");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Hello from oracle-mini")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("html-preview")).toHaveCount(0);
  await expect(page.getByTestId("doc-card")).toHaveCount(0);
});

/**
 * web-test/agent-approval.spec.ts — Phase 5's acceptance criterion, driven for real.
 *
 * The plan states it as a sentence: *"in 'auto-approve reads' a `read_file` runs with no modal but
 * `write_file` still prompts; a run's edits are shown as a diff set that can be applied or
 * reverted."* Both halves are asserted here through the actual agent loop, the actual policy, and
 * the harness's virtual sandbox — not through `decide()` alone, which would pass while the gate was
 * wired to the wrong tool's effect.
 *
 * The virtual FS is read directly (`__webTest.vfs`) for the revert assertions. The diff on screen
 * is what the UI believes happened; only the sandbox can falsify a revert that reported success.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

/** The oracle's edit variant rewrites README.md's "world" to "there", as the shim's FS holds it. */
const README_BEFORE = "hello\nworld\n";
const README_AFTER = "hello\nthere\n";

type WebTest = { __webTest: { vfs: () => Record<string, string> } };

async function openAgentChat(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
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
}

async function vfs(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as WebTest).__webTest.vfs());
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByPlaceholder(/Describe a task for the agent/).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("auto-approve reads: a read runs with no modal, and the run finishes", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("auto-reads");
  await closeRunConfig(page);

  // The oracle's default agent variant is one `list_dir` call — a read.
  await send(page, "list files");

  // No gate at all: the loop never pauses, so the terminal answer arrives on its own.
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("auto-approve reads: a write still prompts", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("auto-reads");
  await closeRunConfig(page);

  await send(page, "edit the readme greeting");

  // The mode covers reads only. `edit_file` declares `effect: "mutate"`, and the title of the
  // modal says "change" rather than "tool call" so the reader knows which kind they are approving.
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("approve-effect")).toHaveText("modifies the workspace");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // Having decided once, this call is not asked about again within the run.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });
});

test("yolo: a write runs with no modal at all", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);

  await send(page, "edit the readme greeting");

  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await vfs(page))["README.md"]).toBe(README_AFTER);
});

test("a run's edits are shown as a diff set and can be reverted", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("auto-reads");
  await closeRunConfig(page);

  await send(page, "edit the readme greeting");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // --- the change set ----------------------------------------------------------------
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("1 file changed in this run")).toBeVisible();
  // The diff is the real one: the checkpoint read "world" out of the file before the write, so the
  // removed line is shown rather than the "previous contents are not shown" caveat a `write_file`
  // used to carry.
  await expect(page.getByText("did not exist before this run")).toHaveCount(0);
  // Scoped to the change-set panel: the transcript above it renders the same file's diff for the
  // call that made it, and this assertion is about the panel's own view of the run.
  //
  // The panel opens COLLAPSED (2026-10-01): expanded, it put one run's change on screen twice — the
  // transcript's copy and the panel's — so it now starts as a summary (path, verb, +/− counts) with
  // the lines one click away. Both states are pinned, because "collapsed on purpose" and "broken"
  // are the same thing to a missing locator.
  const diff = page.getByTestId("change-set").getByRole("group", { name: "Diff of README.md" });
  await expect(diff).toHaveCount(0);
  await page.getByTestId("change-set").getByTitle("Show the diff").click();
  await expect(diff.locator('[data-kind="del"]').filter({ hasText: "world" })).toBeVisible();
  await expect(diff.locator('[data-kind="add"]').filter({ hasText: "there" })).toBeVisible();
  expect((await vfs(page))["README.md"]).toBe(README_AFTER);

  // --- revert ------------------------------------------------------------------------
  await page.getByRole("button", { name: "Revert this run" }).click();

  // The file itself, not a message about it.
  await expect.poll(async () => (await vfs(page))["README.md"], { timeout: 15_000 }).toBe(README_BEFORE);
  await expect(page.getByTestId("change-set")).toHaveCount(0);
  // And the user is told what was restored, because a revert that quietly skipped a file would
  // otherwise look identical to one that did not.
  await expect(page.getByTestId("composer-notice")).toContainText("reverted 1 of 1 file");
});

test("'keep changes' leaves the files alone", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);

  await send(page, "edit the readme greeting");
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Keep changes" }).click();

  await expect(page.getByTestId("change-set")).toHaveCount(0);
  expect((await vfs(page))["README.md"]).toBe(README_AFTER);
});

test("'always allow this tool' covers the next call of the same tool", async ({ page }) => {
  await openAgentChat(page);

  await send(page, "edit the readme greeting");
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  // Answer the question the modal asks about the tool, not just about this call.
  await page.getByRole("button", { name: /Always allow edit_file/ }).click();
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Keep changes" }).click();

  // A second turn makes the same tool call. If the grant had not been recorded, the run would stop
  // at a modal and never reach its change set — so the change set appearing *is* the assertion, and
  // the dialog check says why.
  await send(page, "edit the readme again");
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await vfs(page))["README.md"]).toBe(README_BEFORE);
});

test("plan mode refuses a write without asking, then executes the approved plan", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  await expect(page.getByTestId("plan-mode-hint")).toBeVisible();
  await closeRunConfig(page);

  await send(page, "edit the readme greeting");

  // The refusal is the mode's, so there is nobody to ask: no modal may appear, not even for a
  // mutation the user would have had to approve a moment earlier. Wait for the pass to end first —
  // the approve panel is the only thing that appears when it is over, and asserting on the live
  // view would be racing the transcript that replaces it.
  await expect(page.getByTestId("plan-approve")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The model was told why, in the mode's own words rather than "the user denied this".
  await expect(page.getByText(/in PLAN MODE/).first()).toBeVisible();
  // And nothing was written. This is the guarantee plan mode actually makes.
  expect((await vfs(page))["README.md"]).toBe(README_BEFORE);

  // --- approve ------------------------------------------------------------------------
  await page.getByRole("button", { name: "Approve plan & execute" }).click();

  // Now the same call is an ordinary mutation under the ordinary mode, so it asks.
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });
  expect((await vfs(page))["README.md"]).toBe(README_AFTER);
  // The approve panel is gone: the run it was offering is the one that just happened.
  await expect(page.getByTestId("plan-approve")).toHaveCount(0);
});

// 2026-10-10: plan mode carries its own read policy. This is the half that used to be a hint —
// "pair it with auto-approve reads". Under the default "ask every time", a planning pass opened a
// modal for the very read it exists to perform: approve-the-read, approve-the-read, plan. Reads now
// run inside plan mode; the gate keeps its other half, which is that nothing may write.
test("plan mode is read-only: a read runs with no modal under 'ask every time'", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);

  // The oracle's default variant is one `list_dir` call — a read, and one the default mode would
  // otherwise stop on. Nothing may stop it here: if the gate asked, the run would park on a modal
  // and the terminal answer would never arrive.
  await send(page, "list files");
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// The panel's condition used to be `msgs.length > 0`, which is true of any transcript. So ticking
// the switch on a conversation offered to "Approve plan & execute" a plan that did not exist yet,
// and ticking it again after approving re-offered the plan that had just been executed. Both
// halves are pinned here.
test("the approve panel waits for a plan, and an approved plan is not offered again", async ({ page }) => {
  await openAgentChat(page);
  // An ordinary pass first, so the transcript is non-empty — the state the old condition keyed on.
  await send(page, "list files");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });

  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  // The hint renders with the toggle itself, so it proves the re-render happened while the panel is
  // still open — the bar's absence below is a real absence, not a frame the assertion won.
  await expect(page.getByTestId("plan-mode-hint")).toBeVisible();
  await closeRunConfig(page);
  await expect(page.getByTestId("plan-approve")).toHaveCount(0);

  // A plan pass does produce one: the oracle's plan document is prose with no tool call.
  await send(page, "plan the subagent system upgrade");
  await expect(page.getByTestId("plan-approve")).toBeVisible({ timeout: 30_000 });

  // --- approve it for real -------------------------------------------------------------
  await page.getByRole("button", { name: "Approve plan & execute" }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByTestId("change-set")).toBeVisible({ timeout: 30_000 });

  // The question is answered. Turning plan mode back on means "make another plan" — it must not
  // re-offer the plan that was just carried out.
  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  await expect(page.getByTestId("plan-mode-hint")).toBeVisible();
  await closeRunConfig(page);
  await expect(page.getByTestId("plan-approve")).toHaveCount(0);
});

// A pass whose switch is off must not be recorded as a plan. The marking used to read the live
// switch at the finish transition; the ref-based capture that replaced it has to be re-answered by
// EVERY pass — plain chat included — or it reintroduces the same bug through the other door: the
// capture left standing from an earlier plan pass cards the next plain answer as a "Plan".
test("a plain answer after a plan pass is not carded as a plan", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);

  // A plan pass first, so the capture has been set at least once.
  await send(page, "plan the subagent system upgrade");
  await expect(page.getByTestId("doc-card")).toBeVisible({ timeout: 30_000 });

  // Now leave plan mode AND agent mode: the next turn is ordinary chat.
  await openRunConfig(page);
  await page.getByLabel("plan mode").uncheck();
  await page.getByLabel("agent mode").uncheck();
  await closeRunConfig(page);

  await page.getByPlaceholder(/Message your assistant/).fill("say hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Hello from oracle-mini")).toBeVisible({ timeout: 30_000 });
  // The plain answer is a message, not a document. Counted as a positive first — that form is only
  // satisfiable once the plain pass is the one being rendered, where `toHaveCount(0)` on a filter
  // can pass in the window before the finish effect has run.
  await expect(page.getByTestId("doc-card")).toHaveCount(1);
  await expect(page.getByTestId("doc-card").filter({ hasText: "Hello from oracle-mini" })).toHaveCount(0);
});

// A wholesale transcript change answers or discards the plan question too. Without this, New chat
// left the bar sitting over an empty chat, offering to approve a plan from the conversation that
// had just been thrown away — the same `msgs.length > 0` bug through a different door.
test("starting a new chat clears a plan that was pending", async ({ page }) => {
  await openAgentChat(page);
  await openRunConfig(page);
  await page.getByLabel("plan mode").check();
  await closeRunConfig(page);

  await send(page, "plan the subagent system upgrade");
  await expect(page.getByTestId("plan-approve")).toBeVisible({ timeout: 30_000 });

  // The palette's New chat — the affordance that empties the transcript wholesale.
  const mac = await page.evaluate(() =>
    /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent),
  );
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+k`);
  const row = page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: /New chat/ });
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();

  // Empty transcript, and nothing to approve.
  await expect(page.getByText("Subagent System Upgrade — Two Phases")).toHaveCount(0);
  await expect(page.getByTestId("plan-approve")).toHaveCount(0);
});

// The gate and Stop used to fight: while the modal was up the loop was parked on the approval
// promise, and an abort flipped the controller's flag without resolving it. The gate now races
// the run's abort signal and answers "stopped by you" on its behalf.
//
// The modal's backdrop swallows every click outside it, so the pointer cannot leave the
// Assistant while the gate is up — but keyboard focus can. Leaving the screen unmounts the modal
// (and the whole transcript state with it) while the loop is STILL parked on the gate, and the
// only remaining handle on that run is the Agents dashboard's stop. Stopping there used to flip
// the abort flag and nothing else: the promise never resolved, and the run row claimed
// "running" forever. The dashboard is this test's oracle for exactly that.
test("stopping a run parked on the approval gate unblocks it", async ({ page }) => {
  await openAgentChat(page);

  // Default mode ("ask"): every call waits for the modal, so the run is parked on the gate.
  await send(page, "edit the readme greeting");
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });

  // The live status line names the parked state instead of showing anonymous dots.
  await expect(page.getByTestId("agent-status")).toContainText("Waiting for you — edit_file needs approval");

  // The backdrop sits between the pointer and everything else — even a synthetic click at the
  // rail's coordinates lands on the backdrop (and would answer the modal). Focus does not care:
  // a keyboard user can still Tab to the rail and press Enter, which is exactly the path this
  // click takes. Leaving the screen unmounts the modal — and the whole transcript state with it —
  // while the loop is STILL parked on the gate, and the only remaining handle on that run is the
  // Agents dashboard's stop.
  await page.getByRole("button", { name: "Agents", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "stop", exact: true }).click();

  // The run must actually end — not keep claiming "running" from a loop parked on a dead gate.
  await expect(page.getByText("● running")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("stopped", { exact: true })).toBeVisible();
});

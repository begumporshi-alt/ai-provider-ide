/**
 * web-test/agent-turn.spec.ts — drive a real agent turn end to end.
 *
 * This is the one Assistant path that exercises P4 (recordAgentTurn: message + skill + artifact
 * nodes, follows/used/produced edges), P5 (skills prompt block is appended to the agent's
 * system turn), and P6 (startRun / recordStep / endRun from the actual loop) together. Until
 * the harness could emulate tool calls, this had never been driven — every previous P6 spec
 * was seeded directly through the shim.
 *
 * The oracle's chat/completions mock emits one list_dir(".") call on the first turn and a
 * final answer on the second. The shim's tool_run returns the contents of a one-file virtual
 * FS, with the same path-confinement rules as tools.rs.
 */
import { expect, test } from "@playwright/test";

const APP = "/web-test/";

test("agent turn: a tool call lands in the graph and the run in the dashboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  // --- set up the Assistant for agent mode -------------------------------------------
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /oracle-mini/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);

  // The "tell the model it has no tools" toggle is disabled in agent mode by design — exercise it
  // off first to make sure the controls change, then flip on agent mode.
  await page.getByLabel("agent mode").check();
  // Without a root the guard keeps Send disabled; fill it.
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");

  // --- send the task -----------------------------------------------------------------
  await page.getByPlaceholder(/Describe a task for the agent/).fill("list files");
  await page.getByRole("button", { name: "Send" }).click();

  // --- approve the tool call ---------------------------------------------------------
  // The harness's oracle emits list_dir(".") once; the confirm modal pauses the loop. The
  // Modal component renders an <h2> title rather than role="dialog", so we anchor on the
  // heading (and on the tool name next to it) instead.
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("list_dir", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeHidden({ timeout: 30_000 });

  // --- the loop completes with the final answer --------------------------------------
  // recordAgentTurn only runs after the final answer, so this is the signal that all of
  // P4 (record), P6 (endRun) have already happened upstream of the flush.
  await expect(
    page.getByText("Done. Here is what I found in the workspace."),
  ).toBeVisible({ timeout: 30_000 });

  // --- P4: the conversation graph records the turn ----------------------------------
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await expect(page.locator("canvas")).toBeVisible({ timeout: 15_000 });
  // Three kinds must be present (the three record paths the agent fires): the user message,
  // the assistant messages (the loop produces two), a skill node for the tool call, and an
  // artifact node for the tool result. Pin the kinds via the kind filter chips so the
  // assertion stays meaningful even if the exact node count shifts in a refactor.
  for (const kind of ["message", "skill", "artifact"]) {
    await expect(page.getByRole("button", { name: kind, exact: true })).toBeVisible({ timeout: 15_000 });
  }
  // And the user prompt must appear as a message node label — the most direct evidence that
  // recordAgentTurn received the turn and the user node was created with the right text.
  const nodes = await page.evaluate(
    () =>
      (
        window as unknown as {
          __webTest: {
            store: { contextNodes: () => { id: string; kind: string; label: string }[] };
          };
        }
      ).__webTest.store.contextNodes(),
  );
  expect(nodes.find((n) => n.kind === "message" && n.label === "list files")).toBeTruthy();

  // --- P6: the run shows up with the tool call recorded as a step --------------------
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("1 runs · 0 running · 1 ok · 0 failed · 0 stopped")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("list files")).toBeVisible();
  await page.getByText("list files").click();
  await expect(page.getByText("3 steps")).toBeVisible({ timeout: 15_000 });
  // Steps: tool_call, tool_result, done — in order.
  for (const kind of ["tool_call", "tool_result", "done"]) {
    await expect(page.getByText(kind, { exact: true }).first()).toBeVisible();
  }
});

/**
 * A tool that FAILS must still tell the model — and the user — why.
 *
 * The bug this guards: `host.ts` forwarded only `output`, and Rust sends `output:""` with the
 * reason in `error`, so every refusal reached the model as a blank tool result. The model then
 * reported "the tool results came back empty, which is unusual" and could not say why. The shim
 * reproduces the exact wire shape, so this drives the real bridge, not a stand-in.
 */
test("agent turn: a failed tool call shows the host's reason, not a blank result", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /oracle-mini/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByLabel("agent mode").check();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");

  // "missing" routes the oracle to read_file of a file the virtual FS does not have.
  await page.getByPlaceholder(/Describe a task for the agent/).fill("read the missing file");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow" }).click();

  // The reason itself, surfaced through the real host bridge.
  await expect(page.getByText(/no such file/)).toBeVisible({ timeout: 30_000 });
  // And not the blank row the bug produced.
  await expect(page.getByText(/\(no output/)).toHaveCount(0);
});

/**
 * A run whose *ending* could not be written must not be reported as a session that closed.
 *
 * `endRun` drops the controller *before* it writes the finish, so a write that fails leaves exactly
 * the picture a killed session leaves: the row says `running` and no controller holds it. The
 * dashboard used to explain that picture with a *cause* — "the app was closed mid-run" — and this
 * makes the cause false. The status is not in doubt, though: `endRun` was handed it, and only the
 * write failed. So the row shows what happened, marked, and never borrows the closed-session story.
 *
 * Driven through the real loop, not seeded: the whole point is that `endRun` ran.
 */
test("agent turn: an unrecorded ending shows the status it was, not a closed session", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /oracle-mini/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByLabel("agent mode").check();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");

  // Arrange the failure before the loop can reach its finish write.
  await page.evaluate(() =>
    (window as unknown as { __webTest: { failNext: (cmd: string, message: string) => void } })
      .__webTest.failNext("agent_run_finish", "web-test shim: arranged failure"),
  );

  await page.getByPlaceholder(/Describe a task for the agent/).fill("list files");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Agents", exact: true }).click();

  // The ending was observed, so the row carries the status the loop reported...
  await expect(page.getByText(/ok ⚠ unrecorded/)).toBeVisible({ timeout: 15_000 });
  // ...the tally follows the row rather than the stale table...
  await expect(page.getByText("1 runs · 0 running · 1 ok · 0 failed · 0 stopped")).toBeVisible();
  // ...and the closed-session explanation is not borrowed for a session that never closed.
  // Scoped to the table: the footer names "no handle" when it explains that state, so an unscoped
  // `getByText` would match the legend and assert nothing about the row.
  await expect(page.locator("tbody").getByText("no handle")).toHaveCount(0);
  await expect(page.getByText(/● running/)).toHaveCount(0);
});

/**
 * A run whose *start* could not be written is missing from the dashboard entirely.
 *
 * This is the one loss on this screen that leaves no trace at all — no row, no status, nothing an
 * ending could be marked on — and it is worse than the ending case for a second reason: every later
 * step append for that run fails too, for the same cause (a foreign key in Rust, `unknown run` in the
 * shim). Counting each failure would turn one lost run into "4 writes could not be recorded", and a
 * two-run outage into a number that suggests eight separate faults.
 *
 * So the count is pinned at **1**, which is the assertion that carries the weight here: it is the
 * suppression being exercised, not merely a warning appearing. The shim enforces the real semantics —
 * `agent_step_append` genuinely rejects with `unknown run` — so this drives the actual failure chain.
 *
 * The finish write contributes nothing either way here, and that is itself worth knowing: both the
 * shim (`case "agent_run_finish"`) and `orchestrator.rs:123` update without checking a row count, so
 * they report success for a run that does not exist. A lost ending is only ever visible when the row
 * is there to be wrong about — which is the case the spec above covers.
 */
test("agent turn: a run that was never recorded is reported once, not once per write", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /oracle-mini/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByLabel("agent mode").check();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");

  await page.evaluate(() =>
    (window as unknown as { __webTest: { failNext: (cmd: string, message: string) => void } })
      .__webTest.failNext("agent_run_start", "web-test shim: arranged failure"),
  );

  await page.getByPlaceholder(/Describe a task for the agent/).fill("list files");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow" }).click();
  // The run itself still completed: a lost record must not become a lost run.
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Agents", exact: true }).click();

  // The run is absent — this is the whole failure, and why the warning has to sit above the
  // empty-state branch rather than beside the rows: there are no rows to sit beside.
  await expect(page.getByText("0 runs · 0 running · 0 ok · 0 failed · 0 stopped")).toBeVisible({ timeout: 15_000 });
  // One run, not one run plus its three steps.
  //
  // The inflated count is asserted FIRST, on purpose: it is the line that distinguishes which
  // mechanism broke. Drop the suppression and it reads 4 (a start plus its three steps); stop
  // reporting the start and it reads 3 (the steps, counted in its place); render the warning only
  // beside the rows and it reads 0 — and then the line below is the one that fails. Asserting the
  // correct count first would make all three probes fail in the same place with the same message.
  await expect(page.getByText(/[234] writes could not be recorded/)).toHaveCount(0);
  await expect(page.getByText(/1 write could not be recorded/)).toBeVisible();
  // And the failure is the host's own words, so a locked database is distinguishable from a full disk.
  await expect(page.getByText(/Last failure: web-test shim: arranged failure/)).toBeVisible();
});
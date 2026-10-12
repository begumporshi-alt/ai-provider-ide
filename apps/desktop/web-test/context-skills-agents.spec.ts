/**
 * web-test/context-skills-agents.spec.ts — the P4/P5/P6 screens, rendered and driven.
 *
 * Everything in this file exists to answer one question that a type-check cannot: do the Context,
 * Skills and Agents screens actually come up, and do they show what their host-side modules
 * recorded. They had never been rendered before this file existed.
 *
 * The app is the genuine one (see shim.ts); only the Rust host is stood in for, and it mirrors
 * context.rs / skills.rs / orchestrator.rs including their rejection rules.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

/**
 * The shipped builtin catalog, which the shim mirrors from `skills.rs`. Named rather than written
 * into the assertions so that adding an entry to the catalog is one edit here instead of a hunt
 * through the count strings — the catalog is expected to grow.
 */
const BUILTINS = 13;
const BUILTIN_SLUGS = [
  "byte-slice-panic",
  "code-review",
  "commit-message",
  "error-notes",
  "explain-code",
  "fix-to-skill",
  "grill-plan",
  "lean-reading",
  "protocol-leak-triage",
  "screen-design-brief",
  "subagent-dispatch",
  "test-writer",
  "verify-before-done",
];

/**
 * Seed through the host, for state the UI has no way to produce on its own — an agent run needs
 * a real model round-trip, and there is no reason to spend one to verify a table renders.
 */
async function seedAgentRun(
  page: Page,
  id: string,
  steps: { kind: string; label: string; ok?: boolean | null }[],
  status = "ok",
  prompt = "wire the screens",
): Promise<void> {
  await page.evaluate(
    async ({ id, steps, status, prompt }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const host = (window as any).__webTest;
      await host.invoke("agent_run_start", { id, session_id: null, model: "mock/oracle-1", prompt });
      for (const s of steps) {
        await host.invoke("agent_step_append", {
          run_id: id, kind: s.kind, label: s.label, detail: null, ok: s.ok ?? null,
        });
      }
      await host.invoke("agent_run_finish", { run_id: id, status, iterations: 1, error: null });
    },
    { id, steps, status, prompt },
  );
}

test("skills: revoke a builtin, then reinstall it from the catalog", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();

  // The builtin catalog seeds on first read, and the footer counts what is in play.
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible({ timeout: 15_000 });

  // Delete one. It asks first — a delete with no confirmation is a click away from losing the
  // operator's own writing — so the row's trash opens a dialog and the dialog does the work.
  const row = page.getByTestId("skill-row").filter({ hasText: "Code review" });
  await row.getByLabel("Delete Code review").click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText(`${BUILTINS - 1} skills · ${BUILTINS - 1} enabled`)).toBeVisible();

  // A deleted builtin is not gone for good — the catalog is how it comes back.
  await expect(page.getByText("Code review", { exact: true })).toHaveCount(1); // the Available row only
  await page.getByLabel("Install Code review").click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible();

  // The catalog is back to whole, and re-reading the list neither duplicated nor resurrected
  // anything: the shim seeds per slug and records what it placed.
  const slugs = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((window as any).__webTest.store.skills() as { slug: string }[]).map((s) => s.slug).sort(),
  );
  expect(slugs).toEqual(BUILTIN_SLUGS);
});

test("skills: a pasted SKILL.md is parsed before it is installed", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible({ timeout: 15_000 });

  // The composer lives behind the toolbar's New button, the way the reference screen keeps its
  // list and its editor separate instead of stacking a textarea under the rows.
  await page.getByRole("button", { name: "New skill" }).click();

  const box = page.getByPlaceholder(/name: My Skill/);
  await box.fill("---\nname: Release Notes\ndescription: summarise a release\n---\n1. Read the tags.\n2. Summarise.\n");
  await box.blur();

  // The preview is the point: instructions are shown, never installed unseen.
  // `exact` because the textarea above holds the same string.
  await expect(page.getByText("Release Notes", { exact: true })).toBeVisible();
  await expect(page.getByText(/characters of instructions/)).toBeVisible();

  await page.getByRole("button", { name: "install skill" }).click();
  await expect(page.getByText(`${BUILTINS + 1} skills · ${BUILTINS + 1} enabled`)).toBeVisible();
});

test("skills: search and the status filter narrow the panel, and the switch drives the filter", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  const panel = page.getByTestId("skills-installed");
  const footer = page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`);
  await expect(footer).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId("skill-row")).toHaveCount(BUILTINS);

  // Search narrows the panel and leaves the footer alone: the footer is a statement about the
  // whole installed set, so a filter must not move it.
  await page.getByLabel("Search skills").fill("lean reading");
  await expect(panel.getByTestId("skill-row")).toHaveCount(1);
  await expect(panel.getByText("Lean reading")).toBeVisible();
  await expect(footer).toBeVisible();

  await page.getByLabel("Search skills").fill("zzz-nothing-matches");
  await expect(page.getByText("No skills found").first()).toBeVisible();
  await page.getByLabel("Search skills").fill("");

  // Every seeded builtin is enabled, so a Disabled filter finds nothing until a switch is flipped.
  await page.getByLabel("Status filter").selectOption("Disabled");
  await expect(panel.getByTestId("skill-row")).toHaveCount(0);
  await page.getByLabel("Status filter").selectOption("Enabled");
  await expect(panel.getByTestId("skill-row")).toHaveCount(BUILTINS);

  // The switch is what that filter is asking about.
  await page.getByLabel("Status filter").selectOption("all");
  await panel.getByLabel("Disable Lean reading").click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS - 1} enabled`)).toBeVisible();
  await page.getByLabel("Status filter").selectOption("Disabled");
  await expect(panel.getByTestId("skill-row")).toHaveCount(1);
});

test("skills: the delete dialog can be declined, and it says what the delete costs", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("skill-row").filter({ hasText: "Lean reading" }).getByLabel("Delete Lean reading").click();
  const dialog = page.getByRole("dialog", { name: "Delete skill" });
  await expect(dialog).toBeVisible();
  // The consequence is stated per source, because it differs: a builtin is recoverable, the
  // operator's own skill is not.
  await expect(dialog.getByText(/stays in the catalog and can be installed again/)).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible();
  await expect(page.getByTestId("skills-installed").getByTestId("skill-row")).toHaveCount(BUILTINS);
});

test("context: conversation mode draws what the skills screen recorded", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible({ timeout: 15_000 });

  // Reinstalling a deleted builtin is a context event, so it lands in the graph.
  const row = page.getByTestId("skill-row").filter({ hasText: "Commit message" });
  await row.getByLabel("Delete Commit message").click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText(`${BUILTINS - 1} skills · ${BUILTINS - 1} enabled`)).toBeVisible();
  await page.getByLabel("Install Commit message").click();
  await expect(page.getByText(`${BUILTINS} skills · ${BUILTINS} enabled`)).toBeVisible();

  await page.getByRole("button", { name: "Context", exact: true }).click();
  // One recorded skill node, and a canvas rather than the empty state.
  await expect(page.getByText("1 nodes · 0 edges")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("canvas")).toBeVisible();

  // Routing mode is derived, not persisted: it comes up from the seeded providers.
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await expect(page.getByText(/\d+ nodes · \d+ edges/)).toBeVisible();
  const routing = await page.getByText(/\d+ nodes · \d+ edges/).innerText();
  expect(Number(routing.match(/(\d+) nodes/)?.[1] ?? 0)).toBeGreaterThan(0);

  // Live flow has no requests yet in this scenario — the empty state, not a blank canvas.
  await page.getByRole("button", { name: "Live flow", exact: true }).click();
  await expect(page.getByText(/No requests yet/)).toBeVisible();
});

test("agents: a seeded run is listed and its steps are inspectable", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText(/No agent runs yet/)).toBeVisible({ timeout: 15_000 });

  await seedAgentRun(page, "run-1", [
    { kind: "tool_call", label: "list_dir" },
    { kind: "tool_result", label: "list_dir", ok: true },
    { kind: "done", label: "finished" },
  ]);
  await seedAgentRun(
    page,
    "run-2",
    [{ kind: "tool_call", label: "run_command" }],
    "running",
    "a second run, still going",
  );

  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  await expect(page.getByText("2 runs · 1 running · 1 ok · 0 failed · 0 stopped")).toBeVisible();
  await expect(page.getByText("wire the screens")).toBeVisible();

  // Select the finished run: its steps come back in order, with the tool call counted.
  await page.getByText("wire the screens").click();
  await expect(page.getByText("3 steps")).toBeVisible();
  for (const label of ["tool_call", "tool_result", "done"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // A run left running by another session has no controller here, so no stop button is offered.
  // Scoped to the table: the footer names "no handle" too, when it explains what that state means,
  // so an unscoped `getByText` would pass off the legend.
  await expect(page.locator("tbody").getByText("no handle")).toBeVisible();
  await expect(page.getByRole("button", { name: "stop" })).toHaveCount(0);
});

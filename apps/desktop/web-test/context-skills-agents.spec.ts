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

  // The four builtins seed once, on first read.
  await expect(page.getByText("4 installed · 4 active")).toBeVisible({ timeout: 15_000 });

  // Revoke one. `.last()` because every ancestor div also matches the filter.
  const row = page.locator("div.rounded.border").filter({ hasText: "Code review" }).last();
  await row.getByText("revoke").click();
  await expect(page.getByText("3 installed · 3 active")).toBeVisible();

  // A revoked builtin is not gone for good — the catalog is how it comes back.
  await expect(page.getByText("Code review", { exact: true })).toHaveCount(1); // catalog entry only
  await page.getByRole("button", { name: "install", exact: true }).click();
  await expect(page.getByText("4 installed · 4 active")).toBeVisible();

  // And it stays revoked if we merely re-read: seeding happens once, not on every list.
  const slugs = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((window as any).__webTest.store.skills() as { slug: string }[]).map((s) => s.slug).sort(),
  );
  expect(slugs).toEqual(["code-review", "commit-message", "explain-code", "test-writer"]);
});

test("skills: a pasted SKILL.md is parsed before it is installed", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByText("4 installed · 4 active")).toBeVisible({ timeout: 15_000 });

  const box = page.getByPlaceholder(/name: My Skill/);
  await box.fill("---\nname: Release Notes\ndescription: summarise a release\n---\n1. Read the tags.\n2. Summarise.\n");
  await box.blur();

  // The preview is the point: instructions are shown, never installed unseen.
  // `exact` because the textarea above holds the same string.
  await expect(page.getByText("Release Notes", { exact: true })).toBeVisible();
  await expect(page.getByText(/characters of instructions/)).toBeVisible();

  await page.getByRole("button", { name: "install skill" }).click();
  await expect(page.getByText("5 installed · 5 active")).toBeVisible();
});

test("context: conversation mode draws what the skills screen recorded", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByText("4 installed · 4 active")).toBeVisible({ timeout: 15_000 });

  // Reinstalling a revoked builtin is a context event, so it lands in the graph.
  const row = page.locator("div.rounded.border").filter({ hasText: "Commit message" }).last();
  await row.getByText("revoke").click();
  await expect(page.getByText("3 installed · 3 active")).toBeVisible();
  await page.getByRole("button", { name: "install", exact: true }).click();
  await expect(page.getByText("4 installed · 4 active")).toBeVisible();

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

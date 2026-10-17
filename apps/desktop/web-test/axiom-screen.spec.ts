/**
 * web-test/axiom-screen.spec.ts — the AXIOM dashboard shell.
 *
 * The engine behind the screen is proven in packages/axiom-core; what this spec proves is the
 * shell's honesty. The seven stages render as the pipeline's real shape, and the metric cards show
 * a dash when nothing has been measured — a card that displayed 72% on a fresh install would be
 * exactly the lie AXIOM exists to catch, so the empty state is asserted as firmly as the filled one.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

test("axiom shell: seven stages, and no invented number before anything has run", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();

  const stepper = page.getByTestId("axiom-stepper");
  await expect(stepper).toBeVisible();
  for (const name of ["Observe", "Evaluate", "Diagnose", "Design", "Modify", "Validate", "Evolve"]) {
    await expect(stepper).toContainText(name);
  }
  // Nothing has run: each stage names what it would do, and the measured cards are dashes.
  await expect(stepper).toContainText("read the recorded runs");
  await expect(page.getByTestId("axiom-metric-pass")).toContainText("—");
  await expect(page.getByTestId("axiom-metric-pass")).toContainText("no measurement yet");
  await expect(page.getByTestId("axiom-metric-tokens")).toContainText("—");
  await expect(page.getByTestId("axiom-metric-findings")).toContainText("no detector has fired");
  await expect(page.getByTestId("axiom-active-version")).toContainText("built-in configuration");
  await expect(page.getByTestId("axiom-metric-versions")).toContainText("0");
  // The rail is honest in the same direction: an empty store gets an empty feed and the first-run
  // suggestion, not a decorated activity list.
  await expect(page.getByTestId("axiom-activity")).toContainText("Nothing recorded yet");
  await expect(page.getByTestId("axiom-next-step")).toContainText("Run the first audit");
  // The onboarding is on the screen: the four-step workflow, and the plan and radar panels in
  // their honest empty state rather than pre-filled with anything.
  await expect(page.getByTestId("axiom-how-to")).toContainText("Pick a model");
  await expect(page.getByTestId("axiom-how-to")).toContainText("Promote the candidate");
  await expect(page.getByTestId("axiom-plan")).toContainText("Run an audit");
  await expect(page.getByTestId("axiom-health")).toContainText("radar draws");
});

test("axiom shell: stored rows become the cards' real numbers", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    const now = Date.now();
    await h.invoke("axiom_version_put", {
      version: {
        id: "v-seed-active",
        parentId: null,
        createdAt: now,
        state: "active",
        decisionId: null,
        reason: "seeded for the shell spec",
        targetsFindingIds: [],
        evidence: [],
        config: { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } },
      },
    });
    await h.invoke("axiom_suite_result_put", {
      result: {
        id: "sr-seed",
        suiteId: "suite-seed",
        versionId: "v-seed-active",
        model: "mock-model",
        startedAt: now - 60_000,
        endedAt: now,
        repeats: 2,
        tasks: [],
        attemptSummaries: [],
        passRate: 0.5,
        cost: { promptTokens: 300, completionTokens: 100 },
      },
    });
    await h.invoke("axiom_findings_put", {
      findings: [
        {
          id: "f-seed",
          detector: "premature-success",
          title: "Said done with no check behind it",
          severity: "major",
          rootCause: "prompt",
          rationale: "seeded for the shell spec",
          differential: false,
          evidence: [],
          occurrences: 1,
          metric: null,
        },
        {
          id: "f-seed-2",
          detector: "tool-loop",
          title: "Read the same file three times",
          severity: "minor",
          rootCause: "orchestration",
          rationale: "seeded for the shell spec",
          differential: false,
          evidence: [],
          occurrences: 2,
          metric: null,
        },
      ],
    });
  });

  // The screen reads on mount, so the seeded rows appear on the next mount.
  await page.getByRole("button", { name: "Model Browser", exact: true }).click();
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();

  await expect(page.getByTestId("axiom-active-version")).toContainText("v-seed-active");
  await expect(page.getByTestId("axiom-metric-pass")).toContainText("50%");
  await expect(page.getByTestId("axiom-metric-pass")).toContainText("last measured");
  await expect(page.getByTestId("axiom-metric-findings")).toContainText("1");
  await expect(page.getByTestId("axiom-metric-findings")).toContainText("1 major or worse");
  await expect(page.getByTestId("axiom-metric-versions")).toContainText("1");
  // Zero attempts in the stored summary, so the per-attempt card refuses to divide and says so.
  await expect(page.getByTestId("axiom-metric-tokens")).toContainText("—");
  // The same rows, read as a timeline: the finding and the version are the two things that happened.
  await expect(page.getByTestId("axiom-activity")).toContainText("Finding recorded");
  await expect(page.getByTestId("axiom-activity")).toContainText("Version active");
  // Findings with no audit behind them make the suggestion concrete: measure a fix.
  await expect(page.getByTestId("axiom-next-step")).toContainText("2 finding(s) recorded");
});

test("axiom shell: a stored rejection drives the rail's next step", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    const now = Date.now();
    await h.invoke("axiom_version_put", {
      version: {
        id: "v-seed-cand",
        parentId: null,
        createdAt: now - 30_000,
        state: "rejected",
        decisionId: "d-seed",
        reason: "broke the shell capability",
        targetsFindingIds: [],
        evidence: [],
        config: { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } },
      },
    });
    await h.invoke("axiom_decision_put", {
      decision: {
        id: "d-seed",
        candidateId: "v-seed-cand",
        baselineId: "builtin",
        model: "mock-model",
        decidedAt: now,
        decision: "reject",
        checks: [],
        roles: [],
        deltas: [],
      },
    });
  });

  await page.getByRole("button", { name: "Model Browser", exact: true }).click();
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();

  await expect(page.getByTestId("axiom-activity")).toContainText("Candidate rejected");
  await expect(page.getByTestId("axiom-activity")).toContainText("v-seed-cand over builtin");
  await expect(page.getByTestId("axiom-next-step")).toContainText("was rejected — read the refusal");
});

test("axiom quick actions: a waiting candidate is promotable from the rail", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    await h.invoke("axiom_version_put", {
      version: {
        id: "v-waiting",
        parentId: null,
        createdAt: Date.now(),
        state: "candidate",
        decisionId: null,
        reason: "seeded as a candidate",
        targetsFindingIds: [],
        evidence: [],
        config: { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } },
      },
    });
  });

  await page.getByRole("button", { name: "Model Browser", exact: true }).click();
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();

  // The rail only offers what the state supports, and the buttons are entry points to the same
  // handlers — promoting from here is promoting, not a parallel code path.
  await expect(page.getByTestId("axiom-quick-actions")).toContainText("Promote candidate");
  await page.getByRole("button", { name: "Promote candidate" }).click();
  await expect(page.getByTestId("axiom-active-version")).toContainText("v-waiting");
  await expect(page.getByTestId("axiom-quick-actions").getByRole("button", { name: "Promote candidate" })).toHaveCount(0);
  // Roll back appears once a version chain exists; the suite editor opens the same modal.
  await expect(page.getByTestId("axiom-quick-actions")).toContainText("Roll back");
  await page.getByTestId("axiom-quick-actions").getByRole("button", { name: "Edit the task suite" }).click();
  await expect(page.getByRole("heading", { name: "Task suite" })).toBeVisible();
});

test("axiom end to end: a real audit fills the stepper with what actually happened", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();

  // The mock provider's model — a local script, so this run spends nothing. The loop it feeds is
  // the real one, which is the point: the stepper below fills from a report the pipeline produced,
  // not from a fixture.
  const select = page.getByLabel("Model to evaluate");
  await select.selectOption({ index: 1 });
  await page.getByLabel("Repeats per task").fill("1");

  await page.getByRole("button", { name: "Audit & improve" }).click();
  // Consent is the one gate that must not be bypassed by a test either — answer it as a user would.
  await expect(page.getByText("This run spends money")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Allow these calls" }).click();

  // The report arrived: the pass-rate card holds a percentage, and the observe stage names a real
  // count. What the pass rate *is* is the suite's business (the mock answers loosely, and a 0% is
  // as real as a 90%), not the shell's — the shell's contract is that the numbers are real, not
  // that they are good.
  await expect(page.getByTestId("axiom-metric-pass")).toContainText(/\d+%/, { timeout: 180_000 });
  await expect(page.getByTestId("axiom-stepper")).toContainText("run(s) read");
  await expect(page.getByTestId("axiom-stepper")).toContainText(/pass · /);
  // The eval runs went through the orchestrator, so the activity feed gains them too.
  await expect(page.getByTestId("axiom-activity")).toContainText(/Agent run/);
  // The suggestion moved off "Run the first audit" — there is now a measurement behind the screen.
  await expect(page.getByTestId("axiom-next-step")).not.toContainText("Run the first audit");
  // The report's proposals and capability map have somewhere real to land: the plan table and the
  // health panel exist and hold report-backed content (which of the two depends on how many
  // capabilities the run produced — the shell's contract is that both render from the report).
  await expect(page.getByTestId("axiom-plan")).toBeVisible();
  await expect(page.getByTestId("axiom-plan")).not.toContainText("Run an audit");
  await expect(page.getByTestId("axiom-health")).toBeVisible();
});

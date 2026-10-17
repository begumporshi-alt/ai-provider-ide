/**
 * Stage 02 — **Evaluate**, part one: what a task suite is.
 *
 * The suite is the independent measure, and "independent" is doing work here. Every expectation is
 * checked against the *transcript* — the tools that were called, the status the run ended in, the
 * text that was actually produced — and never against the agent's own account of what it did. A
 * suite that asked the agent whether it succeeded would be the defect the spec forbids:
 *
 * > AXIOM must not mark an agent as improved merely because the agent says it has improved.
 *
 * Parsing is strict and loud. Unknown keys are errors rather than ignored, a pattern that does not
 * compile is an error rather than a task that can never pass, and an empty suite is an error rather
 * than a 100% pass rate — the three ways a typo in a suite file otherwise turns into a confident
 * wrong number.
 */
import { z } from "zod";
import type { EvalSuite } from "./types";

const expectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status-equals"), status: z.enum(["running", "ok", "error", "stopped"]) }).strict(),
  z.object({ kind: z.literal("final-text-matches"), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("tool-was-called"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("tool-not-called"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("no-tool-loop") }).strict(),
  z.object({ kind: z.literal("verified-done") }).strict(),
]);

const budgetSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict();

const taskSchema = z
  .object({
    id: z.string().min(1),
    capability: z.string().min(1),
    prompt: z.string().min(1),
    expect: z.array(expectationSchema).min(1),
    budget: budgetSchema.optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const suiteSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    tasks: z.array(taskSchema).min(1),
  })
  .strict();

/**
 * Render a path as `tasks[2].expect[0].pattern`. Zod hands back `["tasks", 2, ...]`, which joined
 * with dots reads as `tasks.2` — the index then looks like a key, and in a nested suite the reader
 * cannot tell an array position from a name. Bracketing the numbers is what makes the two readable.
 */
function formatPath(parts: readonly (string | number)[]): string {
  if (parts.length === 0) return "(root)";
  return parts
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join("");
}

export interface SuiteParseFailure {
  /** e.g. `tasks[2].expect[0].pattern`. */
  path: string;
  message: string;
}

export type SuiteParseResult = { ok: true; suite: EvalSuite } | { ok: false; errors: SuiteParseFailure[] };

/**
 * Validate a suite. Returns every problem at once rather than the first: a suite is authored by
 * hand, and fixing one typo per run is how a suite never gets finished.
 *
 * Beyond the shape, two things are checked that a schema cannot express — duplicate ids (which
 * would silently merge two tasks in every result table keyed by id) and patterns that do not
 * compile (which would throw on the first attempt, mid-evaluation, after the money was spent).
 */
export function parseSuite(json: unknown): SuiteParseResult {
  const parsed = suiteSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        message: i.message,
      })),
    };
  }

  const errors: SuiteParseFailure[] = [];
  const suite = parsed.data;

  const seenTask = new Set<string>();
  suite.tasks.forEach((t, ti) => {
    if (seenTask.has(t.id)) {
      errors.push({ path: formatPath(["tasks", ti, "id"]), message: `duplicate task id "${t.id}"` });
    }
    seenTask.add(t.id);
    t.expect.forEach((e, i) => {
      if (e.kind !== "final-text-matches") return;
      try {
        new RegExp(e.pattern);
      } catch (err) {
        errors.push({
          path: formatPath(["tasks", ti, "expect", i, "pattern"]),
          message: `does not compile: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  // The assignment is the check that the zod shape and the declared domain type still agree; if
  // they drift, this line fails to compile rather than the suite failing at runtime.
  const out: EvalSuite = suite;
  return { ok: true, suite: out };
}

/** Describe an expectation in the words a user reads on the screen. */
export function describeExpectation(e: EvalSuite["tasks"][number]["expect"][number]): string {
  switch (e.kind) {
    case "status-equals":
      return `the run ends '${e.status}'`;
    case "final-text-matches":
      return `the final answer matches /${e.pattern}/`;
    case "tool-was-called":
      return `${e.name} was called`;
    case "tool-not-called":
      return `${e.name} was never called`;
    case "no-tool-loop":
      return "no call was repeated identically in a row";
    case "verified-done":
      return "any claim of completion was preceded by a check that could have disproved it";
  }
}

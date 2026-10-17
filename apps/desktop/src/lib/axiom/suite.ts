/**
 * The suite AXIOM ships with.
 *
 * It is a **string** rather than an object literal, for a reason that is easy to miss: the screen puts
 * this text in an editor and parses it with the same strict `parseSuite` a user-authored file goes
 * through. Shipping the object directly would mean the default suite is the one suite in the app that
 * never met the parser — a typo in it would surface as a runtime shape error instead of a listed
 * problem, and the first thing a new user does is run the default.
 *
 * Four tasks, and the choice of four is not arbitrary. Each one exists to make a different detector
 * able to fire, and the last one exists to make a *fix* able to fail:
 *
 * | task | what it measures |
 * |---|---|
 * | `verify-before-claiming` | whether the agent produces evidence before claiming success (`premature-success`, `verification-absent`) |
 * | `shell-and-report` | whether it can drive the shell at all, without looping (`tool-loop`) |
 * | `search-not-shell` | whether it picks the dedicated tool over a shell workaround (`wrong-tool`) |
 * | `answer-without-tools` | whether it leaves a trivial question alone — the **control** |
 *
 * The control is the one that matters most. A prompt patch telling the agent to verify everything
 * would raise the first task's numbers and break this one, and a regression guardian with no control
 * task has nothing to notice. `verify-before-claiming` asks for `make check` specifically because
 * that is what the loop's own `isVerificationCall` counts as verification — a `grep` would prove the
 * file's contents to a reader and nothing to the metric.
 */
import { parseSuite, type EvalSuite } from "@aiprovider/axiom-core";

export const DEFAULT_SUITE_JSON = `{
  "id": "assistant-default",
  "name": "Assistant default suite",
  "tasks": [
    {
      "id": "verify-before-claiming",
      "capability": "verification",
      "prompt": "In your workspace: (1) create hello.txt containing exactly one line, 'hello axiom'; (2) create a Makefile with a target named check that fails unless hello.txt contains that line; (3) run 'make check' and report its output verbatim.",
      "expect": [
        { "kind": "status-equals", "status": "ok" },
        { "kind": "tool-was-called", "name": "write_file" },
        { "kind": "tool-was-called", "name": "run_command" },
        { "kind": "verified-done" }
      ],
      "budget": { "maxIterations": 10 }
    },
    {
      "id": "shell-and-report",
      "capability": "shell",
      "prompt": "List every entry in your workspace root with a shell command, then state how many you saw.",
      "expect": [
        { "kind": "status-equals", "status": "ok" },
        { "kind": "tool-was-called", "name": "run_command" },
        { "kind": "no-tool-loop" }
      ],
      "budget": { "maxIterations": 6 }
    },
    {
      "id": "search-not-shell",
      "capability": "search",
      "prompt": "Use the dedicated search tool to find every file in your workspace that contains the literal string 'axiom', and list them.",
      "expect": [
        { "kind": "status-equals", "status": "ok" },
        { "kind": "tool-was-called", "name": "search_files" },
        { "kind": "tool-not-called", "name": "run_command" },
        { "kind": "no-tool-loop" }
      ],
      "budget": { "maxIterations": 6 }
    },
    {
      "id": "answer-without-tools",
      "capability": "restraint",
      "prompt": "What is 17 multiplied by 23? Reply with the number only. Do not use any tools.",
      "expect": [
        { "kind": "status-equals", "status": "ok" },
        { "kind": "tool-not-called", "name": "run_command" },
        { "kind": "final-text-matches", "pattern": "391" }
      ],
      "budget": { "maxIterations": 3 }
    }
  ]
}
`;

/**
 * The default suite, parsed at module load.
 *
 * The non-null assertion is the one in this file, and it is checked by `suite.test.ts` rather than
 * trusted: a default that did not parse would throw here, at import, in every screen that renders —
 * which is a worse failure than the assertion looks like, and the test is what makes it a loud one
 * instead of a mysterious one.
 */
export const DEFAULT_SUITE: EvalSuite = (() => {
  const parsed = parseSuite(JSON.parse(DEFAULT_SUITE_JSON));
  if (!parsed.ok) throw new Error(`the shipped default suite does not parse: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return parsed.suite;
})();

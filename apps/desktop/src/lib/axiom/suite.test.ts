/**
 * The shipped default suite, checked against the things it depends on.
 *
 * A suite is a measurement instrument, and an instrument whose probe no longer exists still produces
 * a number — it just measures nothing. Every assertion here is about that class of failure: a tool
 * renamed in the registry, a verification predicate tightened in the loop, a task whose budget was
 * dropped so cost stopped being an axis. All of them fail silently in the results table otherwise.
 */
import { describe, expect, it } from "vitest";
import { describeExpectation, parseSuite } from "@aiprovider/axiom-core";
import { isVerificationCall } from "../tools/agentLoop";
import { AGENT_TOOLS } from "../tools";
import { DEFAULT_SUITE, DEFAULT_SUITE_JSON } from "./suite";

const REGISTRY = new Set(AGENT_TOOLS.map((t) => t.name));

describe("the default suite", () => {
  it("parses through the same strict parser a user-authored suite goes through", () => {
    // Not `DEFAULT_SUITE` directly: the point is that the shipped text meets the parser, and
    // DEFAULT_SUITE is the evidence that it did, not the thing under test.
    const parsed = parseSuite(JSON.parse(DEFAULT_SUITE_JSON));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.suite).toEqual(DEFAULT_SUITE);
  });

  it("names only tools that exist", () => {
    const named: string[] = [];
    for (const task of DEFAULT_SUITE.tasks) {
      for (const e of task.expect) {
        if (e.kind === "tool-was-called" || e.kind === "tool-not-called") named.push(e.name);
      }
    }
    expect(named.length).toBeGreaterThan(0);
    // A `tool-was-called` on a renamed tool is not a failure the agent can avoid: the task becomes
    // unpassable and the pass rate measures the registry's history instead of the agent.
    expect(named.filter((n) => !REGISTRY.has(n))).toEqual([]);
  });

  it("asks for verification the loop will actually count", () => {
    // `verify-before-claiming` asks the agent to run `make check`. If the loop's predicate stopped
    // counting that, the task would fail for a reason no prompt patch could fix, and AXIOM would
    // propose changes against a metric the suite had quietly broken.
    const task = DEFAULT_SUITE.tasks.find((t) => t.id === "verify-before-claiming");
    expect(task?.expect.some((e) => e.kind === "verified-done")).toBe(true);
    expect(isVerificationCall("run_command", { command: "make check" })).toBe(true);
    // And the shape the task must avoid being satisfied by: reading the file back proves the
    // contents to a reader and nothing to the metric.
    expect(isVerificationCall("read_file", { path: "hello.txt" })).toBe(false);
  });

  it("carries a control task that a verify-everything patch would break", () => {
    // Without one, the regression guardian has nothing to notice: every task would improve together
    // and a promotion that made the agent nag on a mental-arithmetic question would look like a win.
    const control = DEFAULT_SUITE.tasks.find((t) => t.id === "answer-without-tools");
    expect(control).toBeDefined();
    expect(control?.expect.some((e) => e.kind === "tool-not-called")).toBe(true);
    expect(control?.capability).toBe("restraint");
  });

  it("budgets every task, so cost stays an axis", () => {
    // A task with no budget can pass at any price, and "the right answer at four times the cost" is
    // one of the failures this suite exists to catch.
    expect(DEFAULT_SUITE.tasks.every((t) => t.budget !== undefined)).toBe(true);
  });

  it("gives every task a capability, and no two tasks share an id", () => {
    expect(DEFAULT_SUITE.tasks.every((t) => t.capability.trim() !== "")).toBe(true);
    const ids = DEFAULT_SUITE.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders every expectation as something a reader can check", () => {
    for (const task of DEFAULT_SUITE.tasks) {
      for (const e of task.expect) {
        expect(describeExpectation(e).length, `${task.id}: ${e.kind}`).toBeGreaterThan(0);
      }
    }
  });
});

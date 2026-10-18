/**
 * The eval runner's stop path, proved.
 *
 * A mid-run Stop makes `runAgentLoop` throw `AbortError`. The runner must treat that as a decision —
 * return the trace as `stopped` — so `evaluateSuite` can keep the attempts that did happen under
 * `aborted`, rather than recording an `error` run and discarding a half-paid suite. The mocks stand
 * in for the three collaborators that need Tauri (the orchestrator, the gateway, the tool host); the
 * loop itself is scripted, because what is under test is the runner's reaction to its outcome, not
 * the loop.
 */
import { describe, expect, it, vi } from "vitest";
import { evaluateSuite, MemoryConfigStore, MemoryResultStore, createClock, type AxiomPorts, type EvalTask, type IdPort } from "@aiprovider/axiom-core";

const runAgentLoop = vi.hoisted(() => vi.fn());
vi.mock("../agent/orchestrator", () => ({
  startRun: vi.fn(),
  endRun: vi.fn(),
  newRunId: vi.fn(() => "run-eval-1"),
  recordStep: vi.fn(),
  registerAbort: vi.fn(),
}));
vi.mock("../gateway-turn", () => ({ gatewayGenerate: vi.fn() }));
vi.mock("../tools", () => ({
  AGENT_TOOLS: [],
  createTauriToolHost: () => ({ run: async () => ({ ok: true, output: "" }) }),
  runAgentLoop: (...args: unknown[]) => runAgentLoop(...args),
}));

import { createEvalRunner } from "./runner";
import { endRun } from "../agent/orchestrator";

const task: EvalTask = {
  id: "t1",
  capability: "c",
  prompt: "do it",
  expect: [{ kind: "status-equals", status: "ok" }],
};
const config = { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } };

describe("createEvalRunner", () => {
  it("a mid-run stop returns a stopped trace instead of recording an error", async () => {
    const runner = createEvalRunner({ root: "/tmp/ws" });
    const ac = new AbortController();
    runAgentLoop.mockImplementationOnce(async () => {
      ac.abort();
      throw new DOMException("Agent loop aborted", "AbortError");
    });

    const trace = await runner.run({ task, model: "m", config, signal: ac.signal });

    expect(trace.status).toBe("stopped");
    expect(trace.error).toBe("stopped");
    expect(vi.mocked(endRun)).toHaveBeenCalledWith("run-eval-1", "stopped", 0, "stopped", 0, 0);
  });

  it("a real failure still records an error run and throws", async () => {
    const runner = createEvalRunner({ root: "/tmp/ws" });
    runAgentLoop.mockImplementationOnce(async () => {
      throw new Error("gateway down");
    });

    await expect(runner.run({ task, model: "m", config })).rejects.toThrow("gateway down");
    expect(vi.mocked(endRun)).toHaveBeenLastCalledWith("run-eval-1", "error", 0, "gateway down", 0, 0);
  });

  it("a mid-run stop keeps the attempts that did happen and stores no result", async () => {
    const runner = createEvalRunner({ root: "/tmp/ws" });
    const results = new MemoryResultStore();
    const ids: IdPort = { next: (p) => `${p}-x-1` };
    const ports: AxiomPorts = {
      traces: { listRuns: async () => [], getRun: async () => null },
      runner,
      configs: new MemoryConfigStore("You are an agent."),
      results,
      ids,
      clock: createClock(),
      // The runner declares `paid: true`, so the gate asks — the test answers yes, because what is
      // under test is the abort path, not consent.
      consent: { request: async () => true },
    };

    const ac = new AbortController();
    runAgentLoop.mockImplementation(async () => {
      ac.abort();
      throw new DOMException("Agent loop aborted", "AbortError");
    });

    const run = await evaluateSuite(ports, {
      suite: { id: "s1", name: "s", tasks: [task] },
      model: "m",
      config,
      versionId: "builtin",
      policy: { claimsCompletion: () => false, isVerificationCall: () => false },
      repeats: 3,
      signal: ac.signal,
    });

    expect(run.aborted).toBe(true);
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]?.trace.status).toBe("stopped");
    expect(await results.listSuiteResults()).toHaveLength(0);
    runAgentLoop.mockRestore();
  });
});

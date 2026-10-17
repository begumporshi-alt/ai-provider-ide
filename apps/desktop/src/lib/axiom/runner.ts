/**
 * AXIOM's agent runner — the `AgentRunnerPort` that runs one eval task through the *real* agent
 * loop, and the reason the numbers on the AXIOM screen mean anything.
 *
 * A runner built from fixtures would be cheaper and would prove nothing: it would measure a model of
 * the agent rather than the agent, and the spec's closing rule is about exactly that gap ("AXIOM must
 * not mark an agent as improved merely because the agent says it has improved"). So this composes the
 * same pieces a send composes — `gatewayGenerate`, `AGENT_TOOLS`, `createTauriToolHost`,
 * `buildAgentSystem`, `runAgentLoop` — and differs from a send in three deliberate ways:
 *
 * 1. **It runs in a scratch directory, not the user's workspace.** Eval tasks are synthetic, so their
 *    side effects should land somewhere disposable. Everything is confined to `<root>/EVAL_DIR_NAME`
 *    by the same Rust path confinement every other tool call goes through, and the directory is made
 *    with the ordinary `mkdir` tool rather than by reaching past it.
 * 2. **It has no confirm gate.** There is nobody to ask — this is the unattended caller. That is
 *    acceptable because of (1) and because the sandbox, not the gate, is what confines a call. It is
 *    also why this runner and not the Assistant's turn is where a version's `loop.maxIterations`
 *    applies: D119's rule is that a step bound is justified only where nobody can press Stop, and an
 *    eval run has nobody at the keyboard. The run is still stoppable, which is why it registers its
 *    controller with the orchestrator and the Runs dashboard can end it.
 * 3. **It declares `paid: true`.** It calls the gateway, so it spends. That is what makes the
 *    pipeline ask for consent with a cost estimate before the first task, per invariant #7.
 *
 * The trace it returns is built from the loop's events with the same kind/label/detail/ok mapping the
 * orchestrator writes to `agent_steps`, in the same call. Keeping the two identical is what lets
 * `improve` reuse a stored baseline and recover its transcripts from the database later: a trace read
 * back has to mean the same thing as the trace that was measured.
 */
import { parsePromptPatches, type AgentConfig, type AgentRunnerPort, type DetectorPolicy, type EvalTask, type RunTrace, type TraceStep } from "@aiprovider/axiom-core";
import { AGENT_TOOLS, createTauriToolHost, runAgentLoop, type AgentEvent } from "../tools";
import { claimsCompletion, isVerificationCall } from "../tools/agentLoop";
import { endRun, newRunId, recordStep, registerAbort, startRun } from "../agent/orchestrator";
import { gatewayGenerate } from "../gateway-turn";
import { buildAgentSystem } from "../chat/turn/prompt";

/** Where eval runs happen, relative to the workspace root the user set. */
export const EVAL_DIR_NAME = ".axiom-eval";

/**
 * The agent loop's own two predicates, handed to the engine rather than restated. `DetectorPolicy`
 * exists so a rule lives in one place: `premature-success` fires on the loop's definition of a
 * completion claim, and a second definition here would drift from the one that actually gates a turn.
 */
export const ASSISTANT_POLICY: DetectorPolicy = { claimsCompletion, isVerificationCall };

export interface EvalRunnerOptions {
  /** The workspace root the Assistant uses; eval runs are confined to `EVAL_DIR_NAME` inside it. */
  root: string;
  /** The session eval runs are recorded under, so the Runs dashboard can tell them apart. */
  sessionId?: string | null;
  /** Every loop event, tagged with the run that produced it, for the screen's progress line. */
  onEvent?: (ev: AgentEvent, runId: string) => void;
}

/** Created once per runner rather than per task: every task writes into the same scratch directory. */
async function ensureEvalDir(root: string): Promise<string> {
  const res = await createTauriToolHost(root).run("mkdir", { path: EVAL_DIR_NAME });
  if (!res.ok) {
    // The host folds a refusal's reason into `output`; there is no separate error field to prefer.
    throw new Error(`could not create ${EVAL_DIR_NAME} inside the workspace root: ${res.output || "refused"}`);
  }
  return `${root.replace(/\/+$/, "")}/${EVAL_DIR_NAME}`;
}

export function createEvalRunner(opts: EvalRunnerOptions): AgentRunnerPort {
  // A promise, not a path, so concurrent tasks wait on one mkdir instead of racing several.
  let evalRoot: Promise<string> | null = null;

  return {
    paid: true,
    async run(req: { task: EvalTask; model: string; config: AgentConfig; signal?: AbortSignal }): Promise<RunTrace> {
      const evalRootPath = await (evalRoot ??= ensureEvalDir(opts.root));
      const startedAt = Date.now();
      const runId = newRunId();
      const steps: TraceStep[] = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let iterations = 0;
      let hitCeiling = false;

      // Its own controller, bridged to the caller's signal: the loop wants a signal, the dashboard
      // wants something it can abort by run id, and `endRun` is what clears the registration.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });

      startRun({ runId, sessionId: opts.sessionId ?? null, model: req.model, prompt: req.task.prompt });
      registerAbort(runId, ac);

      // Recorded and measured in one place, from one event. Two mappings would drift, and the drift
      // would show up as a dashboard row disagreeing with the number that was promoted on.
      const step = (kind: TraceStep["kind"], label: string | null, detail: string | null, ok: boolean | null) => {
        steps.push({ seq: steps.length, kind, label, detail, ok, ts: Date.now() });
        recordStep(runId, kind, label ?? undefined, detail ?? undefined, ok ?? undefined);
      };
      const onEvent = (ev: AgentEvent) => {
        if (ev.type === "tool_call") {
          step("tool_call", ev.call.name ?? "?", ev.call.arguments ?? null, null);
        } else if (ev.type === "tool_result") {
          // `refused` as well as `denied`, for the reason `agent-turn` gives: plan mode refuses a
          // write on its own behalf, and the two read the same to a detector.
          const denied = /denied|refused/i.test(ev.result);
          step(denied ? "denied" : "tool_result", ev.call.name ?? "?", ev.result.slice(0, 500), ev.ok);
        } else if (ev.type === "done") {
          iterations = ev.iterations;
          hitCeiling = ev.hitCeiling === true;
          step(
            "done",
            hitCeiling
              ? `${ev.iterations} iterations — step ceiling, the model was still calling tools`
              : `${ev.iterations} iterations`,
            null,
            !hitCeiling && !ev.truncated,
          );
        }
        opts.onEvent?.(ev, runId);
      };

      try {
        await runAgentLoop({
          model: req.model,
          messages: [{ role: "user", content: req.task.prompt }],
          // The configuration under test, composed the way a send composes it: the version's prompt
          // blocks on top of today's base prompt, never a stored override run verbatim. No skills, no
          // memory, no per-turn text — a measurement has to be of the configuration, and those three
          // change underneath it on every send.
          system: buildAgentSystem({
            root: evalRootPath,
            skillsBlock: "",
            axiomPatches: req.config.promptOverride ? parsePromptPatches(req.config.promptOverride) : [],
          }),
          registry: AGENT_TOOLS,
          generate: (loopReq, loopOpts) =>
            gatewayGenerate(
              {
                ...loopReq,
                onUsage: (u) => {
                  loopReq.onUsage?.(u);
                  promptTokens += u.prompt_tokens ?? 0;
                  completionTokens += u.completion_tokens ?? 0;
                },
              } as Parameters<typeof gatewayGenerate>[0],
              { signal: loopOpts?.signal },
            ),
          host: createTauriToolHost(evalRootPath),
          // No `confirm` — the loop's documented non-interactive mode. See the module doc.
          maxIterations: req.config.loop.maxIterations,
          verificationNudgeMax: req.config.loop.verificationNudgeMax,
          onEvent,
          signal: ac.signal,
        });

        const stopped = ac.signal.aborted;
        const status = stopped ? "stopped" : hitCeiling ? "error" : "ok";
        const error = stopped
          ? "stopped"
          : hitCeiling
            ? `step ceiling: ${iterations} iterations, the model was still calling tools`
            : null;
        endRun(runId, status, iterations, error ?? undefined, promptTokens, completionTokens);
        return {
          id: runId,
          sessionId: opts.sessionId ?? null,
          parentRunId: null,
          model: req.model,
          prompt: req.task.prompt,
          status,
          iterations,
          startedAt,
          endedAt: Date.now(),
          error,
          promptTokens,
          completionTokens,
          steps,
          // Null rather than the version under test: the runner is handed a configuration, not an id,
          // and a trace asserting an id it was never given is the kind of claim this package exists
          // to catch. The `SuiteResult` carries the id, which is where a comparison reads it from.
          versionId: null,
        };
      } catch (e) {
        endRun(runId, "error", iterations, (e as Error).message, promptTokens, completionTokens);
        throw e;
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

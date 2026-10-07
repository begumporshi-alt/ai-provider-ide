/**
 * The agent turn — the tool loop, its run record, checkpoint, graph recording and trace, extracted
 * from the Assistant screen (turn-engine phase 3). One turn, start to finish, against injected
 * ports; emits events, never touches React.
 *
 * The confirm gate is injected (it becomes the TurnController's in phase 4); the loop's per-event
 * paint half stays in the screen — this module owns the recording half, so a run's steps are
 * recorded as they arrive even though the UI is only forwarding them.
 */
import { userContent, textOfContent, type ChatMessage } from "@aiprovider/router-core";
import { runAgentLoop, AGENT_TOOLS } from "../../tools";
import { fetchMcpTools } from "../../tools/mcp-client";
import { RunCheckpoint, createCheckpointingHost } from "../../tools/changeset";
import { buildAgentSystem } from "./prompt";
import { newMsgId, replayHistory } from "./messages";
import { clip, recordAgentTurn } from "./graph-record";
import type { TurnRequestBase } from "./ports";
import type { AgentTurnPorts, FallbackAttempt } from "./ports";

export interface AgentTurnRequest extends TurnRequestBase {
  /** The workspace root; blank refuses the run (the guard is the engine's, not the UI's). */
  root: string;
  customAgentPrompt?: string;
  skillsBlock: string;
  planMode: boolean;
  temperature?: number;
  maxTokens?: number;
  thinking?: string;
  /** The user's step budget, or null for no ceiling — see `AgentLoopOptions.maxIterations`. */
  maxIterations: number | null;
  /**
   * The image-generation port behind `generate_image`, or absent to refuse the tool with a
   * sentence the model can act on. The screen owns it because only it knows the default image
   * model and can resolve provider URLs to bytes.
   */
  generateImage?: Parameters<typeof runAgentLoop>[0]["generateImage"];
  /** The skill port behind `load_skill` — the screen owns the skill store, the engine does not. */
  loadSkill?: Parameters<typeof runAgentLoop>[0]["loadSkill"];
  /** The sub-agent's step budget, from the user's defaults; absent means the loop's built-in. */
  subagentMaxIterations?: Parameters<typeof runAgentLoop>[0]["subagentMaxIterations"];
  /** The live AbortController — registered with the orchestrator so the dashboard can stop the run. */
  controller: AbortController;
  confirm: Parameters<typeof runAgentLoop>[0]["confirm"];
}

export async function runAgentTurn(req: AgentTurnRequest, ports: AgentTurnPorts): Promise<void> {
  if (!req.root.trim()) {
    // Undo the optimistic append: the turn never ran, so it must not sit in the transcript.
    ports.onReplaceTranscript(req.baseMsgs);
    ports.onTrace({ ms: 0, fallbacks: [], error: "set a workspace root before using agent mode" });
    ports.onBusy(false);
    ports.onStopping(false);
    ports.clearAbort();
    return;
  }
  ports.onAgentStart();
  ports.onRunChanges(null);
  // P6: open the run record before the first call, and register the controller so the orchestrator
  // dashboard can stop the run even though it did not start it.
  const runId = ports.orchestrator.newRunId();
  ports.orchestrator.startRun({
    runId,
    sessionId: ports.recorder.sessionId ?? null,
    model: req.model,
    prompt: req.text,
  });
  ports.orchestrator.registerAbort(runId, req.controller);
  // P5: the run's checkpoint. Every write this run makes goes through the wrapping host, which
  // reads the file's previous contents *before* the write — that is what makes both the review
  // diff and "revert this run" show what actually changed rather than what the model claimed.
  const checkpoint = new RunCheckpoint();
  const host = createCheckpointingHost(ports.makeBaseHost(req.root.trim()), checkpoint);
  // The user's node is created here rather than inside recordAgentTurn, because the recall edges
  // need an anchor before the run starts. Same shape as the plain-chat branch: one node per turn,
  // reused by everything that needs to point at it.
  const rec = ports.recorder;
  const userNode = rec.node("message", clip(req.text, 120), { role: "user", model: req.model, text: req.text });
  if (ports.lastNode.current) rec.edge(ports.lastNode.current, userNode, "follows");
  // P7: recall before the run so the agent starts from what is already known. Awaited, because the
  // recalled block has to be in the system prompt before the first call.
  const recalled = req.useMemory ? await ports.memory.recall(req.text) : [];
  if (recalled.length > 0) ports.memory.recordRecall(userNode, recalled);
  // Replay prior turns verbatim — including assistant turns that carry tool_calls and the
  // tool-result turns that answer them — so the model keeps its chaining context.
  const history: ChatMessage[] = [
    ...replayHistory(req.baseMsgs),
    {
      role: "user",
      content: userContent(req.text, req.attachments.map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }))),
    },
  ];
  let iterations = 0;
  // The run's failover chain, gathered per model call by the generate wrapper below — the trace
  // shows every attempt that failed before the answer, not a hardcoded `[]` (2026-10-06).
  const chain: FallbackAttempt[] = [];
  const onEvent: Parameters<typeof runAgentLoop>[0]["onEvent"] = (ev) => {
    // P6: every event is appended to the run record as it arrives, not batched at the end, so a
    // run that is stopped or crashes is still fully inspectable from the dashboard.
    if (ev.type === "tool_call") {
      ports.orchestrator.recordStep(runId, "tool_call", ev.call.name ?? "?", ev.call.arguments ?? undefined);
    } else if (ev.type === "tool_result") {
      // `refused` as well as `denied`: plan mode refuses a write on its own behalf, and the two
      // are the same thing to the reader ("the agent did not run this") while being different
      // things to them ("you said no" / "the mode said no"). Both render as "denied" here and the
      // full sentence is in the recorded step. Without `refused` in this test every plan-mode
      // refusal painted the caller's block as an unexpected failure.
      const denied = /denied|refused/i.test(ev.result);
      ports.orchestrator.recordStep(runId, denied ? "denied" : "tool_result", ev.call.name ?? "?", ev.result.slice(0, 500), ev.ok);
    } else if (ev.type === "done") {
      iterations = ev.iterations;
      ports.orchestrator.recordStep(
        runId,
        "done",
        ev.truncated
          ? `${ev.iterations} iterations — stream truncated`
          : ev.hitCeiling
            ? `${ev.iterations} iterations — step ceiling, the model was still calling tools`
            : ev.iterations
              ? `${ev.iterations} iterations`
              : "done",
        undefined,
        // A truncated turn is not a clean finish, and neither is a ceiling exit: both read as
        // failed so the dashboard's reader asks what actually happened instead of trusting an
        // answer that may be empty.
        !ev.truncated && !ev.hitCeiling,
      );
    } else if (ev.type === "truncation_retry") {
      // Not a recorded step: a re-ask is the loop repairing itself, and it only matters if it
      // fails. The bubble below says it while it happens.
    }
    ports.onAgentEvent(ev);
  };
  try {
    const { text: finalText, messages, hitCeiling } = await runAgentLoop({
      model: req.model,
      messages: history,
      // The per-turn instruction goes last: it is the most specific thing in the prompt, and it is
      // a system message rather than a line in the user's text so the model can tell a constraint
      // the user set from a sentence the user wrote.
      system: buildAgentSystem({ root: req.root, custom: req.customAgentPrompt, skillsBlock: req.skillsBlock, recalledMemory: ports.memory.block(recalled), planMode: req.planMode, perTurn: req.perTurn }),
      // MCP tools join the builtin registry when servers are configured and reachable; failure
      // or no configuration collapses to exactly the builtin set. The fetch is cached briefly
      // Rust-side connections stay live, so the common case is one cheap re-list per turn.
      registry: [...AGENT_TOOLS, ...(await fetchMcpTools())],
      // Tier 2: when this request has to drop context, the dropped turns are summarized rather
      // than discarded (server-side, or the caller's client-side summarizer above the engine).
      generate: (loopReq, opts) => {
        // The loop's generate port is the gateway engine — the same serving path ZCode and Claude
        // Code drive. The loop's own reasoning override — the NO_OUTPUT fallback's forced "off" —
        // is spread after the run-config level on purpose: it must win, or the fallback could not
        // turn thinking off.
        // `undefined` until the call reports usage: a call that reports none must not be charged
        // as a zero-token one (see `chargeSessionUsage`).
        let callIn: number | undefined;
        let callOut: number | undefined;
        const p = ports.generate(
          {
            ...(req.thinking ? { reasoning: req.thinking } : {}),
            ...loopReq,
            ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
            ...(typeof req.maxTokens === "number" ? { maxTokens: req.maxTokens } : {}),
            onUsage: (u) => {
              loopReq.onUsage?.(u);
              ports.onLastUsage(u);
              // Summed, not replaced: an agent turn is several model calls, and the live status
              // line shows what the whole run has spent so far.
              ports.onRunUsageAdded(u.prompt_tokens ?? 0, u.completion_tokens ?? 0);
              callIn = (callIn ?? 0) + (u.prompt_tokens ?? 0);
              callOut = (callOut ?? 0) + (u.completion_tokens ?? 0);
            },
          } as Parameters<AgentTurnPorts["generate"]>[0],
          { signal: opts?.signal },
        );
        return p.then((exec) => ({
          ...exec,
          // Charge the session once per completed model call, not per run: each iteration is its
          // own billed request. The generator's `finally` runs on the loop's `break` too, so a
          // stopped run still charges the usage it already received. Served ids only exist once
          // the stream ends, so pricing happens here rather than in `onUsage`.
          chunks: (async function* () {
            try {
              for await (const chunk of exec.chunks) yield chunk;
            } finally {
              const s = exec.served();
              ports.chargeUsage(callIn, callOut, s?.provider, s?.model);
              if (s?.fallbacks) chain.push(...s.fallbacks);
            }
          })(),
        }));
      },
      host,
      generateImage: req.generateImage,
      loadSkill: req.loadSkill,
      subagentMaxIterations: req.subagentMaxIterations,
      // The delegation ledger: a dispatch_agent child records its row under this run's id, so
      // the Subagents screen can draw the tree.
      runId,
      subagentRecorder: ports.orchestrator,
      // Clamped by the caller: this is the number that actually bounds the spend.
      maxIterations: req.maxIterations,
      confirm: req.confirm,
      onEvent,
      onFinish: ports.onFinishReason,
      signal: req.controller.signal,
    });
    // The loop terminates the moment it sees an answer with no tool calls, but it does NOT append
    // that final assistant turn — `text` is the answer and `messages` is what came before. Append
    // it so the UI and the context graph both see the closing line.
    //
    // **A ceiling exit's closing line is written here, before the replace, and that ordering is the
    // whole fix.** The ceiling exit's last iteration is pure tool_use, so the loop now answers with
    // a summary of the last tool results instead of an empty string — but the user still needs the
    // ⚠ notice with the "raise Steps" guidance, appended to whatever the loop returned (and kept
    // here, in the content, so no message id has to survive the replace). The earlier version of
    // this fix filled the bubble *after* the replace by the optimistic message id; the replace
    // mints fresh ids and the notice vanished: measured 2026-10-06 (run-1791294635622, 40
    // iterations, the step label recorded and the bubble still blank).
    const closedOnCeiling = hitCeiling;
    const closingText = hitCeiling
      ? `${finalText.trim() || "The run stopped without answering."}\n\n⚠ stopped at ${iterations} iterations — the step budget ran out while the model was still ` +
        "calling tools. Raise “Steps” in the run configuration to let it go further."
      : finalText;
    const fullMessages: ChatMessage[] = [...messages, { role: "assistant", content: closingText }];
    ports.onReplaceTranscript(
      fullMessages.map((m) => ({
        id: newMsgId(),
        role: m.role as "user" | "assistant" | "tool",
        // `textOfContent`: the agent loop's transcript includes the user turn we sent, which
        // carries parts when it had images. The transcript stores text; the images stay on the
        // turn that owns them (and the graph records the text, as before).
        content: textOfContent(m.content),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    );
    // Only this turn's messages. `runAgentLoop` seeds its working copy from `history` and returns
    // the whole transcript, so slicing off the replayed prefix is what keeps an earlier turn from
    // being re-recorded — and keeps the graph linear in turns.
    ports.lastNode.current = recordAgentTurn(rec, userNode, fullMessages.slice(history.length), req.model);
    // P7: remember the exchange, then distil it. Distillation is deliberately not awaited —
    // it is an extra model call, and a slow or failing one must not hold up the answer the
    // user is already reading.
    if (req.useMemory) {
      void ports.memory
        .remember(rec.sessionId, req.text, finalText)
        .then(() => ports.memory.distil(rec.sessionId, req.model))
        .catch(() => { /* memory distillation is best-effort */ });
    }
    // An abort mid-stream with no tool calls yet returns from the loop normally (the chunk loop
    // just breaks), so the success path — not only the catch — must distinguish a stopped run.
    // The trace said `✓` for a turn the user had cancelled, same lie the plain-chat path
    // already stopped telling (it marks "stopped by you" in its own trace).
    const stopped = req.controller.signal.aborted;
    // A ceiling exit is not `ok` either. The run did what it was told — it stopped at the budget —
    // but it stopped mid-work with no answer, and a dashboard row that says `ok` for that is the
    // same lie as a blank bubble: the reader has to open the steps to find out nothing finished.
    if (closedOnCeiling) {
      ports.orchestrator.endRun(
        runId,
        stopped ? "stopped" : "error",
        iterations,
        stopped
          ? undefined
          : `step ceiling: ${iterations} iterations, the model was still calling tools`,
      );
    } else {
      // Arity kept at three for the clean paths, as it was: only a run that ended for a reason
      // carries one, which is also how the catch path below already calls it.
      ports.orchestrator.endRun(runId, stopped ? "stopped" : "ok", iterations);
    }
    ports.onTrace({
      ms: ports.now() - req.startedAt,
      fallbacks: chain,
      provider: "agent",
      ...(stopped
        ? { error: "stopped by you" }
        : closedOnCeiling
          ? { error: `stopped at ${iterations} iterations — the step ceiling` }
          : {}),
    });
  } catch (e) {
    // The turn's own bubble, not only the trace line. A failed agent run left an empty
    // assistant turn behind, which rendered as a bare "…" — indistinguishable from a model that
    // had not answered yet — with the only clue a thin red line above the composer.
    if (req.controller.signal.aborted) {
      ports.orchestrator.endRun(runId, "stopped", iterations);
      ports.onTrace({ ms: ports.now() - req.startedAt, fallbacks: [], error: "stopped by you" });
      ports.fillIfEmpty(req.assistantMsgId, "⚠ stopped by you — this turn did not finish. Send again, or retry it from the message actions.");
    } else {
      ports.orchestrator.endRun(runId, "error", iterations, (e as Error).message);
      ports.onTrace({ ms: ports.now() - req.startedAt, fallbacks: [], error: (e as Error).message });
      ports.fillIfEmpty(req.assistantMsgId, `⚠ ${(e as Error).message}`);
    }
  } finally {
    // Flush here, not on the success path only. The user's node — and any recall edges anchored
    // to it — is created before the run starts, so a stopped or failed run would otherwise leave
    // those nodes buffered and silently prepend them to the next turn's batch. Same policy as the
    // plain-chat branch: a partial turn is still a turn.
    void rec.flush();
    ports.clearRunUi();
    ports.onBusy(false);
    ports.onStopping(false);
    ports.clearAbort();
    // P5: publish the change set in `finally`, not on the success path. A run the user stopped or
    // that threw has still written every file it got to before that, and those are exactly the
    // writes someone wants to take back — hiding them because the turn did not finish would make
    // "revert this run" unavailable in the only case it matters most.
    ports.onRunChanges(checkpoint.empty ? null : checkpoint.snapshot());
  }
}

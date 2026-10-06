/**
 * The plain-chat turn — streamed chat with reasoning, memory, graph recording and trace shaping,
 * no tools. Extracted from the Assistant screen (turn-engine phase 2); one turn, start to finish,
 * against injected ports. Emits events; never touches React.
 */
import { buildPlainRequestMessages } from "./prompt";
import { replayHistory } from "./messages";
import { clip } from "./graph-record";
import type { TurnPorts, TurnRequestBase } from "./ports";
import type { ServedBy } from "../../gateway-turn";

/** The model's reasoning paints at most every 80 ms. Time-based rather than count-based: a fixed
 *  "every Nth delta" is wrong at both ends of the range — the measured failure carried **8197**
 *  deltas, where one React render each would stall the window, while a short 20-delta thought
 *  would render its first delta and then nothing until the stream ended, showing an open but
 *  effectively empty panel for the whole turn. A clock interval is right for both. */
export const REASONING_PAINT_MS = 80;

export interface PlainTurnRequest extends TurnRequestBase {
  /** The resolved system prompt: custom, built-in no-tools guard, or `undefined` for none. */
  systemPromptText: string | undefined;
  temperature?: number;
  maxTokens?: number;
  thinking?: string;
}

export async function runPlainTurn(req: PlainTurnRequest, ports: TurnPorts): Promise<void> {
  const rec = ports.recorder;
  const userNode = rec.node("message", clip(req.text, 120), { role: "user", model: req.model, text: req.text });
  if (ports.lastNode.current) rec.edge(ports.lastNode.current, userNode, "follows");
  // P7: recall before answering. Awaited, because the block has to be in the request.
  const recalled = req.useMemory ? await ports.memory.recall(req.text) : [];
  if (recalled.length > 0) ports.memory.recordRecall(userNode, recalled);
  let streamed = "";
  let reasoned = "";
  let lastReasoningPaint = 0;
  // Charged to the session totals in the `finally`, once per turn. No initializer: `onUsage`
  // (a closure TS cannot see run) is what assigns it, and an `= null` start would narrow the
  // `finally` read to `never`. Locals because `served` is only known after the stream ends and
  // the `finally` must see both.
  let turnUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
  let turnServed: ServedBy | undefined;
  try {
    // The same replay the agent path uses. Sharing it is the fix: this path used to map only
    // {role, content}, so a session that had used agent mode sent its tool results with no
    // tool_call_id and the provider answered 400.
    const history = replayHistory(req.baseMsgs);
    // Recalled memory goes in its own system message, never spliced into the user's text:
    // the model must be able to tell the difference between what was just said and what was
    // remembered from an earlier conversation.
    const recallMsg = ports.memory.block(recalled);
    // Served by the gateway engine — the same ingress, admission control, ledger, and failover
    // every external client gets. `AIP-Memory: off` inside the gateway client keeps the webview's
    // own recall (`recalled`) the only memory block.
    const exec = await ports.generate(
      {
        model: req.model,
        messages: buildPlainRequestMessages(req.systemPromptText, recallMsg, req.perTurn, history, {
          content: req.text,
          attachments: req.attachments,
        }),
        onFinish: ports.onFinishReason,
        onReasoning: (t: string) => {
          reasoned += t;
          const now = ports.now();
          if (now - lastReasoningPaint >= REASONING_PAINT_MS) {
            lastReasoningPaint = now;
            ports.patchMsg(req.assistantMsgId, { reasoning: reasoned });
          }
        },
        // P7: per-request params, and the provider's own token report for the meter's tooltip
        // (estimate vs what the request actually cost). The report is also what charges the
        // session totals — captured here, accumulated once per turn in the `finally` below.
        ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
        ...(typeof req.maxTokens === "number" ? { maxTokens: req.maxTokens } : {}),
        // Same three-way: a chosen level travels, `""` sends nothing and leaves the provider's
        // own default in place.
        ...(req.thinking ? { reasoning: req.thinking } : {}),
        onUsage: (u: { prompt_tokens: number; completion_tokens: number }) => {
          turnUsage = u;
          ports.onLastUsage(u);
        },
      },
      { signal: req.signal },
    );
    for await (const chunk of exec.chunks) {
      streamed += chunk;
      ports.patchMsg(req.assistantMsgId, { content: streamed });
      // Scroll is handled by the sticky-follow effect on `msgs` — following per token here would
      // also fight the user when they have scrolled up to read.
    }
    // The tail the throttle above skipped. This is the flush that matters most: the last deltas
    // before a model runs out of output budget are the ones that say what it was doing when it
    // stopped, and dropping them would truncate the reasoning exactly where it got interesting.
    if (reasoned) {
      ports.patchMsg(req.assistantMsgId, { reasoning: reasoned });
    }
    // Attribution rides the wire's optional `served_by` terminal field. The fallback chain is
    // gateway-internal and does not ride yet — the one trace field the old engine showed that
    // this path does not.
    const served = exec.served();
    turnServed = served;
    const assistantNode = rec.node("message", clip(streamed, 120) || "(empty)", {
      role: "assistant",
      model: served?.model ?? req.model,
      provider: served?.provider,
      text: streamed,
    });
    rec.edge(userNode, assistantNode, "follows");
    ports.lastNode.current = assistantNode;
    ports.onTrace({
      ms: ports.now() - req.startedAt,
      provider: served?.provider ? ports.providerName(served.provider) : undefined,
      key: served?.key,
      model: served?.model ?? req.model,
      // The chain the gateway rode to this answer — the same entries the ledger row carries,
      // finally on the wire instead of a hardcoded `[]` (the old engine's one missing field).
      fallbacks: served?.fallbacks ?? [],
      // **A stream the user stopped is not a success**, and this path reaches here without
      // throwing: the engine's loop returns on an aborted signal rather than raising, so the
      // `catch` below never sees it and the trace printed `✓ 680ms` for a cancelled request. That
      // reads as "the model finished early" — the user's own action attributed to the provider.
      // The partial text is still kept (a partial turn is a turn), but the line says who ended it.
      ...(req.signal.aborted ? { error: "stopped by you" } : {}),
    });
  } catch (e) {
    if (req.signal.aborted) {
      ports.onTrace({ ms: ports.now() - req.startedAt, fallbacks: [], error: "stopped by you" });
    } else {
      ports.onTrace({ ms: ports.now() - req.startedAt, fallbacks: [], error: (e as Error).message });
      ports.patchMsg(req.assistantMsgId, { content: streamed || `⚠ ${(e as Error).message}` });
    }
  } finally {
    // Flush even on error or stop: a partial turn is still a turn, and the graph is a record
    // of what happened, not of what succeeded.
    void rec.flush();
    // P7: remember whatever was actually said, including a failed or stopped turn — an
    // exchange the user abandoned is still part of the record. Distillation is not awaited.
    if (req.useMemory) {
      void ports.memory
        .remember(rec.sessionId, req.text, streamed)
        .then(() => ports.memory.distil(rec.sessionId, req.model))
        .catch(() => { /* memory distillation is best-effort */ });
    }
    ports.onBusy(false);
    ports.onStopping(false);
    ports.clearAbort();
    // Charge the session totals from what the turn itself reported. A stream the user stopped
    // usually never reaches the usage chunk, so it adds nothing — honest, since those tokens
    // were mostly never generated, let alone billed.
    if (turnUsage) {
      ports.chargeUsage(turnUsage.prompt_tokens, turnUsage.completion_tokens, turnServed?.provider, turnServed?.model);
    }
  }
}

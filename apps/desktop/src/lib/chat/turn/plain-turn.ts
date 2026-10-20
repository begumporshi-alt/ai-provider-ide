/**
 * The plain-chat turn — streamed chat with reasoning, memory, graph recording and trace shaping,
 * no tools. Extracted from the Assistant screen (turn-engine phase 2); one turn, start to finish,
 * against injected ports. Emits events; never touches React.
 */
import { buildPlainRequestMessages } from "./prompt";
import { replayHistory, recalledLight } from "./messages";
import { clip } from "./graph-record";
import type { TurnPorts, TurnRequestBase } from "./ports";
import { attachmentMeta } from "./ports";
import { retryNoticeLabel, type ServedBy } from "../../gateway-turn";

/** The model's reasoning paints at most every 80 ms. Time-based rather than count-based: a fixed
 *  "every Nth delta" is wrong at both ends of the range — the measured failure carried **8197**
 *  deltas, where one React render each would stall the window, while a short 20-delta thought
 *  would render its first delta and then nothing until the stream ended, showing an open but
 *  effectively empty panel for the whole turn. A clock interval is right for both. */
export const REASONING_PAINT_MS = 80;

/** The answer text paints at most every 50 ms. The same argument as reasoning, with a tighter
 *  clock because this is the text the user is reading: a per-delta render re-parses the whole
 *  accumulated answer and rebuilds the transcript on every token. */
export const CONTENT_PAINT_MS = 50;

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
  if (recalled.length > 0) {
    ports.memory.recordRecall(userNode, recalled);
    // The prompt-side block is invisible to the user — it rides a system message — so the
    // optimistic assistant bubble is where the visible record lands. Attached before the stream
    // starts, so the card is there even while the answer is still streaming in.
    ports.patchMsg(req.assistantMsgId, { recalledMemories: recalledLight(recalled) });
  }
  let streamed = "";
  let reasoned = "";
  /** What the transcript will record for the assistant turn. Tracks the *bubble*, not the stream:
   *  a failed turn shows a `⚠ …` line, and a transcript row that said instead would make the
   *  durable copy disagree with the conversation the user can see. */
  let recordedText = "";
  let lastReasoningPaint = 0;
  let lastContentPaint = 0;
  let lastPaintedContent = "";
  // Charged to the session totals in the `finally`, once per turn. No initializer: `onUsage`
  // (a closure TS cannot see run) is what assigns it, and an `= null` start would narrow the
  // `finally` read to `never`. Locals because `served` is only known after the stream ends and
  // the `finally` must see both.
  let turnUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
  let turnServed: ServedBy | undefined;
  /** The retry line is cleared once the first token arrives, not on every chunk. */
  let retryCleared = false;
  /** Only patch the clear when a retry line was actually painted — otherwise the clear becomes a
   *  spurious final patch on turns that never retried. */
  let retryPainted = false;
  try {
    // The same replay the agent path uses. Sharing it is the fix: this path used to map only
    // {role, content}, so a session that had used agent mode sent its tool results with no
    // tool_call_id and the provider answered 400.
    let history = replayHistory(req.baseMsgs);
    // Automatic compaction. `compressWithSummary` is a no-op (and makes no model call) when the
    // history fits, so this only pays when the request would otherwise overflow the window.
    if (req.compact && req.compactBudget) {
      const compacted = await req.compact(history, req.compactBudget);
      if (compacted.compressed) {
        history = compacted.messages;
        req.onCompacted?.({
          dropped: compacted.dropped,
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
        });
      }
    }
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
        messages: buildPlainRequestMessages(
          req.systemPromptText,
          req.manifestBlock,
          recallMsg,
          req.perTurn,
          history,
          {
            content: req.text,
            attachments: req.attachments,
          },
        ),
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
        // The engine's retry notice: paint `attempt N/M` in the assistant bubble so a 40s wait
        // is visibly progress rather than a frozen screen.
        onRetry: (n) => {
          retryPainted = true;
          ports.patchMsg(req.assistantMsgId, { retryStatus: retryNoticeLabel(n) });
        },
      },
      { signal: req.signal },
    );
    for await (const chunk of exec.chunks) {
      if (retryPainted && !retryCleared) {
        retryCleared = true;
        ports.patchMsg(req.assistantMsgId, { retryStatus: undefined });
      }
      streamed += chunk;
      const now = ports.now();
      if (now - lastContentPaint >= CONTENT_PAINT_MS) {
        lastContentPaint = now;
        lastPaintedContent = streamed;
        ports.patchMsg(req.assistantMsgId, { content: streamed });
      }
      // Scroll is handled by the sticky-follow effect on `msgs` — following per token here would
      // also fight the user when they have scrolled up to read.
    }
    // The tail the throttle above skipped. The final text matters more than any intermediate
    // paint: it is what the transcript records and what the user sees when the stream stops.
    if (streamed) {
      lastPaintedContent = streamed;
      ports.patchMsg(req.assistantMsgId, { content: streamed });
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
    recordedText = streamed;
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
      // A stopped turn keeps whatever it had said — the same partial turn the graph records.
      recordedText = streamed;
    } else {
      ports.onTrace({ ms: ports.now() - req.startedAt, fallbacks: [], error: (e as Error).message });
      recordedText = streamed || `⚠ ${(e as Error).message}`;
      lastPaintedContent = recordedText;
      ports.patchMsg(req.assistantMsgId, { content: recordedText });
    }
  } finally {
    // A retry line must not outlive the turn: success, failure and stop all land here. Only when
    // one was painted, so a turn that never retried leaves its last content patch untouched.
    if (retryPainted && !retryCleared) {
      ports.patchMsg(req.assistantMsgId, { retryStatus: undefined });
    }
    // A stopped or failed stream may have left the last few deltas inside the paint interval.
    // The catch above patches the error text; this makes the successful/aborted tail visible too.
    if (recordedText && recordedText !== lastPaintedContent) {
      ports.patchMsg(req.assistantMsgId, { content: recordedText });
    }
    // Flush even on error or stop: a partial turn is still a turn, and the graph is a record
    // of what happened, not of what succeeded.
    void rec.flush();
    // The durable transcript (0027), written on the same rule as the graph flush above: a failed
    // or stopped turn is still part of the conversation, and the `finally` is the one place both
    // outcomes reach. `recordedText`, not `streamed` — the row must say what the bubble says.
    ports.transcript.append([
      { role: "user", content: req.text, attachments: attachmentMeta(req.attachments) },
      {
        role: "assistant",
        content: recordedText,
        reasoning: reasoned || null,
        model: turnServed?.model ?? req.model,
        // A turn with no recall writes null — the column exists so a resumed session can still
        // show the card, and `null` is what keeps that from costing a JSON parse per old row.
        memoryRefs: recalled.length > 0 ? JSON.stringify(recalledLight(recalled)) : null,
      },
    ]);
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

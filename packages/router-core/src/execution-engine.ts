/**
 * execution-engine (L2): the attempt loop over the route-planner's plan (§3.1). Tries each
 * candidate; on a key-rotation-class error advances to the next key of the same provider;
 * when a provider's keys are exhausted advances to the next provider (failover). No hidden
 * retry loop — the plan IS the retry policy. Enforces the §3.6 budgets (max attempts,
 * backoff honoring Retry-After) and propagates cancellation via AbortSignal.
 */
import { ManifestHttpError } from "./manifest-interpreter.js";
import { describeSilentStream, emptyTally, noteStreamEvent, type StreamTally } from "./stream-shape.js";
import type { AdapterInstance } from "./adapter-instance.js";
import type { Candidate } from "./route-planner.js";
import { classify, classifyFailure, classifyHttp, reasonFromBody, type ErrorClass } from "./errors.js";
import { COOLDOWN_FLOOR_MS, type HealthTracker } from "./health-tracker.js";
import type { ProviderLimiter } from "./concurrency.js";
import type { ToolCall, UsageTokens } from "./ports.js";

export interface AttemptOutcome {
  candidate: Candidate;
  cls: ErrorClass;
  status: number;
  retryAfterMs?: number;
  /**
   * The provider's own words for the refusal, when it gave any (`reasonFromBody` — a 400
   * content-policy block says "content-blocked", not "schema"). Display-only: the class decides
   * behaviour, this decides what the operator reads.
   */
  reason?: string;
}

export interface ExecuteTextArgs {
  plan: Candidate[];
  messages: unknown[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  /** How much the model should think — forwarded untouched to the adapter's render. */
  reasoning?: import("./ports.js").ReasoningEffort;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  /** Real tool calls are reported here, never through `chunks` (see ports.ToolCall). */
  onToolCall?: (call: ToolCall) => void;
  /** Called once with whatever usage the upstream reported; also fills `TextExecution.usage()`. */
  onUsage?: (usage: UsageTokens) => void;
  onFinish?: (reason: string | undefined) => void;
  /**
   * The model's reasoning, as it streams. Forwarded to the adapter unchanged, and accumulated
   * separately so the ledger can tell "the provider sent nothing" from "the provider sent
   * reasoning and never reached its answer" — a distinction that used to be invisible and that
   * cost one turn 46 seconds and an empty bubble.
   */
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
  maxAttempts?: number;
}

export interface TextExecution {
  /**
   * The serving candidate — set once the candidate has delivered *output*, which is a text chunk
   * **or** a tool call, whichever comes first. A turn whose entire output is a tool call yields no
   * chunks at all, so a chunk-only definition of "served" reported a successful tool turn as if no
   * provider had answered.
   */
  served: () => Candidate | undefined;
  fallbackChain: () => AttemptOutcome[];
  chunks: AsyncIterable<string>;
  usage: () => Partial<UsageTokens> | undefined;
  /**
   * What the last attempt's stream actually contained, when it delivered nothing: the count of SSE
   * events seen and a bounded sample of the first. `undefined` for any request that produced output,
   * where the question "what did the provider send?" is answered by the output itself.
   *
   * This is the difference between "the provider streamed nothing" and "the provider streamed a
   * shape the manifest cannot read" — two findings with different owners that one `PARSE_ERROR`
   * label had been conflating, with no evidence to tell them apart.
   */
  observation: () => string | undefined;
  /**
   * The reasoning the last attempt streamed, when it streamed any. Bounded by `MAX_REASONING_CHARS`
   * — this is the engine's own copy, kept so the ledger can say whether reasoning happened at all;
   * a live reader gets every delta through `ExecuteTextArgs.onReasoning`, which is not capped.
   */
  reasoning: () => string | undefined;
  /**
   * The last attempt's finish reason in the OpenAI vocabulary (`"length"` == the output cap was
   * reached). `undefined` when the provider never named one. The engine used to forward this
   * straight to the caller and keep nothing, so a ledger row could not say *why* a stream stopped.
   */
  finishReason: () => string | undefined;
}

/**
 * Cap on the engine's own reasoning buffer. Generous — the measured failure carried 25 k characters
 * — but finite, because a provider that streams unbounded reasoning must not be able to grow the
 * process without limit.
 */
export const MAX_REASONING_CHARS = 200_000;

export const MAX_ATTEMPTS_DEFAULT = 6;

interface AdapterFactory {
  /** Resolve provider -> adapter (adapter-runtime); declarative or sandboxed code (§2.7). */
  forProvider(providerId: string): Promise<{ adapter: AdapterInstance; baseUrl: string }>;
}

export class ExecutionEngine {
  /**
   * `limiter` is optional and opt-in (audit R3): when present, a candidate whose provider is
   * already at its in-flight cap is skipped with a RATE_LIMITED outcome, so the loop advances
   * to another provider instead of queueing behind a degraded one. Absent = legacy behaviour.
   */
  constructor(
    private readonly adapters: AdapterFactory,
    private readonly health: HealthTracker,
    private readonly limiter?: ProviderLimiter,
  ) {}

  async executeText(args: ExecuteTextArgs): Promise<TextExecution> {
    const fallbackChain: AttemptOutcome[] = [];
    const usageBox: { value?: Partial<UsageTokens> } = {};
    let served: Candidate | undefined;

    const maxAttempts = args.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    const attempts = Math.min(args.plan.length, maxAttempts);

    const self = this;
    // What the FINAL attempt's stream carried — see `TextExecution.observation`. Reset per attempt
    // so the evidence always names the candidate the row will blame, and kept as a formatted string
    // (bounded here, at the capture point) rather than a growing buffer: only the sample is ever
    // worth the bytes.
    let observation: string | undefined;
    // The last attempt's reasoning and finish reason, reset with `observation` so all three
    // describe the same candidate the ledger row will blame.
    let reasoning = "";
    let finishReason: string | undefined;
    const SAMPLE_CHARS = 240;
    async function* stream(): AsyncGenerator<string, void, void> {
      for (let i = 0; i < attempts; i++) {
        const c = args.plan[i]!;
        if (args.signal?.aborted) return;
        // R3: skip a saturated provider rather than waiting on it — failover is the better
        // answer than queueing. Consecutive candidates of the same provider are skipped too.
        const release = self.limiter ? self.limiter.acquire(c.provider.id) : null;
        if (self.limiter && !release) {
          fallbackChain.push({ candidate: c, cls: "RATE_LIMITED", status: 429 });
          continue;
        }
        let emitted = false;
        let toolCalls = 0;
        // What this attempt's stream carried, classified as it arrives — see `stream-shape.ts`. A
        // bare counter could say only "events arrived and none of them were text", which is worded
        // identically for a wrong-shape stream and for a model that reasoned and never answered.
        let tally: StreamTally = emptyTally();
        observation = undefined;
        reasoning = "";
        finishReason = undefined;
        // **A tool call is delivered output, so it marks the candidate as `served`.** `served` is
        // what `wrapLedger` tests (`model-router.ts:429`) and what names the provider on the row,
        // and it was being set from `chunks` alone — so a turn whose entire output is a tool call
        // (zero chunks, one `onToolCall`) was filed `PARSE_ERROR` with no provider, while the very
        // same request recorded `health.recordResult(key, "OK")` two lines below. Two records of
        // one request, contradicting each other.
        //
        // **The gate is preserved exactly.** The interpreter only parses tool calls when a callback
        // is present (`manifest-interpreter.ts:335-336`), so the wrapper is built only when the
        // caller passed one — handing down a callback unconditionally would make every provider
        // start emitting tool calls to callers that never asked for them.
        //
        // **`toolCalls` also ends failover.** `emitted` decides whether a mid-stream break can
        // still fail over to the next candidate, and it was chunk-only — so a tool call delivered
        // and then a break failed over, letting the next candidate re-issue the same tool call.
        // The consistent generalisation: a delivered tool call also ends failover, so the wrapper
        // counts it and the predicate below folds it in. `emitted` is still not set here because
        // the two claims ("who answered" vs "can we still retry") are now unified at the predicate
        // rather than conflated in one flag.
        const callerOnToolCall = args.onToolCall;
        const onToolCall = callerOnToolCall
          ? (tc: ToolCall): void => {
              if (!served) served = c;
              toolCalls++;
              callerOnToolCall(tc);
            }
          : undefined;
        try {
          const { adapter } = await self.adapters.forProvider(c.provider.id);
          for await (const chunk of adapter.generateText(
            c.key.secretRef,
            // onUsage does double duty: it fills the box the ledger reads, and it is the only
            // way the caller — the gateway bridge, which forwards it host-side — ever learns the
            // token counts. Dropping the caller's callback here left every gateway response
            // reporting `usage: null` even on requests that had usage.
            { model: c.model.nativeId, messages: args.messages, stream: args.stream, maxTokens: args.maxTokens, temperature: args.temperature, reasoning: args.reasoning, tools: args.tools, toolChoice: args.toolChoice, responseFormat: args.responseFormat, onToolCall, onUsage: lastUsage => { usageBox.value = lastUsage; args.onUsage?.(lastUsage); },
              // See `TextArgs.onStreamEvent`. The sample is truncated here, at the capture point,
              // because only the engine knows how much evidence a row can afford.
              onStreamEvent: payload => noteStreamEvent(tally, payload, SAMPLE_CHARS),
              // Kept beside the forwarded callback: the caller gets the reasoning as it arrives, and
              // the engine keeps its own bounded copy so the ledger row can say whether reasoning
              // was the reason the turn produced no answer.
              onReasoningDelta: t => {
                if (reasoning.length < MAX_REASONING_CHARS) reasoning += t;
                args.onReasoning?.(t);
              },
              onFinish: r => {
                finishReason = r;
                args.onFinish?.(r);
              } },
            args.signal,
          )) {
            if (!emitted) {
              emitted = true;
              served = c;
            }
            yield chunk;
          }
          self.health.recordResult(c.key, "OK");
          // Delivered nothing: this is the arm the ledger's PARSE_ERROR-with-no-evidence rows come
          // from, so keep what the stream actually carried before the success return discards it.
          // Zero events is a finding of its own ("the provider sent nothing at all"), so it is
          // worded rather than left undefined — the same distinction the Rust `describe()` draws.
          if (!emitted && toolCalls === 0) {
            observation = describeSilentStream(tally, finishReason);
            // **The attempt is recorded, because an attempt happened.** The chain held only
            // failures, so a provider that answered 200 and streamed 8197 events while producing
            // nothing left no trace in it — and `Activity` then printed "no attempt recorded —
            // nothing was tried for this model" directly beneath the row proving otherwise. The
            // status is 200 because that is what the provider returned: this is not a failed
            // request, it is a request that was answered and whose answer was not usable.
            //
            // Deliberately NOT a reason to advance to the next candidate. Advancing is a behaviour
            // change (the plan has already run; another provider might answer, and might answer
            // differently on every retry), so it is left to a decision of its own rather than
            // smuggled in with the bookkeeping. `health.recordResult` above still says OK, because
            // the key and the provider did their job.
            fallbackChain.push({ candidate: c, cls: "NO_OUTPUT", status: 200 });
          }
          return; // success
        } catch (e) {
          // Mid-stream errors are drift-class (§2.10), never "OK from status 200"
          // (diff-review M2): a stream that already yielded text CANNOT be transparently
          // retried — the consumer would see duplicated output. Fail loud after first byte.
          // A delivered tool call also ends failover: the consumer holds a tool call the next
          // candidate would re-issue, so the predicate folds the tool-call count in.
          if (emitted || toolCalls > 0) {
            // A body that names its own cause outranks the status: a relay answering 200 with
            // `{"code":"timeout"}` is a timeout, not a shape we failed to read.
            const cls = e instanceof ManifestHttpError
              ? classifyFailure(
                  classify(e.status) === "OK" ? "PARSE_ERROR" : classifyHttp(e.status, e.body),
                  e.body,
                )
              : "NETWORK";
            fallbackChain.push({ candidate: c, cls, status: e instanceof ManifestHttpError ? e.status : 0 });
            throw e;
          }
          // classifyHttp, not classify: with the body in hand a 401 can be recognised as a client
          // gate (`CLIENT_GATE` — the provider refused the caller, not the key) and a 402 as
          // billing rather than a network fault. The mid-stream arm keeps its precedence.
          const cls = e instanceof ManifestHttpError
            ? classifyFailure(
                e.kind === "mid-stream" || classify(e.status) === "OK"
                  ? "PARSE_ERROR"
                  : classifyHttp(e.status, e.body),
                e.body,
              )
            : "NETWORK";
          const outcome: AttemptOutcome = {
            candidate: c,
            cls,
            status: e instanceof ManifestHttpError ? e.status : 0,
            // What the provider asked us to wait. Without this the cooldown falls through to the
            // tracker's 1000ms floor, so a key that asked for a minute is retried a second later —
            // straight back into the window it was told to wait out.
            retryAfterMs: e instanceof ManifestHttpError ? e.retryAfterMs : undefined,
            // The provider's own words for the refusal (e.g. "content-blocked") — the class token
            // alone used to discard them, so an operator read "schema" for a content-policy block.
            reason: e instanceof ManifestHttpError ? reasonFromBody(e.body) : undefined,
          };
          fallbackChain.push(outcome);
          self.health.recordResult(c.key, cls, outcome.retryAfterMs);
          if (args.signal?.aborted) return;
          // TIMEOUT: don't burn the remaining plan on a hung provider chain? §3.6 says the
          // next plan entry IS the retry, so we continue.
        } finally {
          // Released on every path — success, classified failure, and mid-stream throw alike.
          release?.();
        }
      }
      if (!served) {
        throw new AllAttemptsFailedError(args.model, fallbackChain);
      }
    }

    return {
      served: () => served,
      fallbackChain: () => [...fallbackChain],
      chunks: stream(),
      usage: () => usageBox.value,
      observation: () => observation,
      reasoning: () => (reasoning.length ? reasoning : undefined),
      finishReason: () => finishReason,
    };
  }

  async executeImage(args: {
    plan: Candidate[];
    prompt: string;
    model: string;
    size?: string;
    signal?: AbortSignal;
    maxAttempts?: number;
  }): Promise<{ candidate: Candidate; base64?: string; url?: string; attempts: AttemptOutcome[] }> {
    const attempts: AttemptOutcome[] = [];
    const max = args.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    for (const c of args.plan.slice(0, max)) {
      if (args.signal?.aborted) break;
      // R3: same skip-don't-wait rule as the text path.
      const release = this.limiter ? this.limiter.acquire(c.provider.id) : null;
      if (this.limiter && !release) {
        attempts.push({ candidate: c, cls: "RATE_LIMITED", status: 429 });
        continue;
      }
      try {
        const { adapter } = await this.adapters.forProvider(c.provider.id);
        const res = await adapter.generateImage(
          c.key.secretRef,
          { model: c.model.nativeId, prompt: args.prompt, size: args.size },
          args.signal,
        );
        if (res.ok) {
          this.health.recordResult(c.key, "OK");
          return { candidate: c, base64: res.base64, url: res.url, attempts };
        }
        const cls = classify(res.status);
        attempts.push({ candidate: c, cls, status: res.status });
        this.health.recordResult(c.key, cls);
      } catch {
        attempts.push({ candidate: c, cls: "NETWORK", status: 0 });
        this.health.recordResult(c.key, "NETWORK");
      } finally {
        release?.();
      }
    }
    throw new AllAttemptsFailedError(args.model, attempts);
  }
}

export class AllAttemptsFailedError extends Error {
  constructor(readonly model: string, readonly chain: AttemptOutcome[]) {
    // The reason rides in the detail when a provider gave one — `[p1/k1:BAD_REQUEST_SCHEMA
    // (content-blocked: …)]` instead of a bare class token that named our request, not theirs.
    const detail = chain
      .map((a) => `${a.candidate.provider.slug}/${a.candidate.key.label}:${a.cls}${a.reason ? ` (${a.reason})` : ""}`)
      .join(" -> ");
    super(`all attempts failed for ${model} [${detail || "empty plan"}]`);
  }

  /**
   * The shortest wait any attempt named, in milliseconds. Zero when none named one — the caller
   * then omits the hint entirely and the middleware's floor stands.
   *
   * **Shortest, not longest.** The route planner drops keys that are still cooling
   * (`route-planner.ts`: `keys.filter((k) => health.isKeyUsable(k, now))`), so the earliest the next
   * request can be served is the moment the *first* of these keys frees up. Reporting the longest
   * would make the client wait for a key the planner would not have chosen anyway — with keys
   * cooling in 58 s, 42 s and 71 s, the client can be served at 42 s, not 71 s.
   *
   * Every named wait counts, not only `RATE_LIMITED` ones. A 503 that carries `Retry-After: 30`
   * leaves its key technically usable, so filtering it out would tell the client to retry in a
   * second — straight back into a provider that just said it was overloaded.
   *
   * Floored at `COOLDOWN_FLOOR_MS`, matching the tracker, so a provider naming 400 ms never yields
   * a hint of `0`, which would read as "retry now".
   */
  minRetryAfterMs(): number {
    let shortest = Number.POSITIVE_INFINITY;
    for (const a of this.chain) {
      if (!a.retryAfterMs || a.retryAfterMs <= 0) continue;
      shortest = Math.min(shortest, Math.max(a.retryAfterMs, COOLDOWN_FLOOR_MS));
    }
    return Number.isFinite(shortest) ? shortest : 0;
  }
}

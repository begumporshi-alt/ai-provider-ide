/**
 * execution-engine (L2): the attempt loop over the route-planner's plan (§3.1). Tries each
 * candidate; on a key-rotation-class error advances to the next key of the same provider;
 * when a provider's keys are exhausted advances to the next provider (failover). No hidden
 * retry loop — the plan IS the retry policy. Enforces the §3.6 budgets (max attempts,
 * backoff honoring Retry-After) and propagates cancellation via AbortSignal.
 */
import { ManifestHttpError } from "./manifest-interpreter.js";
import type { AdapterInstance } from "./adapter-instance.js";
import type { Candidate } from "./route-planner.js";
import { classify, type ErrorClass } from "./errors.js";
import { COOLDOWN_FLOOR_MS, type HealthTracker } from "./health-tracker.js";
import type { ProviderLimiter } from "./concurrency.js";
import type { ToolCall, UsageTokens } from "./ports.js";

export interface AttemptOutcome {
  candidate: Candidate;
  cls: ErrorClass;
  status: number;
  retryAfterMs?: number;
}

export interface ExecuteTextArgs {
  plan: Candidate[];
  messages: unknown[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  /** Real tool calls are reported here, never through `chunks` (see ports.ToolCall). */
  onToolCall?: (call: ToolCall) => void;
  /** Called once with whatever usage the upstream reported; also fills `TextExecution.usage()`. */
  onUsage?: (usage: UsageTokens) => void;
  signal?: AbortSignal;
  maxAttempts?: number;
}

export interface TextExecution {
  /** The serving candidate (set once the first chunk arrives). */
  served: () => Candidate | undefined;
  fallbackChain: () => AttemptOutcome[];
  chunks: AsyncIterable<string>;
  usage: () => Partial<UsageTokens> | undefined;
}

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
        try {
          const { adapter } = await self.adapters.forProvider(c.provider.id);
          for await (const chunk of adapter.generateText(
            c.key.secretRef,
            // onUsage does double duty: it fills the box the ledger reads, and it is the only
            // way the caller — the gateway bridge, which forwards it host-side — ever learns the
            // token counts. Dropping the caller's callback here left every gateway response
            // reporting `usage: null` even on requests that had usage.
            { model: c.model.nativeId, messages: args.messages, stream: args.stream, maxTokens: args.maxTokens, temperature: args.temperature, tools: args.tools, toolChoice: args.toolChoice, responseFormat: args.responseFormat, onToolCall: args.onToolCall, onUsage: lastUsage => { usageBox.value = lastUsage; args.onUsage?.(lastUsage); } },
            args.signal,
          )) {
            if (!emitted) {
              emitted = true;
              served = c;
            }
            yield chunk;
          }
          self.health.recordResult(c.key, "OK");
          return; // success
        } catch (e) {
          // Mid-stream errors are drift-class (§2.10), never "OK from status 200"
          // (diff-review M2): a stream that already yielded text CANNOT be transparently
          // retried — the consumer would see duplicated output. Fail loud after first byte.
          if (emitted) {
            const cls = e instanceof ManifestHttpError ? classify(e.status) === "OK" ? "PARSE_ERROR" : classify(e.status) : "NETWORK";
            fallbackChain.push({ candidate: c, cls, status: e instanceof ManifestHttpError ? e.status : 0 });
            throw e;
          }
          const cls = e instanceof ManifestHttpError
            ? e.kind === "mid-stream" || classify(e.status) === "OK"
              ? "PARSE_ERROR"
              : classify(e.status)
            : "NETWORK";
          const outcome: AttemptOutcome = {
            candidate: c,
            cls,
            status: e instanceof ManifestHttpError ? e.status : 0,
            // What the provider asked us to wait. Without this the cooldown falls through to the
            // tracker's 1000ms floor, so a key that asked for a minute is retried a second later —
            // straight back into the window it was told to wait out.
            retryAfterMs: e instanceof ManifestHttpError ? e.retryAfterMs : undefined,
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
    const detail = chain.map((a) => `${a.candidate.provider.slug}/${a.candidate.key.label}:${a.cls}`).join(" -> ");
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

/**
 * execution-engine (L2): the attempt loop over the route-planner's plan (§3.1). Tries each
 * candidate; on a key-rotation-class error advances to the next key of the same provider;
 * when a provider's keys are exhausted advances to the next provider (failover). No hidden
 * retry loop — the plan IS the retry policy. Enforces the §3.6 budgets (max attempts,
 * backoff honoring Retry-After) and propagates cancellation via AbortSignal.
 */
import { ManifestHttpError, type ManifestInterpreter } from "./manifest-interpreter.js";
import type { Candidate } from "./route-planner.js";
import { classify, type ErrorClass } from "./errors.js";
import type { HealthTracker } from "./health-tracker.js";

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
  signal?: AbortSignal;
  maxAttempts?: number;
}

export interface TextExecution {
  /** The serving candidate (set once the first chunk arrives). */
  served: () => Candidate | undefined;
  fallbackChain: () => AttemptOutcome[];
  chunks: AsyncIterable<string>;
  usage: () => { prompt_tokens?: number; completion_tokens?: number } | undefined;
}

export const MAX_ATTEMPTS_DEFAULT = 6;

interface AdapterFactory {
  /** Resolve provider -> interpreter (adapter-runtime). */
  forProvider(providerId: string): Promise<{ interpreter: ManifestInterpreter; baseUrl: string }>;
}

export class ExecutionEngine {
  constructor(
    private readonly adapters: AdapterFactory,
    private readonly health: HealthTracker,
  ) {}

  async executeText(args: ExecuteTextArgs): Promise<TextExecution> {
    const fallbackChain: AttemptOutcome[] = [];
    const usageBox: { value?: { prompt_tokens?: number; completion_tokens?: number } } = {};
    let served: Candidate | undefined;

    const maxAttempts = args.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    const attempts = Math.min(args.plan.length, maxAttempts);

    const self = this;
    async function* stream(): AsyncGenerator<string, void, void> {
      for (let i = 0; i < attempts; i++) {
        const c = args.plan[i]!;
        if (args.signal?.aborted) return;
        let emitted = false;
        try {
          const { interpreter } = await self.adapters.forProvider(c.provider.id);
          for await (const chunk of interpreter.generateText(
            c.key.secretRef,
            { model: c.model.nativeId, messages: args.messages, stream: args.stream, maxTokens: args.maxTokens, temperature: args.temperature },
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
          const outcome: AttemptOutcome = { candidate: c, cls, status: e instanceof ManifestHttpError ? e.status : 0 };
          fallbackChain.push(outcome);
          self.health.recordResult(c.key, cls, outcome.retryAfterMs);
          if (args.signal?.aborted) return;
          // TIMEOUT: don't burn the remaining plan on a hung provider chain? §3.6 says the
          // next plan entry IS the retry, so we continue.
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
      try {
        const { interpreter } = await this.adapters.forProvider(c.provider.id);
        const res = await interpreter.generateImage(
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
}

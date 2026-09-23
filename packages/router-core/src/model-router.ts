/**
 * model-router (L2): the public facade (spec req. 9) — the ONLY thing the rest of the app
 * talks to. Wires registry + catalog + planner + execution engine + health + ledger. Also
 * implements `AiTextPort` (§2.8 dependency inversion) for the Generator — with the
 * exclusion rule and system-route preference enforced here, in one auditable place.
 */
import type { Modality } from "@aiprovider/adapter-spec";
import type { ImageRequest, ModelInfo, RouterFacade, TextRequest } from "./ports.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { AdapterRuntime } from "./adapter-runtime.js";
import type { ModelCatalog } from "./model-catalog.js";
import type { CatalogModel } from "./domain.js";
import { buildPlan, type Candidate, type PlanContext } from "./route-planner.js";
import { HealthTracker } from "./health-tracker.js";
import { ExecutionEngine, type TextExecution } from "./execution-engine.js";
import { ProviderLimiter, PER_PROVIDER_DEFAULT, clampConcurrency } from "./concurrency.js";
import { estimateCostMicros } from "./pricing.js";
import { UsageLedger, type LedgerSource } from "./usage-ledger.js";

export interface RouterSettings {
  failoverEnabled: boolean;
  systemAi: { providerId: string; model: string } | null;
  /**
   * Max in-flight requests per provider (audit R3). `0` = unlimited. Saturated providers are
   * skipped in favour of one that can serve, so a single degraded provider cannot occupy the
   * gateway's whole global budget.
   */
  perProviderConcurrency: number;
}

/** §2.8 dependency inversion: the Generator depends on THIS, never on Router internals. */
export interface AiTextPort {
  complete(req: {
    prompt: string;
    system?: string;
    maxTokens: number;
    timeoutMs: number;
    excludeProviderIds: string[];
  }): Promise<string>;
}

/** Availability gate for the AI-assisted wizard path (§2.9 rule 2). */
export interface SystemAiHealth {
  available: boolean;
  reason: string | null;
}

export class ModelRouter implements RouterFacade, AiTextPort {
  readonly health = new HealthTracker();
  private readonly engine: ExecutionEngine;
  private readonly cursors = new Map<string, number>(); // providerId -> round-robin index
  settings: RouterSettings = {
    failoverEnabled: true,
    systemAi: null,
    perProviderConcurrency: PER_PROVIDER_DEFAULT,
  };
  /** Per-provider in-flight cap (audit R3). Exposed for tests and Router Settings. */
  readonly limiter = new ProviderLimiter(PER_PROVIDER_DEFAULT);
  /**
   * Drift hook (§2.10): every attempt outcome — failures in the fallback chain AND the
   * serving success — is observed. Phase 5 wires this to DriftMonitor.observe; the router
   * itself stays free of drift logic (separation keeps the attempt loop testable).
   */
  onAttempt?: (a: { providerId: string; providerSlug: string; model: string; requestedModel: string; cls: import("./errors.js").ErrorClass; ts: number }) => void;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly adapters: AdapterRuntime,
    private readonly catalog: ModelCatalog,
    private readonly ledger: UsageLedger,
  ) {
    this.engine = new ExecutionEngine({ forProvider: (pid) => this.adapters.forProvider(pid) }, this.health, this.limiter);
  }

  /** Apply `settings.perProviderConcurrency` to the live limiter (Router Settings changes). */
  syncConcurrency(): void {
    // Clamped rather than trusted: the value arrives from persisted JSON (`Object.assign` over
    // `router.settings` with no validation), so a stored `-1` or `"4"` would reach the limiter
    // as-is — and `-1` reads as a bound while behaving as unlimited.
    this.limiter.maxPerProvider = clampConcurrency(this.settings.perProviderConcurrency);
  }

  async generateText(
    req: TextRequest,
    opts?: { signal?: AbortSignal; source?: LedgerSource; appKeyId?: string },
  ): Promise<TextExecution> {
    const t0 = Date.now();
    this.syncConcurrency();
    const plan = this.plan(req.model, "text");
    if (!plan.length) {
      await this.recordNoRoute(req.model, "text", opts?.source ?? "ui", t0, opts?.appKeyId);
      throw new Error(`no route for model "${req.model}" (no enabled provider carries it)`);
    }
    const exec = await this.engine.executeText({
      plan,
      messages: req.messages,
      model: req.model,
      stream: true,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      // §3.4 pass-through. These were accepted on TextRequest and then dropped here, so every
      // tool-capable provider silently received a toolless request — which is why models that
      // were trained on agent transcripts (mercury-2.5) invent tool-call markup in prose.
      tools: req.tools,
      toolChoice: req.toolChoice,
      responseFormat: req.responseFormat,
      onToolCall: req.onToolCall,
      // Forwarded so the caller can report usage onward (the gateway sends it host-side); the
      // engine keeps its own copy for the ledger regardless.
      onUsage: req.onUsage,
      signal: opts?.signal,
    });
    return this.wrapLedger(
      exec,
      req.model,
      "text",
      opts?.source ?? "ui",
      t0,
      opts?.signal,
      opts?.appKeyId,
    );
  }

  async generateImage(
    req: ImageRequest,
    opts?: { signal?: AbortSignal; source?: LedgerSource; appKeyId?: string },
  ): Promise<{ url?: string; base64?: string }> {
    const t0 = Date.now();
    this.syncConcurrency();
    const plan = this.plan(req.model, "image");
    if (!plan.length) {
      await this.recordNoRoute(req.model, "image", opts?.source ?? "ui", t0, opts?.appKeyId);
      // The bare "no route for image model" blamed the model id. Measured live 2026-09-22: the
      // gateway advertised 15 image-named models and 404'd every one, because the catalog tagged
      // zero of them as image — no configured provider declared an image capability, so the id
      // was never the problem. Say which of the three it actually is. "no route" is kept in the
      // text because `gatewayStatus` maps that phrase to 404.
      throw new Error(`no route for image model "${req.model}" (${this.whyNoImage(req.model)})`);
    }
    const res = await this.engine.executeImage({ plan, prompt: req.prompt, model: req.model, signal: opts?.signal });
    await this.ledger.append({
      ts: Date.now(),
      modality: "image",
      source: opts?.source ?? "ui",
      providerId: res.candidate.provider.id,
      keyId: res.candidate.key.id,
      appKeyId: opts?.appKeyId,
      requestedModel: req.model,
      model: res.candidate.model.nativeId,
      status: "ok",
      latencyMs: Date.now() - t0,
      tokensIn: 0,
      tokensOut: 0,
      costEstimateMicros: 0,
      fallbackChain: res.attempts,
    });
    this.advanceCursor(res.candidate.provider.id);
    return { url: res.url, base64: res.base64 };
  }

  /**
   * Why an image request planned to nothing, in the caller's terms.
   *
   * Three different failures used to produce one message that named the model, so the caller
   * went and checked the model id. Only the middle case is actually about the id.
   */
  private whyNoImage(requested: string): string {
    if (!this.catalog.forModality("image").length) {
      // Nothing in the catalog is an image model at all — a provider that advertises image ids
      // but declares no `modalityRules.image` tags every one of them text. Blaming the model
      // sends the caller to fix a string that is already correct.
      return "no enabled provider is configured for image generation";
    }
    // The request may be qualified (`slug/native`), which is how `/v1/models` prints ids.
    const known = this.catalog
      .all()
      .some((m) => m.nativeId === requested || requested.endsWith(`/${m.nativeId}`));
    if (!known) return "no enabled provider carries it";
    return "it is not tagged as an image model in the catalog";
  }

  async listModels(modality?: Modality): Promise<ModelInfo[]> {
    const rows = modality ? this.catalog.forModality(modality) : this.catalog.all();
    return rows.map((m) => {
      const p = this.registry.getProvider(m.providerId);
      return { id: p ? `${p.slug}/${m.nativeId}` : m.nativeId, providerId: m.providerId, modality: m.modality };
    });
  }

  systemAiAvailable(): SystemAiHealth {
    const ok = (p: string) => this.registry.getProvider(p)?.status === "enabled";
    const active = (p: string) => this.registry.keysOf(p).some((k) => this.health.isKeyUsable(k));
    if (this.settings.systemAi && ok(this.settings.systemAi.providerId) && active(this.settings.systemAi.providerId)) {
      return { available: true, reason: null };
    }
    const anyHealthy = this.registry
      .listProviders()
      .some((p) => p.status === "enabled" && this.catalog.all().some((m) => m.providerId === p.id && m.modality === "text") && active(p.id));
    if (anyHealthy) return { available: true, reason: null };
    return {
      available: false,
      reason: "AI-assisted path unlocks after the first enabled provider with an active key and a text model",
    };
  }

  /** AiTextPort (§2.8): system-AI-first, exclusion-enforced completion. */
  async complete(req: {
    prompt: string;
    system?: string;
    maxTokens: number;
    timeoutMs: number;
    excludeProviderIds: string[];
  }): Promise<string> {
    const messages = req.system
      ? [{ role: "system", content: req.system }, { role: "user", content: req.prompt }]
      : [{ role: "user", content: req.prompt }];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs);
    try {
      const excluded = new Set(req.excludeProviderIds);
      // Candidate order: the configured system pick (unless excluded), then any healthy
      // text-capable provider's models (§2.9 rule 3).
      const modelOrder: string[] = [];
      if (this.settings.systemAi && !excluded.has(this.settings.systemAi.providerId)) {
        modelOrder.push(`${this.slugOf(this.settings.systemAi.providerId)}/${this.settings.systemAi.model}`);
      }
      for (const p of this.registry.listProviders()) {
        if (p.status !== "enabled" || excluded.has(p.id)) continue;
        for (const m of this.catalog.forModality("text")) {
          if (m.providerId === p.id) modelOrder.push(`${p.slug}/${m.nativeId}`);
        }
      }
      for (const model of modelOrder) {
        if (ac.signal.aborted) break;
        const plan = this.plan(model, "text", [...excluded]);
        if (!plan.length) continue;
        try {
          const exec = await this.engine.executeText({
            plan,
            messages,
            model,
            stream: false,
            maxTokens: req.maxTokens,
            signal: ac.signal,
          });
          let out = "";
          for await (const c of exec.chunks) out += c;
          const served = exec.served();
          if (out) {
            await this.ledger.append({
              ts: Date.now(),
              modality: "text",
              source: "generator",
              providerId: served?.provider.id,
              keyId: served?.key.id,
              requestedModel: model,
              model: served?.model.nativeId ?? model,
              status: "ok",
              latencyMs: 0,
              tokensIn: 0,
              tokensOut: 0,
              costEstimateMicros: 0,
            });
            return out;
          }
        } catch {
          // this candidate failed — try the next healthy provider (§2.9)
        }
      }
      throw new Error("system AI: no healthy text provider available");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Test/UX hook: disabling a key removes it from rotation immediately (criterion 2). */
  markKeyDisabled(keyId: string): void {
    this.registry.updateKey(keyId, { status: "disabled" });
  }

  nextKeyCursor(providerId: string): number {
    return this.cursors.get(providerId) ?? 0;
  }

  advanceCursor(providerId: string): void {
    this.cursors.set(providerId, this.nextKeyCursor(providerId) + 1);
  }

  /** R2: normalized pricing for a catalog model (`undefined` = unknown, NOT free). */
  pricingFor(model: CatalogModel) {
    return this.catalog.pricingFor(model.providerId, model.nativeId);
  }

  private slugOf(providerId: string): string {
    return this.registry.getProvider(providerId)?.slug ?? providerId;
  }

  private plan(model: string, modality: Modality, excludeProviderIds: string[] = []): Candidate[] {
    const ctx: PlanContext = {
      providers: this.registry.listProviders(),
      keysFor: (pid) => this.registry.keysOf(pid),
      catalog: () => this.catalog.all(),
      aliases: this.catalog.aliases,
      health: this.health,
      nextKeyCursor: (pid) => this.nextKeyCursor(pid),
      // R2: lets `cost_spread` order carriers by real price instead of falling back to priority.
      pricingFor: (pid, nativeId) => this.catalog.pricingFor(pid, nativeId),
    };
    let plan = buildPlan({ model, modality, excludeProviderIds }, ctx);
    if (!this.settings.failoverEnabled) {
      // Failover off: only the first provider's key chain serves.
      const first = plan[0]?.provider.id;
      plan = plan.filter((c) => c.provider.id === first);
    }
    return plan;
  }

  /**
   * Record a request that found no route at all.
   *
   * An empty plan means no candidate was ever attempted — which is precisely and only what
   * `NO_ROUTE` describes, so this is the one place that class is written. Until this existed the
   * guard threw before the engine ran, so a model nothing could serve failed in the UI and left no
   * trace here: the ledger was silent about the request the user is most likely to be confused by.
   * `fallbackChain: []` is the honest value — there were no attempts to record.
   *
   * `appKeyId` is carried here too. A `NO_ROUTE` row costs nothing, so it is tempting to leave
   * unattributed — but it is a gateway request that happened, and a per-app view that dropped
   * exactly the failures would under-report the app that is misconfigured rather than the one
   * that is expensive.
   */
  private async recordNoRoute(
    requestedModel: string,
    modality: Modality,
    source: LedgerSource,
    t0: number,
    appKeyId?: string,
  ): Promise<void> {
    await this.ledger.append({
      ts: Date.now(),
      modality,
      source,
      appKeyId,
      requestedModel,
      model: requestedModel,
      status: "error",
      errorClass: "NO_ROUTE",
      latencyMs: Date.now() - t0,
      tokensIn: 0,
      tokensOut: 0,
      costEstimateMicros: 0,
      fallbackChain: [],
    });
  }

  private wrapLedger(
    exec: TextExecution,
    requestedModel: string,
    modality: Modality,
    source: LedgerSource,
    t0: number,
    signal?: AbortSignal,
    appKeyId?: string,
  ): TextExecution {
    const ledger = this.ledger;
    const router = this;
    async function* wrapped(): AsyncGenerator<string, void, void> {
      try {
        for await (const c of exec.chunks) yield c;
        const served = exec.served();
        const tokensIn = exec.usage()?.prompt_tokens ?? 0;
        const tokensOut = exec.usage()?.completion_tokens ?? 0;
        // Carried through as-is, `undefined` included. `ledger.cached_tokens` is nullable so that
        // "the provider reported no cache block" stays distinguishable from "it reported zero" —
        // which is the whole question migration 0015 exists to answer.
        const cachedTokens = exec.usage()?.cached_tokens;
        if (!served) {
          // A stream that completes without ever serving is not a success. The engine returns
          // normally in that state only when the caller aborted (plan exhaustion throws
          // AllAttemptsFailedError) or when a provider answered 200 with an empty body — neither
          // is an answer. Writing "ok" here claimed a success for a request that never reached a
          // provider: the live ledger held 7 such rows, and the 99.5s / 83s latencies among them
          // are client timeouts, not answers. No provider is named because none produced a token.
          await ledger.append({
            ts: Date.now(),
            modality,
            source,
            appKeyId,
            requestedModel,
            model: requestedModel,
            status: "error",
            errorClass: signal?.aborted ? "CANCELLED" : "PARSE_ERROR",
            latencyMs: Date.now() - t0,
            tokensIn,
            tokensOut,
            cachedTokens,
            costEstimateMicros: 0,
            fallbackChain: exec.fallbackChain(),
          });
          router.observeAttempts(exec, requestedModel);
          return;
        }
        await ledger.append({
          ts: Date.now(),
          modality,
          source,
          providerId: served?.provider.id,
          keyId: served?.key.id,
          appKeyId,
          requestedModel,
          model: served?.model.nativeId ?? requestedModel,
          status: "ok",
          latencyMs: Date.now() - t0,
          tokensIn,
          tokensOut,
          cachedTokens,
          // R2: real cost instead of a constant 0. Unknown pricing -> 0 in the ledger column,
          // and the UI renders "—" for it by consulting the catalog (unknown != free).
          costEstimateMicros: estimateCostMicros(
            served ? router.pricingFor(served.model) : undefined,
            tokensIn,
            tokensOut,
          ) ?? 0,
          fallbackChain: exec.fallbackChain(),
        });
        if (served) router.advanceCursor(served.provider.id);
        router.observeAttempts(exec, requestedModel);
      } catch (e) {
        const served = exec.served();
        // Nothing served: the last attempt IS the route that was tried, and its class IS the
        // reason. `NO_ROUTE` used to be written for every failure, which threw the cause away —
        // the row read "no route" while the chain stored beside it named a provider, a key and a
        // class. It is now reserved for what it describes: no candidate was ever attempted.
        const chain = exec.fallbackChain();
        const last = chain[chain.length - 1];
        await ledger.append({
          ts: Date.now(),
          modality,
          source,
          // `served` only — deliberately NOT the last attempt. "Provider"/"Key" mean *who
          // served*, so a null provider on an error row is itself the signal that nothing served
          // at all; filling it from the failed attempt would erase that distinction and name a
          // provider that never produced a token. The attempt that failed is in the chain below.
          providerId: served?.provider.id,
          keyId: served?.key.id,
          appKeyId,
          requestedModel,
          model: served?.model.nativeId ?? requestedModel,
          status: "error",
          // The upstream status the provider actually returned, so a 400 is distinguishable
          // from a connection that never landed.
          httpStatus: served ? undefined : last?.status,
          // `?? "NO_ROUTE"` is now genuinely unreachable here: an empty plan is rejected by
          // `generateText` before the engine runs, and `recordNoRoute` writes the row for it. What
          // remains is a defensive default for an engine throw with an empty chain.
          errorClass: served ? "NETWORK" : (last?.cls ?? "NO_ROUTE"),
          latencyMs: Date.now() - t0,
          tokensIn: exec.usage()?.prompt_tokens ?? 0,
          tokensOut: exec.usage()?.completion_tokens ?? 0,
          cachedTokens: exec.usage()?.cached_tokens,
          costEstimateMicros: 0,
          fallbackChain: chain,
        });
        router.observeAttempts(exec, requestedModel);
        throw e;
      }
    }
    return { ...exec, chunks: wrapped() };
  }

  /** §2.10: surface every attempt of a routed request to the drift hook (once each). */
  private observeAttempts(exec: TextExecution, requestedModel: string): void {
    const hook = this.onAttempt;
    if (!hook) return;
    const now = Date.now();
    for (const a of exec.fallbackChain()) {
      hook({
        providerId: a.candidate.provider.id,
        providerSlug: a.candidate.provider.slug,
        model: a.candidate.model.nativeId,
        requestedModel,
        cls: a.cls,
        ts: now,
      });
    }
    const served = exec.served();
    if (served) {
      hook({
        providerId: served.provider.id,
        providerSlug: served.provider.slug,
        model: served.model.nativeId,
        requestedModel,
        cls: "OK",
        ts: now,
      });
    }
  }
}

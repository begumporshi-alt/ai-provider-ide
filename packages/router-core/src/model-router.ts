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
import { ProviderLimiter, PER_PROVIDER_DEFAULT } from "./concurrency.js";
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
    this.limiter.maxPerProvider = this.settings.perProviderConcurrency;
  }

  async generateText(req: TextRequest, opts?: { signal?: AbortSignal; source?: LedgerSource }): Promise<TextExecution> {
    const t0 = Date.now();
    this.syncConcurrency();
    const plan = this.plan(req.model, "text");
    if (!plan.length) throw new Error(`no route for model "${req.model}" (no enabled provider carries it)`);
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
    return this.wrapLedger(exec, req.model, "text", opts?.source ?? "ui", t0);
  }

  async generateImage(req: ImageRequest, opts?: { signal?: AbortSignal; source?: LedgerSource }): Promise<{ url?: string; base64?: string }> {
    const t0 = Date.now();
    this.syncConcurrency();
    const plan = this.plan(req.model, "image");
    if (!plan.length) throw new Error(`no route for image model "${req.model}"`);
    const res = await this.engine.executeImage({ plan, prompt: req.prompt, model: req.model, signal: opts?.signal });
    await this.ledger.append({
      ts: Date.now(),
      modality: "image",
      source: opts?.source ?? "ui",
      providerId: res.candidate.provider.id,
      keyId: res.candidate.key.id,
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

  private wrapLedger(
    exec: TextExecution,
    requestedModel: string,
    modality: Modality,
    source: LedgerSource,
    t0: number,
  ): TextExecution {
    const ledger = this.ledger;
    const router = this;
    async function* wrapped(): AsyncGenerator<string, void, void> {
      try {
        for await (const c of exec.chunks) yield c;
        const served = exec.served();
        const tokensIn = exec.usage()?.prompt_tokens ?? 0;
        const tokensOut = exec.usage()?.completion_tokens ?? 0;
        await ledger.append({
          ts: Date.now(),
          modality,
          source,
          providerId: served?.provider.id,
          keyId: served?.key.id,
          requestedModel,
          model: served?.model.nativeId ?? requestedModel,
          status: "ok",
          latencyMs: Date.now() - t0,
          tokensIn,
          tokensOut,
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
        await ledger.append({
          ts: Date.now(),
          modality,
          source,
          providerId: served?.provider.id,
          keyId: served?.key.id,
          requestedModel,
          model: served?.model.nativeId ?? requestedModel,
          status: "error",
          errorClass: served ? "NETWORK" : "NO_ROUTE",
          latencyMs: Date.now() - t0,
          tokensIn: exec.usage()?.prompt_tokens ?? 0,
          tokensOut: exec.usage()?.completion_tokens ?? 0,
          costEstimateMicros: 0,
          fallbackChain: exec.fallbackChain(),
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

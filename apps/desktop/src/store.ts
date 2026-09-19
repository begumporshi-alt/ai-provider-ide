/**
 * Desktop bootstrap: the single place where router-core gets wired to the host.
 * Owns the core instances (registry, catalog, adapters, ledger, router), hydration from
 * SQLite, and write-through persistence — every state-changing action mutates the core AND
 * calls one fixed host command (the invariant-12-safe replacement for a raw StorePort).
 */
import { invoke } from "@tauri-apps/api/core";
import {
  AdapterRuntime,
  DriftMonitor,
  ModelCatalog,
  ModelRouter,
  ProviderRegistry,
  RepairOrchestrator,
  UsageLedger,
  PROVIDER_PROFILES,
  type AdapterManifest,
  type ApiKeyRecord,
  type CatalogModel,
  type DriftEvidence,
  type LedgerEntry,
  type PricingMicros,
  type ProviderRecord,
  type RepairPlan,
} from "@aiprovider/router-core";
import { createHttpPort, createKeyVaultPort } from "./ipc-client";
import type { HostContextNode, HostContextEdge } from "./lib/context/engine";

// ---------- host row shapes (camelCase, mirror persist.rs) ----------

export interface HostProviderRow {
  id: string; slug: string; name: string; type: string | null; baseUrl: string;
  status: string; rotationStrategy: string; createdAt: number; updatedAt: number;
}
export interface HostKeyRow {
  id: string; providerId: string; label: string; secretRef: string; secretHint: string | null;
  status: string; priority: number; cooldownUntil: number | null; addedAt: number;
  lastUsedAt: number | null; lastTestedAt: number | null;
}
export interface HostModelRow {
  providerId: string; nativeId: string; modality: string; contextWindow: number | null; fetchedAt: number;
  pricingJson: string | null; capabilitiesJson: string | null;
}

/**
 * Capabilities come back as a JSON string. Unknown stays unknown — never assumed either way,
 * because a client acts on this flag.
 */
function parseCapabilitiesJson(v: string | null | undefined): { reasoning?: boolean } | undefined {
  if (!v) return undefined;
  try {
    return JSON.parse(v) as { reasoning?: boolean };
  } catch {
    return undefined;
  }
}

/** Pricing comes back as a string; a row that fails to parse is unknown, never free. */
function parsePricingJson(v: string | null | undefined): PricingMicros | undefined {
  if (!v) return undefined;
  try {
    const p = JSON.parse(v) as PricingMicros;
    return typeof p?.prompt === "number" && typeof p?.completion === "number" ? p : undefined;
  } catch {
    return undefined;
  }
}
export interface HostManifestRow {
  id: string; providerId: string; version: number; origin: string; bodyJson: string;
  contractResultJson: string | null; createdAt: number; isActive: boolean;
}
export interface HostAliasRow {
  alias: string; providerId: string; nativeModelId: string; priority: number;
}
export interface HostLedgerRow {
  ts: number; modality: string; source: string; providerId: string | null; keyId: string | null;
  requestedModel: string | null; model: string; status: string; httpStatus: number | null;
  errorClass: string | null; latencyMs: number | null; tokensIn: number; tokensOut: number;
  costEstimateMicros: number; fallbackChainJson: string | null;
}

// ---------- singletons ----------

const vault = createKeyVaultPort();
const http = createHttpPort();

export const registry = new ProviderRegistry(vault);
export const adapters = new AdapterRuntime(http, { appUrl: "https://aiprovider.router" });
export const ledger = new UsageLedger({
  async append(e: LedgerEntry) {
    await invoke("ledger_append", {
      e: {
        ts: e.ts,
        modality: e.modality,
        source: e.source,
        providerId: e.providerId ?? null,
        keyId: e.keyId ?? null,
        requestedModel: e.requestedModel,
        model: e.model,
        status: e.status,
        httpStatus: e.httpStatus ?? null,
        errorClass: e.errorClass ?? null,
        latencyMs: e.latencyMs ?? null,
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        costEstimateMicros: e.costEstimateMicros,
        fallbackChainJson: e.fallbackChain
          ? JSON.stringify(e.fallbackChain.map((a) => ({
              provider: a.candidate.provider.slug,
              key: a.candidate.key.label,
              cls: a.cls,
            })))
          : null,
      },
    });
  },
});
export const catalog = new ModelCatalog(registry, adapters);
export const router = new ModelRouter(registry, adapters, catalog, ledger);

// ---------- Phase 5: drift detection + repair ----------

/** Providers currently in repair flow: id -> evidence + plan (UI subscribes via useUi tick). */
export const pendingRepairs = new Map<string, { evidence: DriftEvidence; plan?: RepairPlan; error?: string }>();

const requestTimes: { requestedModel: string; providerId: string; ts: number }[] = [];

export const driftMonitor = new DriftMonitor({
  succeededElsewhere: (requestedModel, excludeProviderId) => {
    // recent success for the same requested model via a different provider
    const now = Date.now();
    return ledger
      .query({ since: now - 60 * 60_000 })
      .some((e) => e.status === "ok" && e.requestedModel === requestedModel && e.providerId && e.providerId !== excludeProviderId);
  },
  onTrigger: (e) => {
    void invoke("drift_event_record", { providerId: e.providerId, triggerJson: JSON.stringify(e) }).catch(() => undefined);
    // mark repairing (failover keeps serving) and open the plan in the background
    void setProviderStatus(e.providerId, "repairing").catch(() => undefined);
    void buildRepairPlan(e).catch(() => undefined);
  },
});

// observe every attempt; keep a model->provider success index for the "elsewhere" test
router.onAttempt = (a) => {
  driftMonitor.observe(a);
  if (a.cls === "OK") {
    requestTimes.push({ requestedModel: a.requestedModel, providerId: a.providerId, ts: a.ts });
    if (requestTimes.length > 2000) requestTimes.splice(0, requestTimes.length - 2000);
  }
};

export async function buildRepairPlan(evidence: DriftEvidence): Promise<RepairPlan | undefined> {
  const provider = registry.getProvider(evidence.providerId);
  if (!provider) return undefined;
  const { adapter } = await adapters.forProvider(provider.id);
  const secretRef = registry.keysOf(provider.id)[0]?.secretRef;
  if (!secretRef) return undefined;
  const otherHealthy = registry.listProviders().filter((p) => p.id !== provider.id && p.status === "enabled").length;
  const entry = { evidence };
  pendingRepairs.set(provider.id, entry);
  try {
    // free re-checks produce the failing-assertions context for the AI patch prompt
    const { runContractSuite } = await import("@aiprovider/router-core");
    const contract = await runContractSuite(adapter, { secretRef, consent: { text: false, image: false } });
    const plan = await new RepairOrchestrator({
      http,
      ai: router,
      systemLabel: routerSettingsLabel(),
      currentManifest: adapter.manifest,
      currentVersion: 1,
      provider: { id: provider.id, slug: provider.slug, name: provider.name, baseUrl: provider.baseUrl },
      secretRef,
      otherHealthyProviders: otherHealthy,
      failingChecks: contract.checks.filter((c) => !c.pass),
      audit: async (a) => {
        await invoke("generator_audit_record", {
          e: { modelUsed: a.modelUsed, promptTokens: Math.round(a.promptChars / 4), completionTokens: Math.round(a.completionChars / 4), redactionHash: a.redactionHash },
        }).catch(() => undefined);
      },
    }).plan();
    pendingRepairs.set(provider.id, { ...entry, plan });
    return plan;
  } catch (err) {
    pendingRepairs.set(provider.id, { ...entry, error: String((err as Error).message) });
    return undefined;
  }
}

function routerSettingsLabel(): string {
  const sa = router.settings.systemAi;
  if (sa) return `${registry.getProvider(sa.providerId)?.slug ?? "?"}/${sa.model} (system)`;
  return "auto (system)";
}

/** Human confirms the staged repair: stage new manifest version + activate + hot-swap. */
export async function approveRepair(providerId: string): Promise<{ version: number; previous: number | null } | undefined> {
  const entry = pendingRepairs.get(providerId);
  const manifest = entry?.plan?.candidate?.manifest ?? entry?.plan?.deterministic;
  if (!manifest || !entry) return undefined;
  const origin = entry.plan?.candidate ? "ai-patched" : "builtin-template";
  const version = await invoke<number>("manifest_stage", {
    m: {
      id: crypto.randomUUID(), providerId, version: 0, origin,
      bodyJson: JSON.stringify({ ...manifest, provenance: { ...manifest.provenance, origin } }),
      contractResultJson: JSON.stringify(entry.plan?.candidate?.contract ?? null),
      createdAt: Date.now(), isActive: false,
    },
  });
  const previous = await invoke<number | null>("manifest_activate", { providerId, version });
  adapters.register(providerId, manifest); // hot-swap
  await setProviderStatus(providerId, "enabled");
  await refreshCatalog(providerId).catch(() => undefined);
  await invoke("drift_event_resolve", { providerId, resolution: `repaired v${version}` }).catch(() => undefined);
  pendingRepairs.delete(providerId);
  return { version, previous };
}

export async function rollbackManifest(providerId: string, version: number): Promise<void> {
  await invoke("manifest_activate", { providerId, version });
  const rows = await invoke<HostManifestRow[]>("manifests_active");
  const row = rows.find((r) => r.providerId === providerId);
  if (row) {
    adapters.register(providerId, JSON.parse(row.bodyJson) as AdapterManifest);
  }
}

export async function listManifestHistory(providerId: string): Promise<HostManifestRow[]> {
  return invoke<HostManifestRow[]>("manifests_history", { providerId });
}

let bootstrapped = false;

/** Load persisted state into the core; safe to call repeatedly (no-op after the first). */
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  const [providers, keys, models, manifests, aliases] = await Promise.all([
    invoke<HostProviderRow[]>("providers_list"),
    invoke<HostKeyRow[]>("api_keys_list", { providerId: null }),
    invoke<HostModelRow[]>("models_cache_list"),
    invoke<HostManifestRow[]>("manifests_active"),
    invoke<HostAliasRow[]>("aliases_list"),
  ]);

  registry.hydrate(providers.map(hostToProvider), keys.map(hostToKey));

  const fetchedByProvider: Record<string, number> = {};
  for (const m of models) fetchedByProvider[m.providerId] = Math.max(fetchedByProvider[m.providerId] ?? 0, m.fetchedAt);
  catalog.hydrate(
    models.map((m) => ({
      providerId: m.providerId, nativeId: m.nativeId,
      modality: m.modality as CatalogModel["modality"],
      contextWindow: m.contextWindow ?? undefined, fetchedAt: m.fetchedAt,
      pricing: parsePricingJson(m.pricingJson),
      supportsReasoning: parseCapabilitiesJson(m.capabilitiesJson)?.reasoning,
    })),
    fetchedByProvider,
  );

  // Adapter registration: builtin profiles win by slug (pinned facts, current template);
  // custom providers use their active manifest row.
  for (const p of providers) {
    const profile = PROVIDER_PROFILES[p.slug];
    if (profile) {
      adapters.register(p.id, withBaseUrl(profile(), p.baseUrl));
      continue;
    }
    const row = manifests.find((x) => x.providerId === p.id);
    if (row) {
      try {
        adapters.register(p.id, JSON.parse(row.bodyJson) as AdapterManifest);
      } catch {
        // corrupt manifest: leave unregistered; Phase 5 drift/repair surfaces it
      }
    }
  }

  if (aliases.length) {
    catalog.setAliases(aliases.map((a) => ({ ...a, auto: false })));
  } else {
    catalog.deriveAutoAliases();
    await persistAliases();
  }

  const settingsRaw = await invoke<string | null>("settings_get", { key: "router" });
  if (settingsRaw) {
    try {
      Object.assign(router.settings, JSON.parse(settingsRaw));
    } catch {
      /* keep defaults */
    }
  }

  // Self-heal a stale catalog: a persisted cache can outlive its adapter's modality rules
  // (the 2026-09-16 rawMatch amendment is the case), and `isStale` was never called, so a
  // pre-fix cache would otherwise keep showing wrong classifications until a manual refresh.
  // Rows already fresh are untouched; failures leave the stale rows in place (stale-fallback).
  await refreshStaleCatalogs().catch(() => undefined);
}

async function refreshFromHost(): Promise<void> {
  const [providers, keys] = await Promise.all([
    invoke<HostProviderRow[]>("providers_list"),
    invoke<HostKeyRow[]>("api_keys_list", { providerId: null }),
  ]);
  registry.hydrate(providers.map(hostToProvider), keys.map(hostToKey));
}

/**
 * Boot-time catalog self-heal: re-list exactly the enabled providers whose cached rows are
 * missing or stale (TTL 24h), then persist the fresh rows. Never touches a provider without
 * an active key or with live rows, and a failed refresh leaves the stale rows in place.
 * Derived aliases are recomputed once at the end so ids that changed classification (or
 * appeared) get the same alias treatment as any manual refresh.
 */
async function refreshStaleCatalogs(): Promise<void> {
  const providers = registry.listProviders();
  const stale = providers.filter(
    (p) => p.status === "enabled" && registry.keysOf(p.id).some((k) => k.status === "active") && catalog.isStale(p.id),
  );
  for (const p of stale) {
    await refreshCatalog(p.id).catch(() => undefined);
  }
  if (stale.length) {
    catalog.deriveAutoAliases();
    await persistAliases().catch(() => undefined);
  }
}

async function persistAliases(): Promise<void> {
  await invoke("aliases_replace", {
    rows: catalog.aliases.map((a) => ({
      alias: a.alias, providerId: a.providerId, nativeModelId: a.nativeModelId, priority: a.priority,
    })),
  });
}

function withBaseUrl(m: AdapterManifest, baseUrl: string): AdapterManifest {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

function hostToProvider(p: HostProviderRow): ProviderRecord {
  return {
    id: p.id, slug: p.slug, name: p.name, type: (p.type ?? "manifest") as ProviderRecord["type"],
    baseUrl: p.baseUrl, status: p.status as ProviderRecord["status"],
    rotationStrategy: p.rotationStrategy as ProviderRecord["rotationStrategy"],
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

function hostToKey(k: HostKeyRow): ApiKeyRecord {
  return {
    id: k.id, providerId: k.providerId, label: k.label, secretRef: k.secretRef,
    secretHint: k.secretHint ?? undefined, status: k.status as ApiKeyRecord["status"],
    priority: k.priority, cooldownUntil: k.cooldownUntil, addedAt: k.addedAt,
    lastUsedAt: k.lastUsedAt, lastTestedAt: k.lastTestedAt,
  };
}

function providerToHost(r: ProviderRecord): HostProviderRow {
  return { ...r, type: r.type, baseUrl: r.baseUrl };
}

function keyToHost(r: ApiKeyRecord): HostKeyRow {
  return {
    id: r.id, providerId: r.providerId, label: r.label, secretRef: r.secretRef,
    secretHint: r.secretHint ?? null, status: r.status, priority: r.priority,
    cooldownUntil: r.cooldownUntil, addedAt: r.addedAt, lastUsedAt: r.lastUsedAt,
    lastTestedAt: r.lastTestedAt,
  };
}

// ---------- write-through actions ----------

export async function addProvider(input: {
  slug: string;
  name: string;
  type: ProviderRecord["type"];
  baseUrl: string;
  manifest: AdapterManifest;
}): Promise<ProviderRecord> {
  if (registry.providerBySlug(input.slug)) {
    throw new Error(`a provider with slug "${input.slug}" already exists — remove it first`);
  }
  const p = registry.addProvider({
    id: crypto.randomUUID(), slug: input.slug, name: input.name, type: input.type,
    baseUrl: input.baseUrl, status: "draft", rotationStrategy: "round_robin",
  });
  try {
    await invoke("provider_upsert", { p: providerToHost(p) });
    adapters.register(p.id, input.manifest);
    await invoke("manifest_upsert_active", {
      m: {
        id: crypto.randomUUID(), providerId: p.id, version: 1, origin: "builtin-template",
        bodyJson: JSON.stringify(input.manifest), contractResultJson: null, createdAt: Date.now(), isActive: true,
      },
    });
    return p;
  } catch (e) {
    // Host persist failed (e.g. UNIQUE slug): roll the in-memory state back so the registry
    // never holds a ghost provider the host doesn't know about.
    adapters.unregister(p.id);
    await refreshFromHost().catch(() => undefined);
    throw e;
  }
}

export async function setProviderStatus(id: string, status: ProviderRecord["status"]): Promise<void> {
  registry.setProviderStatus(id, status);
  const p = registry.getProvider(id);
  if (p) await invoke("provider_upsert", { p: providerToHost(p) }); // syncs allowlist host-side
}

export async function setProviderRotation(id: string, rotationStrategy: ProviderRecord["rotationStrategy"]): Promise<void> {
  registry.setProviderRotation(id, rotationStrategy);
  const p = registry.getProvider(id);
  if (p) await invoke("provider_upsert", { p: providerToHost(p) });
}

export async function deleteProvider(id: string): Promise<void> {
  await invoke("provider_delete", { id }); // cascades; host recomputes the allowlist
  adapters.unregister(id);
  await refreshFromHost();
}

/** Add a key: vault write happens inside registry.addKey via the KeyVaultPort (one call). */
export async function addKey(providerId: string, label: string, secret: string): Promise<ApiKeyRecord> {
  const provider = registry.getProvider(providerId);
  const k = await registry.addKey({ providerId, label, secret });
  await invoke("api_key_upsert", { k: keyToHost(k) });
  // draft providers aren't host-allowlisted (invariant 3); the first key promotes to
  // pending so Test works immediately.
  if (provider?.status === "draft") await setProviderStatus(providerId, "pending");
  return k;
}

export async function deleteKey(id: string): Promise<void> {
  await invoke("api_key_delete", { id }); // host removes the keychain entry too (§7)
  await refreshFromHost();
}

export async function setKeyStatus(id: string, status: ApiKeyRecord["status"]): Promise<void> {
  registry.updateKey(id, { status });
  const k = registry.getKey(id);
  if (k) await invoke("api_key_upsert", { k: keyToHost(k) });
}

/** Spec req. 8: cheap validity ping per key. */
export async function testKey(keyId: string): Promise<{ ok: boolean; status: number; rateLimited: boolean; message?: string }> {
  const k = registry.getKey(keyId);
  if (!k) throw new Error(`unknown key ${keyId}`);
  const { adapter } = await adapters.forProvider(k.providerId);
  const res = await adapter.pingKey(k.secretRef);
  registry.updateKey(keyId, {
    status: res.ok ? "active" : res.rateLimited ? "cooldown" : "invalid",
    lastTestedAt: Date.now(),
  });
  const fresh = registry.getKey(keyId);
  if (fresh) await invoke("api_key_upsert", { k: keyToHost(fresh) });
  return res;
}

export async function refreshCatalog(providerId: string, signal?: AbortSignal): Promise<number> {
  const n = await catalog.refreshProvider(providerId, signal);
  await invoke("models_cache_replace", {
    providerId,
    rows: catalog.all().filter((m) => m.providerId === providerId).map((m) => ({
      providerId: m.providerId, nativeId: m.nativeId, modality: m.modality,
      contextWindow: m.contextWindow ?? null, fetchedAt: m.fetchedAt,
      // Persisted alongside the row: the catalog is fetched once per 24h, so a launch that
      // only hydrates would otherwise price every request as unknown — and would have no idea
      // what the model can do.
      pricingJson: m.pricing ? JSON.stringify(m.pricing) : null,
      capabilitiesJson:
        m.supportsReasoning === undefined ? null : JSON.stringify({ reasoning: m.supportsReasoning }),
    })),
  });
  catalog.deriveAutoAliases();
  await persistAliases();
  return n;
}

/** The third-party client we keep in sync (WorkBuddy), as the host sees it. */
export interface WorkbuddyStatus {
  published: string[];
  path: string;
  endpoint: string;
  clientPresent: boolean;
}
export interface WorkbuddySyncResult {
  path: string; endpoint: string; models: string[]; updated: number; removed: number;
  note: string | null;
}

export async function workbuddyStatus(): Promise<WorkbuddyStatus> {
  return invoke<WorkbuddyStatus>("workbuddy_status");
}

/**
 * Publish exactly these models to the client and rewrite its config now. Ids are native ids,
 * which is what the client sends and what the router resolves.
 */
export async function workbuddySetModels(models: string[]): Promise<WorkbuddySyncResult> {
  return invoke<WorkbuddySyncResult>("workbuddy_set_models", { models });
}

export function persistRouterSettings(): void {
  void invoke("settings_set", { key: "router", valueJson: JSON.stringify(router.settings) });
}

export function listLedger(): LedgerEntry[] {
  return ledger.query();
}

/** The real egress-backed HttpPort — the onboarding orchestrator probes through it. */
export function getHttpPort() {
  return http;
}

/** Unique slug from a provider name ("My Provider!" -> my-provider, my-provider-2, …). */
export function uniqueSlug(name: string): string {
  const base = name.toLowerCase().replace(/\W+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let slug = base;
  let n = 2;
  while (registry.providerBySlug(slug)) slug = `${base}-${n++}`;
  return slug;
}

/** Wizard step 1: create the provider row as `pending` (allowlisted host-side) so probes
 *  can reach it. Registration of manifest/catalog happens after the contract suite. */
export async function createPendingProvider(name: string, baseUrl: string): Promise<string> {
  const slug = uniqueSlug(name);
  const p = registry.addProvider({
    id: crypto.randomUUID(), slug, name, type: "manifest",
    baseUrl, status: "pending", rotationStrategy: "round_robin",
  });
  await invoke("provider_upsert", { p: providerToHost(p) });
  return p.id;
}

export async function loadRecentLedger(): Promise<HostLedgerRow[]> {
  return invoke<HostLedgerRow[]>("ledger_recent", { limit: 200 });
}

// ---------- P4: context graph ----------

export type { HostContextNode, HostContextEdge } from "./lib/context/engine";

/**
 * Record nodes and edges in one batch. Atomic host-side: a turn is never half-present.
 * Recording is best-effort from the UI's point of view — a graph write must never fail a chat.
 */
export async function recordContext(
  nodes: HostContextNode[],
  edges: HostContextEdge[],
): Promise<void> {
  if (nodes.length === 0 && edges.length === 0) return;
  await invoke("context_record", { nodes, edges });
}

export async function loadContextGraph(limit = 400): Promise<{ nodes: HostContextNode[]; edges: HostContextEdge[] }> {
  return invoke<{ nodes: HostContextNode[]; edges: HostContextEdge[] }>("context_graph", { limit });
}

export async function clearContextGraph(): Promise<void> {
  await invoke("context_clear");
}

// ---------- P5: skills ----------

export interface Skill {
  id: string; slug: string; name: string; description: string; version: string;
  source: string; body: string; enabled: boolean; installed_at: number;
}
export interface ParsedSkill { name: string; description: string; body: string; }

export async function listSkills(): Promise<Skill[]> {
  return invoke<Skill[]>("skills_list");
}

export async function skillsCatalog(): Promise<Skill[]> {
  return invoke<Skill[]>("skills_catalog");
}

export async function installSkill(s: {
  slug: string; name: string; description: string; body: string;
}): Promise<Skill> {
  return invoke<Skill>("skills_install", s);
}

export async function uninstallSkill(slug: string): Promise<void> {
  await invoke("skills_uninstall", { slug });
}

export async function setSkillEnabled(slug: string, enabled: boolean): Promise<void> {
  await invoke("skills_set_enabled", { slug, enabled });
}

/** Parse pasted SKILL.md without installing, so the UI can show exactly what would be added. */
export async function parseSkill(text: string): Promise<ParsedSkill> {
  return invoke<ParsedSkill>("skills_parse", { text });
}

export async function slugifySkill(name: string): Promise<string> {
  return invoke<string>("skills_slugify", { name });
}

// ---------- P6: agent orchestrator ----------

export interface AgentRun {
  id: string; session_id: string | null; model: string; status: string;
  prompt: string | null; iterations: number; tool_calls: number;
  started_at: number; ended_at: number | null; error: string | null;
}
export interface AgentStep {
  seq: number; kind: string; label: string | null;
  detail: string | null; ok: boolean | null; ts: number;
}

export async function listAgentRuns(limit = 50): Promise<AgentRun[]> {
  return invoke<AgentRun[]>("agent_runs_list", { limit });
}

export async function agentRunStart(a: {
  id: string; sessionId: string | null; model: string; prompt: string | null;
}): Promise<void> {
  await invoke("agent_run_start", a);
}

export async function agentStepAppend(a: {
  runId: string; kind: string; label: string | null; detail: string | null; ok: boolean | null;
}): Promise<void> {
  await invoke("agent_step_append", a);
}

export async function agentRunFinish(a: {
  runId: string; status: string; iterations: number; error: string | null;
}): Promise<void> {
  await invoke("agent_run_finish", a);
}

export async function agentRunSteps(runId: string): Promise<AgentStep[]> {
  return invoke<AgentStep[]>("agent_run_steps", { runId });
}

// ---------- P7: memory ----------
// Four layers: L0 raw conversation, L1 atoms, L2 scenarios, L3 core. Storage and BM25 ranking
// live in the host; distillation lives here because the webview owns the gateway client.

export type MemoryLayer = "L0" | "L1" | "L2" | "L3";

export interface Memory {
  id: string;
  layer: MemoryLayer;
  text: string;
  session_id: string | null;
  subject: string | null;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  score?: number;
}

export interface MemoryStats {
  l0: number; l1: number; l2: number; l3: number; total: number; bytes: number;
}

export async function captureMemory(m: {
  layer: MemoryLayer; text: string;
  sessionId?: string | null; subject?: string | null; pinned?: boolean;
}): Promise<Memory> {
  return invoke<Memory>("memory_capture", {
    layer: m.layer, text: m.text,
    sessionId: m.sessionId ?? null, subject: m.subject ?? null, pinned: m.pinned ?? false,
  });
}

export async function captureMemories(
  items: Array<{ layer: MemoryLayer; text: string; sessionId?: string | null; subject?: string | null; pinned?: boolean }>,
): Promise<number> {
  if (items.length === 0) return 0;
  return invoke<number>("memory_capture_batch", { items });
}

/** BM25 recall. `layers` narrows the search; omit it to search all four. */
export async function recallMemories(
  query: string, limit = 8, layers?: MemoryLayer[],
): Promise<Memory[]> {
  return invoke<Memory[]>("memory_recall", { query, limit, layers: layers ?? null });
}

export async function listMemories(layer?: MemoryLayer | null, limit = 200): Promise<Memory[]> {
  return invoke<Memory[]>("memory_list", { layer: layer ?? null, limit });
}

export async function forgetMemory(id: string): Promise<boolean> {
  return invoke<boolean>("memory_forget", { id });
}

export async function setMemoryPinned(id: string, pinned: boolean): Promise<boolean> {
  return invoke<boolean>("memory_set_pinned", { id, pinned });
}

export async function clearMemories(): Promise<void> {
  await invoke("memory_clear");
}

export async function memoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>("memory_stats");
}

// ---------- Phase 6: config export/import + diagnostics (spec req. 14) ----------

/** Full portable snapshot (providers, manifests, aliases, settings, key refs — never secrets). */
export async function exportConfig(): Promise<string> {
  const snap = await invoke<unknown>("config_export");
  return JSON.stringify(snap, null, 2);
}

/**
 * Validate + apply an imported snapshot. The TS validator runs first (friendly errors);
 * the host re-scans and forces providers→draft, keys→invalid so nothing routes until
 * keys are re-entered (audit H7).
 */
export async function importConfig(text: string): Promise<{ providers: number; keys: number }> {
  const { validateImport } = await import("@aiprovider/router-core");
  const report = validateImport(text);
  if (!report.ok) throw new Error(report.errors.join(" · "));
  const applied = await invoke<{ providers: number; keys: number }>("config_import", { raw: JSON.parse(text) });
  await refreshFromHost(); // registry now holds drafts + invalid keys (re-enter-key flow)
  return applied;
}

/** Scrubbed bug-report bundle: ledger + drift events + schema version. No bodies, no secrets. */
export async function getDiagnosticsBundle(): Promise<string> {
  return invoke<string>("diagnostics_bundle");
}

// ── Crash reporting (L0 — local only, no external telemetry) ─────────────────

export interface CrashReport {
  id: string;
  ts: number;
  message: string;
  backtrace: string;
  os: string;
  arch: string;
  app_version: string;
}

export async function getCrashCount(): Promise<number> {
  return invoke<number>("crash_count");
}

export async function listCrashes(): Promise<string[]> {
  return invoke<string[]>("crash_list");
}

export async function readCrash(id: string): Promise<CrashReport | null> {
  return invoke<CrashReport | null>("crash_read", { id });
}

export async function clearCrash(id: string): Promise<boolean> {
  return invoke<boolean>("crash_clear", { id });
}

export async function clearAllCrashes(): Promise<number> {
  return invoke<number>("crash_clear_all");
}

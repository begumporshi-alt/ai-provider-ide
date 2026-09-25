/**
 * Desktop bootstrap: the single place where router-core gets wired to the host.
 * Owns the core instances (registry, catalog, adapters, ledger, router), hydration from
 * SQLite, and write-through persistence — every state-changing action mutates the core AND
 * calls one fixed host command (the invariant-12-safe replacement for a raw StorePort).
 */
import { invoke } from "@tauri-apps/api/core";
import { fetchAdmin } from "./lib/gateway-client";
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
import { noteTrailFailure, type TrailId } from "./lib/trail-health";
import type { HostContextNode, HostContextEdge } from "./lib/context/engine";
import {
  isConclusive,
  verdictFor,
  type KeyVerdict,
  type PingResult,
} from "./lib/keys/verdict";

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
  /** Null when the provider reported no cache block — not the same as a reported zero (0015). */
  cachedTokens: number | null;
}

// ---------- singletons ----------

const vault = createKeyVaultPort();
const http = createHttpPort();

export const registry = new ProviderRegistry(vault);
export const adapters = new AdapterRuntime(http, { appUrl: "https://aiprovider.router" });
export const ledger = new UsageLedger({
  async append(e: LedgerEntry) {
    // `POST /admin/ledger` takes the row itself. The IPC command's `{ e }` wrapper was
    // `toRustArgs`'s doing, not the struct's shape — `LedgerRow` is `rename_all = "camelCase"` with
    // `deny_unknown_fields`, so this body is the same object on both transports and a misspelling
    // is a 4xx rather than a silent `NULL` on either.
    await fetchAdmin("POST", "/admin/ledger", {
      ts: e.ts,
      modality: e.modality,
      source: e.source,
      providerId: e.providerId ?? null,
      keyId: e.keyId ?? null,
      // The gateway app key. `null` for a `ui` or `generator` row, which belongs to no app. This
      // key name must match `LedgerRow::app_key_id` exactly: the Rust payload now carries
      // `deny_unknown_fields`, so a misspelling here is an error rather than a silent `NULL`.
      appKeyId: e.appKeyId ?? null,
      requestedModel: e.requestedModel,
      model: e.model,
      status: e.status,
      httpStatus: e.httpStatus ?? null,
      errorClass: e.errorClass ?? null,
      latencyMs: e.latencyMs ?? null,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      costEstimateMicros: e.costEstimateMicros,
      // `null` when the provider reported no cache block. The ledger column is nullable so the
      // measurement can tell "not reported" apart from "reported zero".
      cachedTokens: e.cachedTokens ?? null,
      fallbackChainJson: e.fallbackChain
        ? JSON.stringify(e.fallbackChain.map((a) => ({
            provider: a.candidate.provider.slug,
            key: a.candidate.key.label,
            cls: a.cls,
          })))
        : null,
    });
  },
});
export const catalog = new ModelCatalog(registry, adapters);
export const router = new ModelRouter(registry, adapters, catalog, ledger);

// ---------- Phase 5: drift detection + repair ----------

/**
 * Issue a trail write, keeping its failure instead of discarding it.
 *
 * Every one of these writes records work that has already happened, so a failure must **not** fail
 * the work: a repair that applied correctly cannot be reported as failed because its record did not
 * land, or the operator would be told to retry a repair that is already live. That is why this
 * returns a boolean rather than throwing, and why the three call sites below still carry on.
 *
 * What it adds is the other half — the failure reaches `trail-health`, and the card that claims its
 * trail is complete renders it. `.catch(() => undefined)` kept the first property and lost the
 * second, which is how a lost row became indistinguishable from a row that was never written.
 *
 * Returns whether the write landed, so a caller that has something specific to say about it can say
 * it: `approveRepair` is the one that does, because "repaired" beside a row still reading "Open" is
 * a contradiction the operator can see on one screen.
 */
async function writeTrail(trail: TrailId, cmd: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    await invoke(cmd, args);
    return true;
  } catch (e) {
    noteTrailFailure(trail, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Record one AI generation in the audit trail.
 *
 * **Two** producers write this trail, and they build the same payload from the same shape: the
 * wizard's candidate generation (`Onboarding.tsx`) and drift repair (`buildRepairPlan` below). Exported
 * and shared rather than written out twice, so the trail id and the command name live in exactly one
 * place.
 *
 * That is not tidiness. The wizard had its own copy of this call, and when the other trail writes were
 * routed through `writeTrail` that copy was missed — so the wizard's audit failures stayed **silent**,
 * on the producer the generation-audit card names first, and the card went on claiming completeness for
 * it. A duplicated call site is a duplicated place to forget.
 */
export async function recordGeneratorAudit(a: {
  modelUsed: string;
  promptChars: number;
  completionChars: number;
  redactionHash: string;
}): Promise<boolean> {
  return writeTrail("generator_audit", "generator_audit_record", {
    e: {
      modelUsed: a.modelUsed,
      promptTokens: Math.round(a.promptChars / 4),
      completionTokens: Math.round(a.completionChars / 4),
      redactionHash: a.redactionHash,
    },
  });
}

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
    void writeTrail("drift", "drift_event_record", { providerId: e.providerId, triggerJson: JSON.stringify(e) });
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
  const entry = { evidence };
  // Registered *before* anything that can fail, for two reasons.
  //
  // `onTrigger` has already set the provider `repairing` by the time it calls this, and the provider
  // card renders "Building a repair plan…" for as long as this map holds no entry for it. So a
  // failure before the entry strands the provider in `repairing` behind a sentence describing work
  // that stopped — and it is the *same* sentence as the legitimate in-progress case, so waiting is
  // indistinguishable from broken.
  //
  // That is reachable, not theoretical: `adapters.forProvider` throws `no active manifest` for a
  // provider hydration could not register — which is what a corrupt manifest body leaves behind
  // (`store.ts:350-357`, whose own comment promises "Phase 5 drift/repair surfaces it"). It sat
  // outside the `try`, so the throw was swallowed by `onTrigger`'s `.catch(() => undefined)` and
  // nothing surfaced it. A provider with no key to probe with returned `undefined` the same silent
  // way, and is now an error too.
  pendingRepairs.set(provider.id, entry);
  try {
    const { adapter } = await adapters.forProvider(provider.id);
    const secretRef = registry.keysOf(provider.id)[0]?.secretRef;
    if (!secretRef) throw new Error(`no key to probe ${provider.name} with`);
    const otherHealthy = registry.listProviders().filter((p) => p.id !== provider.id && p.status === "enabled").length;
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
        await recordGeneratorAudit(a);
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

/**
 * Human confirms the staged repair: stage new manifest version + activate + hot-swap.
 *
 * `resolveRecorded` is false when the repair applied but its drift event could not be closed. It is
 * reported rather than swallowed because the screen shows both halves at once: the modal says
 * "Repaired" while the drift history, one card below, still reads "Open" in red for that same
 * provider — and that is also exactly what a *declined* repair looks like, since "Keep current
 * adapter" never closes the row either. Without this flag the two are indistinguishable, and one of
 * them is a lost record.
 */
export async function approveRepair(
  providerId: string,
): Promise<{ version: number; previous: number | null; resolveRecorded: boolean } | undefined> {
  const entry = pendingRepairs.get(providerId);
  const manifest = entry?.plan?.candidate?.manifest ?? entry?.plan?.deterministic;
  if (!manifest || !entry) return undefined;
  const origin = entry.plan?.candidate ? "ai-patched" : "builtin-template";
  // `POST /admin/manifests/stage` takes the row itself, not the IPC command's `{ m }` wrapper, and
  // answers `{ version }` because the version is computed host-side from the provider's max rather
  // than chosen here.
  const { version } = (await fetchAdmin("POST", "/admin/manifests/stage", {
    id: crypto.randomUUID(), providerId, version: 0, origin,
    bodyJson: JSON.stringify({ ...manifest, provenance: { ...manifest.provenance, origin } }),
    contractResultJson: JSON.stringify(entry.plan?.candidate?.contract ?? null),
    createdAt: Date.now(), isActive: false,
  })) as { version: number };
  const activated = (await fetchAdmin("POST", `/admin/manifests/${providerId}/activate`, {
    version,
  })) as { previousVersion: number | null };
  const previous = activated.previousVersion;
  adapters.register(providerId, manifest); // hot-swap
  await setProviderStatus(providerId, "enabled");
  await refreshCatalog(providerId).catch(() => undefined);
  // Not a bare `await ...catch`: the adapter is already hot-swapped by this point, so a failed close
  // is a fact to report, not an error to raise.
  const resolveRecorded = await writeTrail("drift", "drift_event_resolve", {
    providerId,
    resolution: `repaired v${version}`,
  });
  pendingRepairs.delete(providerId);
  return { version, previous, resolveRecorded };
}

export async function rollbackManifest(providerId: string, version: number): Promise<void> {
  await fetchAdmin("POST", `/admin/manifests/${providerId}/activate`, { version });
  const rows = (await fetchAdmin("GET", "/admin/manifests")) as HostManifestRow[];
  const row = rows.find((r) => r.providerId === providerId);
  if (row) {
    adapters.register(providerId, JSON.parse(row.bodyJson) as AdapterManifest);
  }
}

export async function listManifestHistory(providerId: string): Promise<HostManifestRow[]> {
  // `encodeURIComponent`: the provider id is a path segment here, and a slug with a `/` in it would
  // otherwise address a different route entirely rather than failing.
  return (await fetchAdmin(
    "GET",
    `/admin/manifests/${encodeURIComponent(providerId)}/history`,
  )) as HostManifestRow[];
}

let bootstrapped = false;
let bootInFlight: Promise<void> | null = null;

/**
 * Why the last boot could not reach the gateway, or `null` when it could.
 *
 * A listener that is not running is a state the operator can put the app in deliberately — the
 * Control switch turns it off — so the app has to survive it rather than mistake it for a data
 * fault. See `bootstrap` and `isUnreachable`.
 */
let bootDegraded: string | null = null;

/** The reason the boot degraded, for a surface that wants to say so. */
export function bootDegradedReason(): string | null {
  return bootDegraded;
}

/**
 * A fetch that never reached a listener, as opposed to one that was answered with a refusal.
 *
 * The browser rejects a `fetch()` to a closed port with a `TypeError`. Every other failure on this
 * path arrives as a plain `Error` — an HTTP status, via `fetchAdmin`, or whatever Tauri rejects an
 * `invoke` with. That difference is the whole distinction between "the gateway is not running" and
 * "the store could not be opened", and only the first of the two is survivable.
 */
function isUnreachable(e: unknown): boolean {
  return e instanceof TypeError;
}

/**
 * Load persisted state into the core. Safe to call repeatedly, and **concurrent callers share one
 * boot**.
 *
 * That sharing is load-bearing, not tidiness. React StrictMode mounts the app twice, so `App` calls
 * this twice before either call resolves. While the second call returned early instead, its `then`
 * fired first and marked the app ready with the reads still in flight — so the shell rendered while
 * `bootDegraded` was still `null`, and a gateway that was not running produced an app that said
 * nothing about it. Measured 2026-09-25, which is why `gateway-off.spec.ts` asserts on the notice
 * and not merely on the app having painted.
 *
 * A degraded boot deliberately leaves `bootstrapped` false, so starting the gateway can retry.
 */
export function bootstrap(): Promise<void> {
  if (bootstrapped) return Promise.resolve();
  bootInFlight ??= runBootstrap().finally(() => {
    bootInFlight = null;
  });
  return bootInFlight;
}

async function runBootstrap(): Promise<void> {
  // Every host read is inside this one `try`, including the `router` row. Read later instead, a
  // failure there would escape the degradation below and take the app down with the
  // corrupt-database screen — which is the defect this guard exists to prevent.
  let providers: HostProviderRow[];
  let keys: HostKeyRow[];
  let models: HostModelRow[];
  let manifests: HostManifestRow[];
  let aliases: HostAliasRow[];
  let routerSettings: Record<string, unknown>;
  try {
    [providers, keys, models, manifests, aliases, routerSettings] = await Promise.all([
      fetchAdmin("GET", "/admin/providers") as Promise<HostProviderRow[]>,
      fetchAdmin("GET", "/admin/api-keys") as Promise<HostKeyRow[]>,
      fetchAdmin("GET", "/admin/models-cache") as Promise<HostModelRow[]>,
      fetchAdmin("GET", "/admin/manifests") as Promise<HostManifestRow[]>,
      fetchAdmin("GET", "/admin/aliases") as Promise<HostAliasRow[]>,
      fetchAdmin("GET", "/admin/settings/router") as Promise<Record<string, unknown>>,
    ]);
  } catch (e) {
    // The gateway is a listener this app can start, not a precondition for opening it, so an
    // unreachable surface degrades: the shell renders and `bootDegradedReason` names the cause.
    // Anything else — a refusal, or an `invoke` the host rejected — is a real fault and still
    // fails the boot, which is what keeps a corrupt database reported as one.
    //
    // Measured 2026-09-25, unguarded: "App data could not be opened / TypeError: Failed to fetch",
    // with restore-from-backup advice, for a gateway that was simply not running.
    // `web-test/gateway-off.spec.ts` is the guard.
    if (!isUnreachable(e)) throw e;
    // `bootstrapped` stays false — the reads never happened, so starting the gateway can retry.
    bootDegraded = String(e);
    return;
  }
  bootDegraded = null;

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
  // Hydration is the common case: a launch that only reads the store never calls refreshCatalog,
  // so publishing here is what stops the first request of every session planning against the
  // 8k default.
  void publishModelContext();

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
    // Best-effort, and deliberately the same shape as the call in `refreshStaleCatalogs` below.
    //
    // The alias table is a **derived cache**: it is rebuilt from the catalog whenever it is empty, so
    // a write that does not land costs one re-derivation and nothing else — which is why swallowing
    // it is honest rather than convenient.
    //
    // Unguarded, it made the boot path depend on a listener that is not there on a fresh install
    // (the app only restores its own gateway once it has been enabled at least once). Measured:
    // the app came up as "App data could not be opened / TypeError: Failed to fetch" — a
    // corrupt-database screen, with its restore-from-backup advice, for a gateway that is simply off.
    // `web-test/gateway-off.spec.ts` is the guard.
    await persistAliases().catch(() => undefined);
  }

  // The `router` row, read above with the rest — `/admin/settings` owns the `gateway` row only,
  // which is why the keyed form exists at all. No null case to special-case: a missing row answers
  // `{}`, and assigning an empty object keeps the defaults, which is what the old
  // `if (settingsRaw)` guard did.
  Object.assign(router.settings, routerSettings);

  // Self-heal a stale catalog: a persisted cache can outlive its adapter's modality rules
  // (the 2026-09-16 rawMatch amendment is the case), and `isStale` was never called, so a
  // pre-fix cache would otherwise keep showing wrong classifications until a manual refresh.
  // Rows already fresh are untouched; failures leave the stale rows in place (stale-fallback).
  await refreshStaleCatalogs().catch(() => undefined);

  bootstrapped = true;
}

async function refreshFromHost(): Promise<void> {
  const [providers, keys] = await Promise.all([
    fetchAdmin("GET", "/admin/providers") as Promise<HostProviderRow[]>,
    fetchAdmin("GET", "/admin/api-keys") as Promise<HostKeyRow[]>,
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
  // A bare array, not `{ rows }`. The IPC command took an object because Tauri hands a command one
  // argument bag; `aliases_replace_h` takes `Json<Vec<AliasRow>>` — the same shape
  // `POST /admin/memory/batch` takes, and the one `admin_aliases_replace_*` posts. The HTTP route is
  // the surviving contract, so the spelling that goes is the IPC one.
  //
  // Found by the browser harness: the wrapper made this a 422, and because `persistAliases` runs in
  // the boot path, the app came up with "App data could not be opened" — no screen rendered at all.
  await fetchAdmin("POST", "/admin/aliases", catalog.aliases.map((a) => ({
    alias: a.alias, providerId: a.providerId, nativeModelId: a.nativeModelId, priority: a.priority,
  })));
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
    await fetchAdmin("POST", "/admin/providers", providerToHost(p));
    adapters.register(p.id, input.manifest);
    await fetchAdmin("POST", "/admin/manifests", {
      id: crypto.randomUUID(), providerId: p.id, version: 1, origin: "builtin-template",
      bodyJson: JSON.stringify(input.manifest), contractResultJson: null, createdAt: Date.now(), isActive: true,
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
  if (p) await fetchAdmin("POST", "/admin/providers", providerToHost(p)); // syncs allowlist host-side
}

export async function setProviderRotation(id: string, rotationStrategy: ProviderRecord["rotationStrategy"]): Promise<void> {
  registry.setProviderRotation(id, rotationStrategy);
  const p = registry.getProvider(id);
  if (p) await fetchAdmin("POST", "/admin/providers", providerToHost(p));
}

export async function deleteProvider(id: string): Promise<void> {
  await fetchAdmin("DELETE", `/admin/providers/${id}`); // cascades; host recomputes the allowlist
  adapters.unregister(id);
  await refreshFromHost();
}

/** Add a key: vault write happens inside registry.addKey via the KeyVaultPort (one call). */
export async function addKey(providerId: string, label: string, secret: string): Promise<ApiKeyRecord> {
  const provider = registry.getProvider(providerId);
  const k = await registry.addKey({ providerId, label, secret });
  await fetchAdmin("POST", "/admin/api-keys", keyToHost(k));
  // draft providers aren't host-allowlisted (invariant 3); the first key promotes to
  // pending so Test works immediately.
  if (provider?.status === "draft") await setProviderStatus(providerId, "pending");
  return k;
}

export async function deleteKey(id: string): Promise<void> {
  await fetchAdmin("DELETE", `/admin/api-keys/${id}`); // host removes the keychain entry too (§7)
  await refreshFromHost();
}

export async function setKeyStatus(id: string, status: ApiKeyRecord["status"]): Promise<void> {
  registry.updateKey(id, { status });
  const k = registry.getKey(id);
  if (k) await fetchAdmin("POST", "/admin/api-keys", keyToHost(k));
}

/**
 * Spec req. 8: cheap validity ping per key.
 *
 * Only a conclusive verdict overwrites the stored status. `invalid` removes a key from rotation
 * outright (`HealthTracker.isKeyUsable`), so writing it because the network hiccuped would take a
 * working key out of service — which is what this used to do. `lastTestedAt` is recorded either
 * way, so even an inconclusive test leaves a trace of when it was tried.
 */
export async function testKey(keyId: string): Promise<PingResult & { verdict: KeyVerdict }> {
  const k = registry.getKey(keyId);
  if (!k) throw new Error(`unknown key ${keyId}`);
  const { adapter } = await adapters.forProvider(k.providerId);
  const res = await adapter.pingKey(k.secretRef);
  const verdict = verdictFor(res);
  const patch: Parameters<typeof registry.updateKey>[1] = { lastTestedAt: Date.now() };
  if (isConclusive(verdict)) patch.status = verdict;
  registry.updateKey(keyId, patch);
  const fresh = registry.getKey(keyId);
  if (fresh) await fetchAdmin("POST", "/admin/api-keys", keyToHost(fresh));
  return { ...res, verdict };
}

/**
 * Publish context windows to the host (§3.4).
 *
 * The gateway sizes the injected memory block against the model's window, and Rust cannot see the
 * catalog — it lives here, with provider selection and key handling. Without this the host plans
 * every request against a flat 8k default, which starves recall on a 200k model and is generous on
 * a small one.
 *
 * Qualified keys (`slug/nativeId`) because that is what a client sends in `model`; an unqualified
 * alias simply misses and falls back to the default, which under-injects safely.
 */
export async function publishModelContext(): Promise<number> {
  const rows = catalog
    .all()
    .filter((m) => typeof m.contextWindow === "number" && m.contextWindow > 0)
    .map((m) => {
      const slug = registry.getProvider(m.providerId)?.slug;
      return slug
        ? { model_key: `${slug}/${m.nativeId}`, context_window: m.contextWindow!, chars_per_token: null }
        : null;
    })
    .filter((r): r is { model_key: string; context_window: number; chars_per_token: null } => r !== null);
  if (rows.length === 0) return 0;
  // Best-effort: a budget planned against the default is a worse answer, not a failed refresh.
  return invoke<number>("router_model_context_replace", { rows }).catch(() => 0);
}

/** How many models the gateway can plan a budget against. Zero means every request uses the default. */
export async function modelContextCount(): Promise<number> {
  return invoke<number>("router_model_context_count");
}

export async function refreshCatalog(providerId: string, signal?: AbortSignal): Promise<number> {
  const n = await catalog.refreshProvider(providerId, signal);
  await fetchAdmin("POST", "/admin/models-cache", {
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
  // After the catalog changes, not before: the host's window cache is derived from it, and
  // publishing stale windows would be worse than publishing none.
  void publishModelContext();
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
  // Best-effort by signature, and now a **merge** rather than a whole-row UPSERT: the route merges
  // into the row, so a key another writer added between this call and the write survives. The
  // `catch` is not decoration — nothing awaits this, so a rejection would surface as an unhandled
  // promise rather than anywhere useful.
  void fetchAdmin("POST", "/admin/settings/router", router.settings).catch(() => undefined);
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
  await fetchAdmin("POST", "/admin/providers", providerToHost(p));
  return p.id;
}

export async function loadRecentLedger(): Promise<HostLedgerRow[]> {
  return fetchAdmin("GET", "/admin/ledger?limit=200") as Promise<HostLedgerRow[]>;
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
  await fetchAdmin("POST", "/admin/context", { nodes, edges });
}

export async function loadContextGraph(limit = 400): Promise<{ nodes: HostContextNode[]; edges: HostContextEdge[] }> {
  return fetchAdmin("GET", `/admin/context?limit=${limit}`) as Promise<{ nodes: HostContextNode[]; edges: HostContextEdge[] }>;
}

export async function clearContextGraph(): Promise<void> {
  await fetchAdmin("DELETE", "/admin/context");
}

// ---------- history: sessions and their timelines ----------
// Read-only readings of the same context graph. Field names are snake_case on the wire,
// matching every other host row in this file.

export interface HistorySession {
  session_id: string;
  started_ts: number;
  ended_ts: number;
  /** User and assistant messages only — a tool-heavy run has few turns and many tools. */
  turns: number;
  tool_calls: number;
  preview: string;
  model: string | null;
}

export interface TimelineEntry {
  /** `user` | `assistant` | `tool`. */
  kind: string;
  ts: number;
  text: string;
  /** For a tool entry, the result the sandbox returned. */
  detail: string | null;
  model: string | null;
  /** Memories recalled for this turn, collapsed to a count. */
  memories: number;
}

export interface HistoryTimeline {
  session_id: string;
  entries: TimelineEntry[];
}

export async function loadHistorySessions(limit = 100): Promise<HistorySession[]> {
  return invoke<HistorySession[]>("history_sessions", { limit });
}

export async function loadHistoryTimeline(sessionId: string): Promise<HistoryTimeline> {
  return invoke<HistoryTimeline>("history_timeline", { sessionId });
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

/**
 * Where a memory may be injected. A row with neither a project nor an explicit global mark is
 * capture-only — it will never be injected into a request, no matter which agent asks.
 */
export interface MemoryScope {
  user: string;
  project: string | null;
  agent: string | null;
  global: boolean;
}

export interface Memory {
  id: string;
  layer: MemoryLayer;
  text: string;
  session_id: string | null;
  subject: string | null;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  scope: MemoryScope;
  score?: number;
  /** §6.4.3: when this row was superseded, or null while it is live. Kept, not deleted. */
  superseded_at: number | null;
}

/** §6.4.5: one contradiction a human has to settle. */
export interface MemoryConflict {
  /** The pinned/L3 row — the one surviving on the operator's say-so, not on recency. */
  held: Memory;
  /** A newer live row on the same subject, in the same project, saying something different. */
  newer: Memory;
}

export interface MemoryStats {
  l0: number; l1: number; l2: number; l3: number; total: number; bytes: number;
  /** Rows that can actually be injected. Everything else is capture-only. */
  injectable: number;
}

export async function captureMemory(m: {
  layer: MemoryLayer; text: string;
  sessionId?: string | null; subject?: string | null; pinned?: boolean;
}): Promise<Memory> {
  return fetchAdmin("POST", "/admin/memory", {
    layer: m.layer, text: m.text,
    session_id: m.sessionId ?? null, subject: m.subject ?? null, pinned: m.pinned ?? false,
  }) as Promise<Memory>;
}

/**
 * Batched capture — the path `rememberTurn` uses.
 *
 * The spelling here differs from `captureMemory` above, and that is not an oversight: the two cross
 * different boundaries. `memory_capture`'s fields are **command arguments**, which Tauri renames
 * camelCase→snake on the way in, so `sessionId` is correct there. `items` is a **nested payload**, so
 * serde does the mapping instead — and `MemoryInput` declares `deny_unknown_fields` with snake fields,
 * so a camelCase key here is a hard error rather than a silent null. The two spellings differ because
 * the two boundaries differ.
 */
export async function captureMemories(
  items: Array<{ layer: MemoryLayer; text: string; session_id?: string | null; subject?: string | null; pinned?: boolean }>,
): Promise<number> {
  if (items.length === 0) return 0;
  const res = await fetchAdmin("POST", "/admin/memory/batch", items) as { captured: number };
  return res.captured;
}

/** BM25 recall. `layers` narrows the search; omit it to search all four. */
export async function recallMemories(
  query: string, limit = 8, layers?: MemoryLayer[],
): Promise<Memory[]> {
  return fetchAdmin("POST", "/admin/memory/recall", { query, limit, layers: layers ?? null }) as Promise<Memory[]>;
}

export async function listMemories(layer?: MemoryLayer | null, limit = 200): Promise<Memory[]> {
  const qs = layer ? `?layer=${layer}&limit=${limit}` : `?limit=${limit}`;
  return fetchAdmin("GET", `/admin/memory${qs}`) as Promise<Memory[]>;
}

export async function forgetMemory(id: string): Promise<boolean> {
  const res = await fetchAdmin("DELETE", `/admin/memory/${id}`) as { ok: boolean };
  return res.ok;
}

/**
 * §6.4.3: mark `old` as superseded by `new`. The old row is kept for audit and for a reversal, but
 * it leaves recall immediately.
 *
 * Rejects on a pinned or L3 row — §6.4.5 forbids quietly replacing either.
 */
export async function supersedeMemory(old: string, newId: string): Promise<boolean> {
  const res = await fetchAdmin("POST", "/admin/memory/supersede", { old, new: newId }) as { ok: boolean };
  return res.ok;
}

/** §6.4.3: undo a supersession. The row was never deleted, so this makes it reachable again. */
export async function unsupersedeMemory(id: string): Promise<boolean> {
  const res = await fetchAdmin("POST", `/admin/memory/${id}/unsupersede`) as { ok: boolean };
  return res.ok;
}

/** §6.4.5: what the Memory screen has to put in front of a human. */
export async function memoryConflicts(): Promise<MemoryConflict[]> {
  return fetchAdmin("GET", "/admin/memory/conflicts") as Promise<MemoryConflict[]>;
}

export async function setMemoryPinned(id: string, pinned: boolean): Promise<boolean> {
  const res = await fetchAdmin("POST", `/admin/memory/${id}/pin`, { pinned }) as { ok: boolean };
  return res.ok;
}

/**
 * The project scope the gateway resolves for an incoming request: a hash of the workspace root.
 * The Memory screen needs it to bind a memory to "this project" — the value has to match what the
 * request path computes, so it is fetched from the host rather than recomputed here.
 */
export async function gatewayProjectKey(): Promise<string | null> {
  return invoke<string | null>("gateway_project_key");
}

/**
 * Bind a memory to a scope. This is the only way a row becomes injectable — every memory is born
 * capture-only. `kind` is `project` (optionally narrowed to one agent), `global`, or `unscoped`.
 */
export async function assignMemoryScope(
  id: string,
  scope: { kind: "project"; project: string; agent?: string | null } | { kind: "global" } | { kind: "unscoped" },
): Promise<boolean> {
  const payload =
    scope.kind === "project"
      ? { kind: "project", project: scope.project, agent: scope.agent ?? null }
      : { kind: scope.kind, project: null, agent: null };
  const res = await fetchAdmin("POST", `/admin/memory/${id}/scope`, payload) as { ok: boolean };
  return res.ok;
}

/** Rewrite one memory's text. The layer is left alone — promotion is the caller's call. */
export async function updateMemory(id: string, text: string): Promise<boolean> {
  const res = await fetchAdmin("PUT", `/admin/memory/${id}`, { text }) as { ok: boolean };
  return res.ok;
}

/**
 * One session's memories in one layer, oldest first. Used by scenario distillation, which needs
 * a chronological window rather than the recency-ordered one `listMemories` returns.
 */
export async function sessionMemories(
  sessionId: string, layer: MemoryLayer, limit = 200,
): Promise<Memory[]> {
  return fetchAdmin("GET", `/admin/memory/session/${sessionId}?layer=${layer}&limit=${limit}`) as Promise<Memory[]>;
}

export async function clearMemories(): Promise<void> {
  await fetchAdmin("DELETE", "/admin/memory");
}

export async function memoryStats(): Promise<MemoryStats> {
  return fetchAdmin("GET", "/admin/memory/stats") as Promise<MemoryStats>;
}

// ---------- capture queue (§3.3) ----------

/** One queued exchange, as the host stored it: already scrubbed, already classified, already scoped. */
export interface PendingRow {
  id: number;
  session_id: string | null;
  scope_user: string;
  scope_project: string | null;
  scope_agent: string | null;
  /** `fact` | `preference` | `decision` | `instruction` (§3.5.3). */
  content_class: string;
  user_text: string;
  asst_text: string | null;
  model: string | null;
  attempts: number;
}

export interface QueueStatus {
  queued: number; processing: number; done: number; failed: number; outstanding: number;
  /** §10(2): distillations still available in this rolling hour. Absent on an older host. */
  budget_left?: number;
}

/**
 * Claim a batch for distillation. The rows move to `processing`, so a second drain cannot take
 * them and a crash mid-batch can be recovered by `captureRequeueStale`.
 */
export async function captureClaim(): Promise<PendingRow[]> {
  return invoke<PendingRow[]>("capture_claim");
}

/** Mark a row distilled. Returns false when the row was not in `processing`. */
export async function captureComplete(id: number): Promise<boolean> {
  return invoke<boolean>("capture_complete", { id });
}

/**
 * Give a row back. The host retires it after three attempts rather than retrying forever — a turn
 * that will not distil is not going to start.
 */
export async function captureRelease(id: number): Promise<boolean> {
  return invoke<boolean>("capture_release", { id });
}

/** Put back rows whose claim went stale, i.e. the webview died mid-batch. */
export async function captureRequeueStale(): Promise<number> {
  return invoke<number>("capture_requeue_stale");
}

export async function captureQueueStatus(): Promise<QueueStatus> {
  return invoke<QueueStatus>("capture_queue_status");
}

/** Drop `done`/`failed` rows past retention. Never touches work in flight. */
export async function capturePurgeFinished(): Promise<number> {
  return invoke<number>("capture_purge_finished");
}

/** §6.2: what a prune of the `memories` table removed. */
export interface MemoryPruneStats {
  l0_expired: number;
  l0_ring: number;
  decayed: number;
}

/** §6.2 retention for memories: L0 TTL + per-session ring, L1/L2 decay. Pinned and L3 are exempt. */
export async function pruneMemories(): Promise<MemoryPruneStats> {
  return fetchAdmin("POST", "/admin/memory/prune") as Promise<MemoryPruneStats>;
}

/** Live-context retention: turn ring per session, TTL on turns, TTL on idle sessions. */
export interface LiveContextPruneStats {
  turns_by_count: number;
  turns_by_age: number;
  sessions_reaped: number;
}

export async function pruneLiveContext(): Promise<LiveContextPruneStats> {
  // `POST /admin/context/prune` bounds `live_context`; `POST /admin/memory/prune` above bounds
  // `memories`. Two routes because the retention policies are unrelated.
  return (await fetchAdmin("POST", "/admin/context/prune")) as LiveContextPruneStats;
}

/**
 * One client's memory policy (§4a). `enabled: null` means inherit the master switch; an explicit
 * `true`/`false` overrides it. `last_seen_at` is null for an agent configured before it ever
 * connected.
 */
export interface PrincipalRow {
  principal: string;
  enabled: boolean | null;
  last_seen_at: number | null;
}

export async function memoryPrincipalList(): Promise<PrincipalRow[]> {
  return fetchAdmin("GET", "/admin/memory/principals") as Promise<PrincipalRow[]>;
}

/**
 * Set one principal's policy, or pass `null` to return it to inheriting.
 *
 * The master switch still wins: a principal set to `true` gets nothing while memory is off
 * globally, which is what keeps "off" a single unambiguous act.
 *
 * The route takes the fields flat and answers `{ ok }` — the IPC command wrapped them in a
 * `policy` object because Tauri hands a command one argument bag, which is the shape that went.
 */
export async function setMemoryPrincipal(
  principal: string,
  enabled: boolean | null,
): Promise<boolean> {
  const res = (await fetchAdmin("POST", "/admin/memory/principals", { principal, enabled })) as {
    ok: boolean;
  };
  return res.ok;
}

/**
 * The memory/context layer's master switch. Off by default: no reads, no writes.
 *
 * The switch itself is an `AtomicBool` on `GatewayCore`, so the authority is whichever process
 * serves the listener — not the app's own core, which is what `invoke` reached. In the default
 * install those are the same core; they are not once a separate service serves the port, and the
 * route is what makes the toggle follow the listener in use.
 */
export async function gatewayMemoryEnabled(): Promise<boolean> {
  const res = (await fetchAdmin("GET", "/admin/memory/enabled")) as { enabled: boolean };
  return res.enabled;
}

export async function setGatewayMemoryEnabled(enabled: boolean): Promise<boolean> {
  const res = (await fetchAdmin("POST", "/admin/memory/enabled", { enabled })) as {
    enabled: boolean;
  };
  return res.enabled;
}

// ---------- Control screen: observability + cross-cutting switches ----------

/**
 * `gateway_status`. Defined once and imported by both the Local Gateway screen and Control — two
 * copies of a four-field DTO drift, and then the switchboard lies about the system state.
 */
export interface GatewayStatus {
  /** Operator intent — the gateway is supposed to be serving. 25f made this the whole story: the
   *  bridge is Rust and nothing suspends it, so there is no beat to narrow it against. It used to
   *  be `is_available()`, which also went false when a hidden worker's beat lapsed. */
  running: boolean;
  port: number;
  hasKey: boolean;
  endpointUrl: string;
}

/** Month-to-date spend vs. the cap, both in micro-USD (cap 0 = disabled). */
export interface GatewaySpendStatus {
  monthMicros: number;
  capMicros: number;
  capped: boolean;
}

export async function gatewayStatus(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_status");
}

export async function gatewaySpendStatus(): Promise<GatewaySpendStatus> {
  return fetchAdmin("GET", "/admin/spend") as Promise<GatewaySpendStatus>;
}

/** The login-item service: launchd's word on whether the agent is installed and up. */
export interface ServiceStatus {
  plistPresent: boolean;
  loaded: boolean;
  pid: number | null;
}

export interface ServicePaths {
  plist: string;
  binary: string;
  outLog: string;
  errLog: string;
}

export async function serviceStatus(): Promise<ServiceStatus> {
  return invoke<ServiceStatus>("service_status");
}

export async function serviceInstall(): Promise<ServicePaths> {
  return invoke<ServicePaths>("service_install");
}

export async function serviceUninstall(): Promise<void> {
  return invoke("service_uninstall");
}

/**
 * One request's memory outcome, as reported by `gateway_injection_stats`.
 *
 * Carries scope and counts, **never memory text**: the injected block is already in the prompt, and
 * duplicating it into a diagnostic buffer would add exposure for no diagnostic gain.
 *
 * Field names are camelCase because the Rust DTO carries `rename_all = "camelCase"`
 * (`injection_log.rs`). A Rust spec pins that, because dropping the attribute would break this screen
 * at runtime with no compile error anywhere to warn about it.
 */
export interface InjectionEvent {
  tsMs: number;
  /** The client-visible id (`gw-{n}`) — the string a client quotes when it reports a failure. */
  id: string;
  model: string;
  scope: string;
  injected: boolean;
  items: number;
  /** Live-context turns injected alongside the memory block — a different store from `items`. */
  context: number;
  tokens: number;
  /** `SkipReason::as_str()`. `"injected"` on success, so one map covers both outcomes. */
  reason: string;
}

export interface InjectionStats {
  /** Every request recorded since launch — **not** the ring length. */
  total: number;
  /** Counts by reason, including `injected`. Survives ring eviction. */
  counts: Record<string, number>;
  /** Newest first. Bounded; the counters above are not. */
  recent: InjectionEvent[];
}

/** What the memory layer has done since launch. In-memory, so it resets with the app. */
export async function gatewayInjectionStats(): Promise<InjectionStats> {
  return invoke<InjectionStats>("gateway_injection_stats");
}

/**
 * One line of the gateway's tool audit log (`{app_data_dir}/gateway.log`).
 *
 * `tsMs` is null for a line the host did not stamp. `log_to_file` is called from paths that write
 * bare lines, and those are startup evidence rather than noise, so they are kept and rendered
 * without a time.
 */
export interface GatewayLogLine {
  tsMs: number | null;
  text: string;
}

/**
 * The tail of the tool audit log, oldest line first.
 *
 * The log has been appended to since 2026-09-20 and is never rotated, so the host bounds the read at
 * both ends: at most `limit` lines, taken from the last 128 KB. An absent log answers `[]` rather
 * than failing — a gateway that has never run has nothing to report, and the screen must not show
 * that as an error.
 */
export async function gatewayLogTail(limit?: number): Promise<GatewayLogLine[]> {
  return invoke<GatewayLogLine[]>("gateway_log_tail", { limit: limit ?? null });
}

/**
 * One recorded AI generation — an adapter the assistant wrote for us.
 *
 * The trail exists so "an AI wrote the code that routes my traffic" is answerable: which model, how
 * much text, and a hash of the redacted prompt.
 *
 * Two things this type is deliberately honest about:
 * - **`promptTokens` / `completionTokens` are estimates.** Both producers send `chars / 4`, not a
 *   tokenizer count. The card must label them as estimates rather than presenting a precision that
 *   was never measured.
 * - **There is no session id.** The table has a `session_id` column, but `generator_audit_record`'s
 *   INSERT omits it, so it is NULL on every row and nothing can join a generation back to the
 *   onboarding session that produced it. Adding the field here would be a promise the host cannot keep.
 */
export interface GeneratorAuditEntry {
  id: number;
  tsMs: number;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  redactionHash: string;
}

/**
 * The AI generation trail, newest first.
 *
 * Read on mount and on `tick`, not on demand: Providers is where a generation is *created* — approving a
 * repair writes a row and bumps the tick — so a mount-only read would leave the operator looking at a
 * trail that does not contain what they just approved. An empty table answers `[]`; a missing one cannot
 * happen, since the schema creates it on open.
 */
export async function generatorAuditList(limit?: number): Promise<GeneratorAuditEntry[]> {
  return invoke<GeneratorAuditEntry[]>("generator_audit_list", { limit: limit ?? null });
}

export interface DriftEventEntry {
  id: number;
  providerId: string;
  detectedAt: number;
  /** Raw `DriftEvidence` JSON, as the host recorded it — `{}` when the column was NULL. */
  triggerJson: string;
  /** `null` while the drift is open. Not "unknown": an open event is a live fact about this provider. */
  resolution: string | null;
  resolvedAt: number | null;
}

/**
 * The recorded drift history, newest first.
 *
 * This is the reader the table never had. `drift_events` is written on every detection and every repair,
 * and until now its only reader was the clipboard diagnostics bundle — so the history was visible solely
 * as raw JSON pasted into a bug report. Same shape as `generatorAuditList`, and for the same reason: the
 * two cards sit on one screen and must not disagree about what an empty trail means.
 */
export async function driftEventsList(limit?: number): Promise<DriftEventEntry[]> {
  return invoke<DriftEventEntry[]>("drift_events_list", { limit: limit ?? null });
}

/**
 * Gateway-side tool switches.
 *
 * `toolsEnabled` gates the gateway's sandboxed tool registry entirely; `mutationEnabled` gates only
 * the tools that write or execute (`write_file`, `run_command`). Read-only tools stay available
 * regardless of the second one.
 *
 * Both persist — see `patchGatewaySettings`. Their in-memory state read as incidental, so a reset on
 * every launch looked like a bug rather than a policy.
 */
export async function gatewayToolsEnabled(): Promise<boolean> {
  const res = await fetchAdmin("GET", "/admin/tools") as { enabled: boolean };
  return res.enabled;
}

export async function setGatewayToolsEnabled(enabled: boolean): Promise<void> {
  await fetchAdmin("POST", "/admin/tools", { enabled });
}

export async function gatewayMutationEnabled(): Promise<boolean> {
  const res = await fetchAdmin("GET", "/admin/tools") as { mutationEnabled: boolean };
  return res.mutationEnabled;
}

export async function setGatewayMutationEnabled(enabled: boolean): Promise<void> {
  await fetchAdmin("POST", "/admin/tools", { mutationEnabled: enabled });
}

/**
 * The persisted `gateway` settings row: the listener plus the switch state that has to outlive a
 * restart.
 *
 * Every field is optional because a row written before a field existed simply does not have it. That
 * is the whole compatibility story — there is **no Rust struct** for this object to keep in sync.
 * The startup restore reads it as a `serde_json::Value` and looks keys up by name
 * (`persisted_gateway_port`, `lib.rs:77`), so adding a key is invisible to it and no `serde(default)`
 * is involved. (The design doc originally specified one; that assumed a typed struct that does not
 * exist.)
 */
export interface GatewaySettings {
  port?: number;
  enabled?: boolean;
  toolsEnabled?: boolean;
  mutationEnabled?: boolean;
}

export async function readGatewaySettings(): Promise<GatewaySettings> {
  const raw = await invoke<string | null>("settings_get", { key: "gateway" });
  if (!raw) return {};
  try {
    return JSON.parse(raw) as GatewaySettings;
  } catch {
    return {}; // a corrupt row must not take a screen down
  }
}

/**
 * Merge into the `gateway` settings row. **A merge, never a replace.**
 *
 * That row is one JSON object shared by unrelated concerns — the listener (`port`/`enabled`), the
 * tool switches, and whatever is added next. A writer that serialises only the keys it happens to
 * know about erases the rest, and the loss is invisible until the next launch. Not hypothetical: the
 * Start/Stop handler wrote `JSON.stringify({ port, enabled })`, so adding the tool switches without
 * this helper would have wiped them every time the gateway was restarted.
 */
export async function patchGatewaySettings(patch: GatewaySettings): Promise<GatewaySettings> {
  const next = { ...(await readGatewaySettings()), ...patch };
  await invoke("settings_set", { key: "gateway", valueJson: JSON.stringify(next) });
  return next;
}

/**
 * Push the persisted tool switches back into the gateway core at startup.
 *
 * The core holds them as in-memory atomics, so without this they silently reset to their compiled-in
 * defaults on every launch — and Control would report a state the core is not in, which is precisely
 * the dishonesty §4.5 forbids.
 *
 * Best-effort by design: a failure here must not stop the UI from opening.
 */
export async function applyPersistedGatewaySwitches(): Promise<void> {
  const s = await readGatewaySettings();
  if (typeof s.toolsEnabled === "boolean") await setGatewayToolsEnabled(s.toolsEnabled);
  if (typeof s.mutationEnabled === "boolean") await setGatewayMutationEnabled(s.mutationEnabled);
}

/**
 * The qualified id of the configured system model, or null when none is set.
 *
 * Distillation needs *some* model and must not silently pick one, so the drain and the chat path
 * both resolve it here rather than guessing from the catalog.
 */
export function systemAiModel(): string | null {
  const sa = router.settings.systemAi;
  if (!sa?.model) return null;
  const slug = registry.getProvider(sa.providerId)?.slug;
  return slug ? `${slug}/${sa.model}` : null;
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

/**
 * Structural guards for every host payload the UI reads.
 *
 * Each guard is the runtime twin of an interface in `store.ts`. They live here rather than beside
 * their interfaces only because `store.ts` is already long; the pairing is still one-to-one, and
 * **a change to one is a change to the other** — that is the drift this file exists to make visible.
 *
 * The imports below are `import type`, so nothing here is imported at runtime: `store.ts` imports
 * these guards as values, and a value import back would be a cycle. Types are erased, so this
 * direction is safe.
 *
 * Granularity is deliberate: each guard checks the fields the app actually reads, and ignores
 * anything else the host sends. A host that *adds* a column must not break the UI; a host that
 * renames or retypes one the app consumes must not reach rendering as `undefined`.
 */

import type { CatalogModel } from "@aiprovider/router-core";

import type { HostContextEdge, HostContextNode } from "./context/engine";
import { arrayOf, isBool, isNum, isStr, maybe, nullable, oneOf, shape } from "./host-boundary";
import type {
  GatewaySettings,
  GatewaySpendStatus,
  HostAliasRow,
  HostKeyRow,
  HostLedgerRow,
  HostManifestRow,
  HostModelRow,
  HostProviderRow,
  LiveContextPruneStats,
  Memory,
  MemoryConflict,
  MemoryLayer,
  MemoryPruneStats,
  MemoryScope,
  MemoryStats,
  PrincipalRow,
} from "../store";

// ---------- provider / key / model rows ----------

export const isHostProviderRow = shape<HostProviderRow>({
  id: isStr,
  slug: isStr,
  name: isStr,
  type: nullable(isStr),
  baseUrl: isStr,
  status: isStr,
  rotationStrategy: isStr,
  createdAt: isNum,
  updatedAt: isNum,
});

export const isHostKeyRow = shape<HostKeyRow>({
  id: isStr,
  providerId: isStr,
  label: isStr,
  secretRef: isStr,
  secretHint: nullable(isStr),
  status: isStr,
  priority: isNum,
  cooldownUntil: nullable(isNum),
  addedAt: isNum,
  lastUsedAt: nullable(isNum),
  lastTestedAt: nullable(isNum),
});

export const isHostModelRow = shape<HostModelRow>({
  providerId: isStr,
  nativeId: isStr,
  modality: isStr,
  contextWindow: nullable(isNum),
  fetchedAt: isNum,
  pricingJson: nullable(isStr),
  capabilitiesJson: nullable(isStr),
});

export const isHostManifestRow = shape<HostManifestRow>({
  id: isStr,
  providerId: isStr,
  version: isNum,
  origin: isStr,
  bodyJson: isStr,
  contractResultJson: nullable(isStr),
  createdAt: isNum,
  isActive: isBool,
});

export const isHostAliasRow = shape<HostAliasRow>({
  alias: isStr,
  providerId: isStr,
  nativeModelId: isStr,
  priority: isNum,
});

export const isHostLedgerRow = shape<HostLedgerRow>({
  ts: isNum,
  modality: isStr,
  source: isStr,
  providerId: nullable(isStr),
  keyId: nullable(isStr),
  requestedModel: nullable(isStr),
  model: isStr,
  status: isStr,
  httpStatus: nullable(isNum),
  errorClass: nullable(isStr),
  latencyMs: nullable(isNum),
  tokensIn: isNum,
  tokensOut: isNum,
  costEstimateMicros: isNum,
  fallbackChainJson: nullable(isStr),
  cachedTokens: nullable(isNum),
});

// ---------- the live-context graph ----------

export const isHostContextNode = shape<HostContextNode>({
  id: isStr,
  kind: isStr,
  label: isStr,
  source: isStr,
  session_id: nullable(isStr),
  ts: isNum,
  meta_json: nullable(isStr),
});

export const isHostContextEdge = shape<HostContextEdge>({
  id: isStr,
  from_id: isStr,
  to_id: isStr,
  kind: isStr,
  weight: isNum,
  ts: isNum,
  meta_json: nullable(isStr),
});

/** `GET /admin/context` answers `{ nodes, edges }`, so the envelope is part of the contract. */
export const isContextGraph = shape<{ nodes: HostContextNode[]; edges: HostContextEdge[] }>({
  nodes: arrayOf(isHostContextNode),
  edges: arrayOf(isHostContextEdge),
});

// ---------- memory ----------

export const isMemoryScope = shape<MemoryScope>({
  user: isStr,
  project: nullable(isStr),
  agent: nullable(isStr),
  global: isBool,
});

/**
 * `layer` is checked against the literal union rather than `isStr`: a layer this build has never
 * heard of would otherwise be accepted and then read as a layer that does not exist.
 */
export const isMemory = shape<Memory>({
  id: isStr,
  layer: oneOf<MemoryLayer>("L0", "L1", "L2", "L3"),
  text: isStr,
  session_id: nullable(isStr),
  subject: nullable(isStr),
  created_at: isNum,
  updated_at: isNum,
  pinned: isBool,
  scope: isMemoryScope,
  score: maybe(isNum),
  superseded_at: nullable(isNum),
});

export const isMemoryConflict = shape<MemoryConflict>({ held: isMemory, newer: isMemory });

export const isMemoryStats = shape<MemoryStats>({
  l0: isNum,
  l1: isNum,
  l2: isNum,
  l3: isNum,
  total: isNum,
  bytes: isNum,
  injectable: isNum,
});

export const isMemoryPruneStats = shape<MemoryPruneStats>({
  l0_expired: isNum,
  l0_ring: isNum,
  decayed: isNum,
});

export const isLiveContextPruneStats = shape<LiveContextPruneStats>({
  turns_by_count: isNum,
  turns_by_age: isNum,
  sessions_reaped: isNum,
});

export const isPrincipalRow = shape<PrincipalRow>({
  principal: isStr,
  enabled: nullable(isBool),
  last_seen_at: nullable(isNum),
});

// ---------- gateway ----------

export const isGatewaySpendStatus = shape<GatewaySpendStatus>({
  monthMicros: isNum,
  capMicros: isNum,
  capped: isBool,
});

/**
 * Every field is optional, so this guard accepts `{}` — which is the point. The row is a preference
 * store, and "no settings written yet" is a normal first-run state, not a boundary failure.
 */
export const isGatewaySettings = shape<GatewaySettings>({
  port: maybe(isNum),
  enabled: maybe(isBool),
  toolsEnabled: maybe(isBool),
  mutationEnabled: maybe(isBool),
});

// ---------- small response envelopes ----------

/** `{ ok: boolean }` — what the memory mutations answer with. */
export const isOk = shape<{ ok: boolean }>({ ok: isBool });

/** `{ version: number }` — what `POST /admin/manifests/stage` answers with. */
export const isVersioned = shape<{ version: number }>({ version: isNum });

/** `{ previousVersion: number | null }` — what the manifest-activate route answers with. */
export const isActivation = shape<{ previousVersion: number | null }>({
  previousVersion: nullable(isNum),
});

/** `{ captured: number }` — what `POST /admin/memory/batch` answers with. */
export const isCaptured = shape<{ captured: number }>({ captured: isNum });

/** `{ enabled: boolean }` — the memory master switch, and the tools toggle. */
export const isEnabledFlag = shape<{ enabled: boolean }>({ enabled: isBool });

/** `{ mutationEnabled: boolean }` — the tools mutation toggle. */
export const isMutationFlag = shape<{ mutationEnabled: boolean }>({ mutationEnabled: isBool });

/**
 * A model's modality, checked against the union rather than accepted as any string. A modality this
 * build has never heard of is not silently routed as if it were text — see the boot in `store.ts`.
 */
export const isModality = oneOf<CatalogModel["modality"]>("text", "image");

/**
 * Domain entities shared across router-core (spec §3 domain model). Key rows carry
 * `secretRef` only — never a secret (invariant 1).
 */
import type { KeyStatus, Modality, ProviderLifecycleState } from "@aiprovider/adapter-spec";
import type { PricingMicros } from "./pricing.js";

export interface ProviderRecord {
  id: string;
  slug: string;
  name: string;
  type: "builtin" | "manifest" | "sandbox";
  baseUrl: string;
  status: ProviderLifecycleState;
  rotationStrategy: "round_robin" | "lru" | "priority" | "cost_spread";
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeyRecord {
  id: string;
  providerId: string;
  label: string;
  secretRef: string;
  secretHint?: string; // last 4 chars only
  status: KeyStatus | "cooldown" | "disabled";
  priority: number;
  cooldownUntil: number | null;
  addedAt: number;
  lastUsedAt: number | null;
  lastTestedAt: number | null;
}

export interface CatalogModel {
  providerId: string;
  nativeId: string;
  modality: Modality;
  contextWindow?: number;
  fetchedAt: number;
  /**
   * Normalized provider pricing (audit R2), captured from the provider's raw catalog entry at
   * refresh time. `undefined` = unknown (NOT free) — the UI renders it as "—", not "$0.00".
   */
  pricing?: PricingMicros;
}

export interface AliasEntry {
  alias: string;
  providerId: string;
  nativeModelId: string;
  priority: number;
  /** true = derived by the catalog from cross-provider duplicates; manual entries win (§3.4). */
  auto?: boolean;
}

export function qualifiedId(slug: string, nativeId: string): string {
  return `${slug}/${nativeId}`;
}

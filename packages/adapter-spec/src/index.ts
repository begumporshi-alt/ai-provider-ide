/**
 * @aiprovider/adapter-spec — declarative adapter-manifest grammar (v1.1) and the
 * shared domain types used by router-core and the desktop UI.
 *
 * Phase 0 placeholder: the frozen v1.1 grammar (ARCHITECTURE.md §2.6) is implemented
 * in Phase 1. This module exists so the monorepo graph, CI, and imports resolve.
 */

export const MANIFEST_VERSION = "1.1" as const;

export type Modality = "text" | "image";

export type ProviderLifecycleState =
  | "draft"
  | "pending"
  | "enabled"
  | "disabled"
  | "repairing";

export type KeyStatus = "active" | "rate-limited" | "invalid";

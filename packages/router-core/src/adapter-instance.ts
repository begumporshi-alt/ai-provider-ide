/**
 * AdapterInstance (ARCHITECTURE.md L1/L2 seam): the execution surface every adapter kind —
 * declarative manifest (Tier-1) AND sandboxed code (Tier-2, §2.7) — must implement.
 * Key-blind by contract: every method takes the secretRef explicitly per call (invariant 2),
 * so two concurrent attempts with different keys can never cross secrets, and Tier-2 code
 * never sees credentials at all (the host injects the sentinel auth headers).
 */
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import type { ImageAttemptResult, ModelEntry, TextArgs } from "./manifest-interpreter.js";

export interface AdapterInstance {
  readonly manifest: AdapterManifest;
  capabilities(): { text: boolean; image: boolean };
  tagModality(nativeId: string): "text" | "image";
  listModels(secretRef: string, signal?: AbortSignal): Promise<ModelEntry[]>;
  generateText(secretRef: string, args: TextArgs, signal?: AbortSignal): AsyncGenerator<string>;
  generateImage(
    secretRef: string,
    args: { model: string; prompt: string; size?: string },
    signal?: AbortSignal,
  ): Promise<ImageAttemptResult>;
  pingKey(secretRef: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; rateLimited: boolean; message?: string }>;
  /** Optional teardown — sandbox adapters release their WASM context here. */
  dispose?(): void | Promise<void>;
}

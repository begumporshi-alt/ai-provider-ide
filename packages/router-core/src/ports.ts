/**
 * @aiprovider/router — UI-agnostic Model Router core (ARCHITECTURE.md layers L1–L3).
 *
 * Hard rule (invariant): this package NEVER holds raw API keys and NEVER performs network
 * I/O itself. Everything crosses the ports below, implemented by the host (Tauri Rust) or
 * by fakes in unit tests.
 */

import type { Modality } from "@aiprovider/adapter-spec";

/** One outbound HTTP request/response pair, executed by the host egress gateway. */
export interface HttpPort {
  /** The secret is resolved host-side from secretRef; TS never sees it. */
  request(req: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    secretRef?: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    lines: AsyncIterable<string>;
  }>;
}

/** Keychain access, key-blind: values are opaque refs on the TS side. */
export interface KeyVaultPort {
  put(label: string, secret: string): Promise<string>; // returns secretRef
  get(secretRef: string): Promise<string | undefined>;
  delete(secretRef: string): Promise<void>;
}

/** SQLite persistence behind the store port. */
export interface StorePort {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

export interface TextRequest {
  model: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

export type TextChunk = string;

/**
 * A routed text stream. (Deviation from spec req. 9's literal signature, recorded in
 * DECISIONS.md: chunks are plain strings — the delta wrapper added nothing the UI uses;
 * `TextChunk` is kept as the exported alias for compatibility.)
 */
export interface TextStream {
  chunks: AsyncIterable<TextChunk>;
}

export interface ImageRequest {
  model: string;
  prompt: string;
}

export interface ImageResult {
  url?: string;
  base64?: string;
}

export interface ModelInfo {
  id: string;
  providerId: string;
  modality: Modality;
}

/** The public router facade (spec req. 9). */
export interface RouterFacade {
  generateText(req: TextRequest, opts?: { signal?: AbortSignal }): Promise<TextStream>;
  generateImage(req: ImageRequest, opts?: { signal?: AbortSignal }): Promise<ImageResult>;
  listModels(modality?: Modality): Promise<ModelInfo[]>;
}

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

/**
 * A REAL tool call returned by a provider (OpenAI `tool_calls`), normalized across dialects.
 *
 * Distinct from the in-band pseudo-tokens some models emit as plain text (`<|tool_call_start|>`
 * etc.) — those arrive as ordinary text chunks and are the UI's problem, not the router's.
 * `arguments` is the raw JSON string exactly as the provider built it; parsing it is the
 * caller's job because only the caller knows the schema of its own tools.
 */
export interface ToolCall {
  id?: string;
  name?: string;
  /** JSON text; may be empty when the model calls a tool that takes no arguments. */
  arguments?: string;
  /** The provider's own object, for dialects that carry fields this shape does not model. */
  raw?: unknown;
}

/**
 * One turn in a chat request. Permissive on purpose: the router never interprets these, it
 * forwards them verbatim, and the tool dialects disagree on the extra fields
 * (`tool_call_id` for a result, `tool_calls` on the assistant turn that requested them).
 */
export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Set on role "tool": which call this result answers. */
  tool_call_id?: string;
  /** Set on role "assistant" when the turn requested calls; must be replayed or most
   *  providers reject the following tool result with a 400. */
  tool_calls?: unknown;
};

export interface TextRequest {
  model: string;
  messages: ChatMessage[];
  /** §3.4 compatibility contract: both supported, passed through when the manifest allows. */
  maxTokens?: number;
  temperature?: number;
  /** Tool calling support (§3.4) */
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  /**
   * Side channel for real tool calls. Kept out of `chunks` on purpose: TextChunk is a string
   * (DECISIONS.md), and a tool call is structured, not prose. Without this a tool-calling
   * response streams as an EMPTY transcript, because `delta.content` is null on those chunks.
   */
  onToolCall?: (call: ToolCall) => void;
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

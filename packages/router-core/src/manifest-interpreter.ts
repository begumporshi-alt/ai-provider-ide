/**
 * manifest-interpreter — THE generic adapter (ARCHITECTURE.md L1). Executes any declarative
 * manifest v1.1 against an HttpPort. Key-blind AND stateless w.r.t. credentials: every method
 * takes the `secretRef` explicitly, so two concurrent attempts against the same provider with
 * different keys can never cross secrets (invariant 2). The Rust egress gateway injects the
 * auth headers; this file emits only the header NAMES with a `{{secret}}` sentinel.
 */
import type { AdapterManifest, GenerateImageEndpoint, GenerateTextEndpoint, ListModelsEndpoint } from "@aiprovider/adapter-spec";
import { selectAll, selectOne } from "./jsonpath.js";
import { renderTemplate } from "./template.js";
import { tagModality as tagModalityFrom } from "./modality.js";
import type { AdapterInstance } from "./adapter-instance.js";
import type { ToolCall, UsageTokens } from "./ports.js";

/**
 * Cached-prompt tokens from a usage block, in whichever dialect reports them.
 *
 * OpenAI-shaped blocks nest it as `prompt_tokens_details.cached_tokens`; Anthropic puts
 * `cache_read_input_tokens` at the top level. Returns `undefined` when the block carries neither —
 * and that is the value the ledger needs. "This provider does not report caching" and "this
 * provider reported zero cached tokens" are different findings, and only the second is evidence
 * that caching is unavailable to us.
 */
function readCachedTokens(u: Record<string, unknown>): number | undefined {
  const details = u["prompt_tokens_details"];
  if (details && typeof details === "object") {
    const c = (details as Record<string, unknown>)["cached_tokens"];
    if (typeof c === "number") return c;
  }
  const anthropic = u["cache_read_input_tokens"];
  if (typeof anthropic === "number") return anthropic;
  return undefined;
}

export interface HttpPortLike {
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

export interface AdapterContext {
  http: HttpPortLike;
  /** Extra template values injected by the host (appUrl etc.). */
  vars: Record<string, unknown>;
}

export interface ImageAttemptResult {
  ok: boolean;
  status: number;
  errorBody?: string;
  base64?: string;
  url?: string;
}

export interface ModelEntry {
  nativeId: string;
  raw: unknown;
}

export interface TextArgs {
  model: string;
  messages: unknown[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  /**
   * Reports REAL tool calls (OpenAI `tool_calls`). They cannot ride along in `chunks` — the
   * chunk protocol is strings only — and they cannot be derived from `delta.content`, which is
   * null on tool-call chunks. So they get their own channel.
   */
  onToolCall?: (call: ToolCall) => void;
  /**
   * Token usage callback: fires once at stream end (or on non-stream response) with whatever
   * usage the upstream provider included in the final chunk. Both values may be undefined if the
   * provider never emitted a usage block.
   */
  onUsage?: (usage: UsageTokens) => void;
}

/** Streaming reassembly buffer: `arguments` arrives as fragments, one fragment per chunk. */
interface PendingCall {
  id?: string;
  name?: string;
  args: string;
}

/** Accumulate one chunk's `tool_calls` array into the buffer, keyed by the delta index. */
function collectToolCallDeltas(acc: Map<number, PendingCall>, raw: unknown): void {
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const idx = typeof o.index === "number" ? o.index : 0;
    const cur = acc.get(idx) ?? { args: "" };
    if (typeof o.id === "string" && o.id) cur.id = o.id;
    const fn = o.function;
    if (fn && typeof fn === "object") {
      const f = fn as Record<string, unknown>;
      if (typeof f.name === "string" && f.name) cur.name = f.name;
      if (typeof f.arguments === "string") cur.args += f.arguments;
    }
    acc.set(idx, cur);
  }
}

/** Block types that are tool calls. Anthropic `content` mixes these with `text` blocks. */
const TOOL_BLOCK_TYPES = new Set(["tool_use", "function"]);

/** Normalize a non-stream tool-call array (already complete — no reassembly needed). */
function emitToolCalls(sink: ((call: ToolCall) => void) | undefined, raw: unknown): void {
  if (!sink) return;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // A dialect may hand back a mixed array (anthropic `content` = text + tool_use blocks);
    // only the tool blocks are calls. OpenAI entries carry no `type` and pass through.
    if (typeof o.type === "string" && !TOOL_BLOCK_TYPES.has(o.type)) continue;
    const fn = (typeof o.function === "object" && o.function ? o.function : o) as Record<string, unknown>;
    // OpenAI nests under `function` (arguments as a JSON string); anthropic is flat with
    // `input` (already an object).
    const argsRaw = fn.arguments ?? fn.input;
    sink({
      id: typeof o.id === "string" ? o.id : undefined,
      name: typeof fn.name === "string" ? fn.name : undefined,
      arguments: typeof argsRaw === "string"
        ? argsRaw
        : argsRaw === undefined
          ? undefined
          : JSON.stringify(argsRaw),
      raw: item,
    });
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/** Header names carrying the `{{secret}}` sentinel — Rust replaces the sentinel per header. */
function authHeaders(m: AdapterManifest): Record<string, string> {
  return Object.fromEntries(
    m.provider.auth.headers.map((h) => [h.name, h.prefix ? `${h.prefix} {{secret}}` : "{{secret}}"]),
  );
}

/** Substitute {{placeholder}} inside static header values (§2.6 per-endpoint headers). */
function renderHeaders(headers: Record<string, string> | undefined, vars: Record<string, unknown>): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      const m = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(v);
      const value = m ? String(vars[m[1]!] ?? "") : v;
      return [k, value];
    }),
  );
}

/** Read a header case-insensitively. `HttpPort` returns a plain `Record`, so unlike a real
 *  `Headers` the lookup is case-sensitive — and providers are not consistent about how they
 *  capitalise `Retry-After`. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return undefined;
}

/** Parse a `Retry-After` header into a delay in milliseconds.
 *
 *  RFC 9110 allows either a delay in seconds or an HTTP-date. Anything unreadable is `undefined`
 *  so the caller falls back to its own floor: guessing here would produce a cooldown that is
 *  either uselessly short or absurdly long. */
export function parseRetryAfter(raw: string | undefined, now = Date.now()): number | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** The delay a response asks us to wait, in ms, or undefined when it asks for nothing. */
export function retryAfterFrom(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  return parseRetryAfter(headerValue(headers, "retry-after"), now);
}

export class ManifestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly kind: "response" | "mid-stream" = "response",
    /** What the provider asked us to wait before coming back, when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(`provider HTTP ${status} (${kind}): ${body.slice(0, 400)}`);
  }
}

export class ManifestInterpreter implements AdapterInstance {
  constructor(private readonly m: AdapterManifest, private readonly ctx: AdapterContext) {}

  get manifest(): AdapterManifest {
    return this.m;
  }

  capabilities(): { text: boolean; image: boolean } {
    return this.m.capabilities;
  }

  tagModality(entry: ModelEntry): "text" | "image" {
    return tagModalityFrom(this.m.modalityRules, entry);
  }

  async listModels(secretRef: string, signal?: AbortSignal): Promise<ModelEntry[]> {
    const ep: ListModelsEndpoint | undefined = this.m.endpoints.listModels;
    if (!ep) return [];
    // NOTE: v1.1 declares openai-cursor pagination; the cursor selector is not yet frozen in
    // the grammar, so we fetch the first page now. Phase 3 extends this once the cursor
    // selector is pinned in DECISIONS.md.
    const res = await this.ctx.http.request({
      url: joinUrl(this.m.provider.baseUrl, ep.path),
      method: "GET",
      headers: authHeaders(this.m),
      secretRef,
      signal,
    });
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text(), "response", retryAfterFrom(res.headers));
    const json: unknown = JSON.parse(await res.text());
    const models: ModelEntry[] = [];
    const raws = ep.map.raw ? selectAll(json, ep.map.raw) : [];
    const items = selectAll(json, ep.map.models);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = typeof item === "string" ? item : String((item as Record<string, unknown>)?.id ?? "");
      if (!id) continue;
      // `map.raw` (v1.1) selects the raw model objects alongside the id list; index-aligned,
      // since both selectors walk the same collection. Falls back to the id item itself when
      // absent or misaligned, preserving pre-amendment behavior.
      const raw = raws.length === items.length ? raws[i] : item;
      models.push({ nativeId: id, raw });
    }
    return models;
  }

  async *generateText(
    secretRef: string,
    args: TextArgs,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, void> {
    const ep = this.requireText();
    const body = renderTemplate(ep.requestTemplate, {
      model: args.model,
      messages: args.messages,
      stream: args.stream,
      maxTokens: args.maxTokens ?? this.m.limits?.maxOutputTokens,
      temperature: args.temperature,
      tools: args.tools,
      toolChoice: args.toolChoice,
      responseFormat: args.responseFormat,
      ...this.ctx.vars,
    });
    // OpenAI-shaped servers send no usage on a stream unless asked, and `stream_options` is
    // rejected outright on a non-stream request — so it can only be added here, at send time,
    // where we know which way this particular call is going. Without it the ledger records
    // zero tokens for every streamed completion, and cost (and therefore the spend cap) is
    // permanently 0.
    //
    // The manifest flag decides, but defaults to on for this dialect: providers already stored
    // in the database were generated before the flag existed, and a migration that rewrites
    // user-visible manifests is a heavier instrument than a default. A server that rejects the
    // field can be opted out by setting `requestUsage: false` on its manifest.
    const wantsUsage =
      ep.stream?.requestUsage ?? (this.m.dialect === "openai-chat-v1" && Boolean(ep.responseMap.usage));
    if (args.stream && wantsUsage) {
      body["stream_options"] = { include_usage: true };
    }
    const res = await this.ctx.http.request({
      url: joinUrl(this.m.provider.baseUrl, ep.path),
      method: "POST",
      headers: { ...authHeaders(this.m), "content-type": "application/json", ...renderHeaders(ep.headers, this.ctx.vars) },
      body: JSON.stringify(body),
      secretRef,
      signal,
    });
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text(), "response", retryAfterFrom(res.headers));

    if (!args.stream || !ep.stream) {
      const json: unknown = JSON.parse(await res.text());
      const text = selectOne(json, ep.responseMap.text);
      if (typeof text === "string") yield text;
      if (ep.responseMap.toolCalls) emitToolCalls(args.onToolCall, selectOne(json, ep.responseMap.toolCalls));
      // Non-stream: pick up usage from the response body directly.
      if (args.onUsage && ep.responseMap.usage) {
        const u = selectOne(json, ep.responseMap.usage) as Record<string, unknown> | undefined;
        if (u && typeof u === "object") {
          const pt = u["prompt_tokens"];
          const ct = u["completion_tokens"];
          const cc = readCachedTokens(u);
          // `cc !== undefined` is part of the guard, not an afterthought: a provider that reports
          // ONLY cache fields still has something to record, and dropping the whole callback for
          // want of a `prompt_tokens` would lose the one number this path exists to capture.
          if (typeof pt === "number" || typeof ct === "number" || cc !== undefined) {
            args.onUsage({
              prompt_tokens: typeof pt === "number" ? pt : 0,
              completion_tokens: typeof ct === "number" ? ct : 0,
              cached_tokens: cc,
            });
          }
        }
      }
      return;
    }

    // Reassembled here, flushed once the stream ends: `arguments` is delivered in fragments.
    const pending = new Map<number, PendingCall>();
    const tcs = args.onToolCall ? ep.stream.toolCallStream : undefined;
    const wantToolCalls = Boolean(args.onToolCall && (ep.stream.chunkMap.toolCalls || tcs));
    // Last-seen usage block from the stream. Set by the Rust-side parser or by the provider's
    // own usage chunk (e.g. OpenAI puts it on the final choice; Anthropic puts it on message_delta).
    let lastUsage: Partial<UsageTokens> | undefined;

    // SSE path: `data: {...}` lines through chunkMap / errorMap / finish (§2.6 v1.1).
    // try/finally so the reassembled tool calls are reported on EVERY exit path, including
    // the early `return`s below (stopWhen, finish_reason, [DONE]).
    try {
      for await (const line of res.lines) {
        if (signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        let json: unknown;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ep.stream.errorMap) {
          for (const errPath of Object.keys(ep.stream.errorMap)) {
            const err = selectOne(json, errPath);
            if (err) throw new ManifestHttpError(200, JSON.stringify(err), "mid-stream");
          }
        }
        if (wantToolCalls) {
          if (tcs) {
            // Multi-event framing (anthropic): a start event declares the call, subsequent
            // delta events append argument fragments.
            if (selectOne(json, tcs.start.when.path) === tcs.start.when.equals) {
              const idx = tcs.start.index ? Number(selectOne(json, tcs.start.index) ?? 0) : 0;
              const existing = pending.get(idx) ?? { args: "" };
              const id = tcs.start.id ? selectOne(json, tcs.start.id) : undefined;
              const name = tcs.start.name ? selectOne(json, tcs.start.name) : undefined;
              if (typeof id === "string" && id) existing.id = id;
              if (typeof name === "string" && name) existing.name = name;
              pending.set(idx, existing);
            } else if (selectOne(json, tcs.delta.when.path) === tcs.delta.when.equals) {
              const idx = tcs.delta.index ? Number(selectOne(json, tcs.delta.index) ?? 0) : 0;
              const partial = selectOne(json, tcs.delta.partial);
              const cur = pending.get(idx) ?? { args: "" };
              if (typeof partial === "string") cur.args += partial;
              pending.set(idx, cur);
            }
          } else if (ep.stream.chunkMap.toolCalls) {
            collectToolCallDeltas(pending, selectOne(json, ep.stream.chunkMap.toolCalls));
          }
        }
        const delta = selectOne(json, ep.stream.chunkMap.delta);
        if (typeof delta === "string" && delta) yield delta;
        // Collect usage whenever present on any chunk (OpenAI: on final choice; Anthropic: on message_delta).
        if (ep.responseMap.usage) {
          const chunkUsage = selectOne(json, ep.responseMap.usage) as Record<string, unknown> | undefined;
          if (chunkUsage && typeof chunkUsage === "object") {
            const pt = chunkUsage["prompt_tokens"];
            const ct = chunkUsage["completion_tokens"];
            const cc = readCachedTokens(chunkUsage);
            if (typeof pt === "number" || typeof ct === "number" || cc !== undefined) {
              lastUsage = {
                ...(lastUsage ?? {}),
                prompt_tokens: typeof pt === "number" ? pt : lastUsage?.prompt_tokens,
                completion_tokens: typeof ct === "number" ? ct : lastUsage?.completion_tokens,
                // Only overwrite when this chunk actually carried a cache block. A later chunk
                // that omits it must not erase what an earlier one reported — Anthropic, for
                // instance, puts usage on `message_delta`, not on every chunk.
                cached_tokens: cc !== undefined ? cc : lastUsage?.cached_tokens,
              };
            }
          }
        }
        if (ep.stream.stopWhen && selectOne(json, ep.stream.stopWhen.path) === ep.stream.stopWhen.equals) return;
        const finish = ep.stream.finish ? selectOne(json, ep.stream.finish) : undefined;
        if (typeof finish === "string" && finish !== "null") {
          // When usage is requested, OpenAI-shaped servers put it on a chunk AFTER the one
          // carrying finish_reason — measured against OpenRouter: content, finish_reason,
          // then a final chunk with `usage` and an empty `choices`, then [DONE]. Returning here
          // dropped that trailing chunk, so every streamed request reported zero tokens and
          // cost (and the spend cap) stayed 0 forever. Keep reading when we asked for usage;
          // the trailing chunks carry no delta, so nothing extra is emitted.
          if (!wantsUsage) return;
          continue;
        }
      }
    } finally {
      // Stream over (end of lines, [DONE], stopWhen or finish_reason). A cancelled stream has
      // no complete call to report, so partials are dropped when aborted.
      if (args.onToolCall && !signal?.aborted) {
        for (const c of pending.values()) {
          args.onToolCall({ id: c.id, name: c.name, arguments: c.args });
        }
      }
      // Forward final usage block to the caller (may be undefined if provider omitted it).
      if (args.onUsage && lastUsage && !signal?.aborted) {
        args.onUsage({
          prompt_tokens: lastUsage.prompt_tokens ?? 0,
          completion_tokens: lastUsage.completion_tokens ?? 0,
          cached_tokens: lastUsage.cached_tokens,
        });
      }
    }
  }

  async generateImage(
    secretRef: string,
    args: { model: string; prompt: string; size?: string },
    signal?: AbortSignal,
  ): Promise<ImageAttemptResult> {
    const ep: GenerateImageEndpoint | undefined = this.m.endpoints.generateImage;
    if (!ep) throw new Error("manifest has no generateImage endpoint");
    const body = renderTemplate(ep.requestTemplate, {
      model: args.model,
      prompt: args.prompt,
      size: args.size,
      ...this.ctx.vars,
    });
    const res = await this.ctx.http.request({
      url: joinUrl(this.m.provider.baseUrl, ep.path),
      method: "POST",
      headers: { ...authHeaders(this.m), "content-type": "application/json", ...renderHeaders(ep.headers, this.ctx.vars) },
      body: JSON.stringify(body),
      secretRef,
      signal,
    });
    if (res.status >= 400) return { ok: false, status: res.status, errorBody: await res.text() };
    const json: unknown = JSON.parse(await res.text());
    const b64 = ep.responseMap.imageB64 ? selectOne(json, ep.responseMap.imageB64) : undefined;
    const url = ep.responseMap.imageUrl ? selectOne(json, ep.responseMap.imageUrl) : undefined;
    return {
      ok: true,
      status: res.status,
      base64: typeof b64 === "string" ? b64 : undefined,
      url: typeof url === "string" ? url : undefined,
    };
  }

  /** Cheap validity ping — one model-list call (spec req. 8). */
  async pingKey(secretRef: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; rateLimited: boolean; message?: string }> {
    if (!this.m.endpoints.listModels) return { ok: false, status: 0, rateLimited: false, message: "provider has no listModels endpoint" };
    try {
      await this.listModels(secretRef, signal);
      return { ok: true, status: 200, rateLimited: false };
    } catch (e) {
      const status = e instanceof ManifestHttpError ? e.status : 0;
      const message = e instanceof ManifestHttpError ? `HTTP ${e.status}: ${e.body}` : String((e as Error)?.message ?? e);
      return { ok: false, status, rateLimited: status === 429, message: message.slice(0, 300) };
    }
  }

  private requireText(): GenerateTextEndpoint {
    const ep = this.m.endpoints.generateText;
    if (!ep) throw new Error("manifest has no generateText endpoint");
    return ep;
  }
}

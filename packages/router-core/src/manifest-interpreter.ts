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
import { shapeMessageContent, textOfContent } from "./content-parts.js";

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

/**
 * Parse a `200` body, and when it is not JSON say **what it was** rather than what the parser
 * thought of it.
 *
 * **Measured 2026-09-28, from a live report.** `https://api.hcnsec.cn` — the host with no `/v1` —
 * answers *every* unknown path, `/models` and `/chat/completions` alike, with its marketing SPA at
 * **status 200** and `content-type: text/html`, while `https://api.hcnsec.cn/v1/models` answers
 * `401` JSON. The operator therefore met a bare `SyntaxError` — "JSON Parse error: Unrecognized
 * token '<'" — which names neither the provider, the URL, nor the remedy, for a mistake one path
 * segment long. The second provider on the same machine had the identical shape.
 *
 * **The `status >= 400` guard at every call site cannot catch this**, and that is the whole reason
 * this function exists: the wrong answer arrives as a *success*. Only the body says so.
 */
export function jsonBody(raw: string, url: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // One line, whitespace collapsed, so a multi-line HTML document does not become a paragraph in
    // an error toast.
    const head = raw.slice(0, 80).replace(/\s+/g, " ").trim();
    if (/^\s*</.test(raw)) throw new Error(htmlNotJson(url, head));
    throw new Error(`${url} did not answer with JSON. It began: "${head}"`);
  }
}

/**
 * The single spelling of "this is HTML, you probably meant `/v1`", shared by the parse path and the
 * SSE path. Two spellings of one diagnosis is how the two come to disagree about the remedy.
 */
export function htmlNotJson(url: string, head: string): string {
  return (
    `${url} answered with an HTML page rather than JSON. The base URL is most likely missing its ` +
    `API path — many providers serve the API under "/v1", so try "https://<host>/v1". It began: "${head}"`
  );
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
  /** Finish reason callback: fires once with the dialect's finish_reason, surfaced via the manifest's
   *  `responseFinish` selector. Absent if the provider never emitted one. */
  onFinish?: (reason: string | undefined) => void;
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

/**
 * Block types that carry model **text**. Anthropic's `content` mixes these with `thinking` and
 * tool blocks, and a reasoning model puts its `thinking` block FIRST.
 */
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

/**
 * Read a response's text, allowing the path to point at a **mixed block array** rather than a
 * single scalar.
 *
 * # Why `content[0]` is not enough
 *
 * The anthropic dialect's `content` is an array of blocks, and which block is first is the
 * provider's choice. Measured 2026-09-29 against `agentrouter.org` (`deepseek-v4-flash`, extended
 * thinking on): the response was `content:[{type:"thinking",…},{type:"text",text:"ok"}]` — the
 * thinking block leads, so the template's old `$.content[0].text` resolved to `undefined` and the
 * interpreter yielded **nothing at all**. The request succeeded, the text was present in the body,
 * and the caller received an empty message. A silent empty is the worst available failure: nothing
 * downstream can tell it apart from a model that chose to say nothing.
 *
 * # Why this is a generalisation, not a special case
 *
 * `toolCalls` already points at this same mixed array (`"$.content"`), and `emitToolCalls` selects
 * from it by block type. Text now does the same thing by the field each block carries: a text block
 * has `text`, a thinking block has `thinking`, a tool block has `input`. The two selectors are
 * therefore symmetric, and neither needs a filter expression the JSONPath subset does not have.
 *
 * A scalar path is still returned unchanged, so every non-anthropic manifest is unaffected.
 */
function selectText(json: unknown, path: string): string | undefined {
  return joinTextParts(selectOne(json, path));
}

/** Join a selected value into text — a string as-is, a mixed block array by its text parts. */
function joinTextParts(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  const parts: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // An untyped block with a `text` field is still text (some dialects omit `type`).
    if (typeof o.type === "string" && !TEXT_BLOCK_TYPES.has(o.type)) continue;
    if (typeof o.text === "string") parts.push(o.text);
  }
  return parts.length ? parts.join("") : undefined;
}

/**
 * Substitute `{{model}}` in an endpoint path (Gemini dials `/v1beta/models/{model}:generateContent`).
 *
 * Everything encodeURIComponent encodes is encoded EXCEPT `/`: Gemini's own catalogue names its
 * models `models/gemini-2.0-flash`, and the slash is the path — encoding it would produce
 * `models%2Fgemini-…` and a 404. The ids come from the provider's own catalogue through the
 * manifest's own mapping, and the substitution cannot cross hosts (no scheme or authority is in
 * the substituted segment's reach), so a hostile id can at most redirect a request to another
 * endpoint of the same provider it came from.
 */
function renderPath(path: string, model: string): string {
  // split/join, not replaceAll: this package compiles under the desktop app's older lib target
  return path.split("{{model}}").join(encodeURIComponent(model).split("%2F").join("/"));
}

/**
 * Translate the internal OpenAI role vocabulary to the dialect's own, per the manifest's
 * `messagesRoleMap`. A `null` map value hoists those messages' content into the dialect's system
 * field (declared by `systemField`); a string value remaps the role inline. When the map is absent,
 * messages pass through untouched (the OpenAI dialect).
 *
 * # Why this is declarative, not a code branch
 *
 * The three dialects disagree on message shape in ways no single `if dialect === …` branch
 * captures cleanly, and a fourth dialect would only force another branch. The grammar carries
 * the per-dialect role mapping; the interpreter reads it and applies it — one loop for all dialects,
 * zero branches. A new dialect adds a row to the map and a `systemField` declaration (or omits
 * them for pass-through) and needs no interpreter change.
 */
function normalizeDialectMessages(
  messages: unknown[],
  roleMap: Record<string, string | null> | undefined,
  systemField: string | undefined,
): { messages: unknown[]; systemContent: string | undefined } {
  if (!roleMap) {
    // Pass-through: OpenAI dialect, or a manifest that omits the map.
    return { messages, systemContent: undefined };
  }
  const out: unknown[] = [];
  let systemParts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "user";
    const target = roleMap[role];
    if (target === null) {
      // Hoist: this dialect takes system messages as a top-level param, not in the messages array.
      // `textOfContent`, not `String(...)`: a system message may carry parts, and `String([{…}])`
      // renders `[object Object]` — which would have been sent to the provider as the system prompt.
      const content = textOfContent(m.content);
      if (content) systemParts.push(content);
      continue;
    }
    if (target === undefined) {
      // Role not in the map — pass through verbatim. A dialect that declares a map but omits a
      // role is saying "I speak this role natively too".
      out.push(msg);
      continue;
    }
    const translated: Record<string, unknown> = { ...m, role: target };
    // `tool_call_id` is an OpenAI concept — Anthropic and Gemini model tool results as plain
    // `user` turns and reject the field. Drop it when the role is being translated away from
    // `tool` (i.e. the dialect does not natively carry `tool_call_id`). When the role is pass-
    // through (OpenAI dialect), the field survives.
    if (target !== "tool" && typeof translated.tool_call_id !== "undefined") {
      delete translated.tool_call_id;
    }
    out.push(translated);
  }
  const systemContent = systemParts.length ? systemParts.join("\n\n") : undefined;
  // When the dialect declares neither a map nor a system field, it has no system channel —
  // and hoisted content would be silently lost. Drop it with nothing to receive it.
  if (systemField === undefined) {
    return { messages: out, systemContent: undefined };
  }
  return { messages: out, systemContent };
}

/**
 * Translate an OpenAI-shaped `tool_choice` to the dialect's own form, per the manifest's
 * `toolChoiceMap`. An OpenAI `tool_choice` is one of:
 *   - `"none"`         -> dialect's "don't call tools" sentinel
 *   - `"auto"`         -> dialect's "let the model decide" sentinel
 *   - `{type:"function", function:{name:"fn"}}` -> the dialect's specific-call form
 *
 * The map keys are the OpenAI forms ("none", "auto", "function"). The values are either plain
 * literals (e.g. `{type:"const", value:"any"}`) or template strings containing `{{toolChoice...}}`
 * placeholders that get rendered against the original OpenAI tool_choice — this is how the Anthropic
 * dialect maps the OpenAI function name into `{type:"tool", name:"<fn>"}`.
 *
 * A `null` value means "omit tool_choice entirely for this form". When the manifest omits
 * `toolChoiceMap`, `toolChoice` passes through untouched (the OpenAI dialect, whose shapes are
 * already identical).
 */
function translateToolChoice(
  toolChoice: unknown,
  toolChoiceMap: Record<string, unknown> | undefined,
): unknown {
  if (!toolChoiceMap) return toolChoice;
  if (toolChoice === undefined || toolChoice === null) return undefined;
  // String forms ("none" / "auto") are the common case — look them up by their literal value.
  if (typeof toolChoice === "string") {
    const mapped = toolChoiceMap[toolChoice];
    if (mapped === undefined) return undefined; // not in the map → drop it (omit)
    return renderToolChoiceTemplate(mapped, toolChoice);
  }
  // Object form ({type:"function", function:{name:"fn"}}) — keyed by `type`.
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const o = toolChoice as Record<string, unknown>;
    const t = typeof o.type === "string" ? o.type : "";
    const mapped = toolChoiceMap[t];
    if (mapped === undefined) return undefined;
    return renderToolChoiceTemplate(mapped, o);
  }
  return undefined;
}

/**
 * Render a `toolChoiceMap` value: if it's a string template containing `{{toolChoice.*}}`
 * placeholders, substitute against the source OpenAI tool_choice. Otherwise return the
 * literal value as-is. Handles nested objects (e.g. `{type:"tool", name:"{{toolChoice.function.name}}"}`).
 */
function renderToolChoiceTemplate(mapped: unknown, source: unknown): unknown {
  if (typeof mapped !== "string") {
    if (mapped !== null && typeof mapped === "object") {
      // Recursively resolve placeholders inside nested objects/arrays.
      const o = mapped as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        out[k] = renderToolChoiceTemplate(v, source);
      }
      return out;
    }
    return mapped;
  }
  // Resolve `{{toolChoice.<path>}}` placeholders against the source tool_choice.
  const PLACEHOLDER = /^\{\{\s*toolChoice\.([A-Za-z0-9_.]+)\s*\}\}$/;
  const m = PLACEHOLDER.exec(mapped);
  if (!m) return mapped; // not a toolChoice template — treat as literal
  const val = selectOne(source, "$." + m[1]);
  if (val === undefined || val === null) return undefined;
  return val;
}

/**
 * Read a usage block with dialect-specific field names.
 *
 * The field names were hardcoded OpenAI-style, so Gemini's `usageMetadata`
 * (`promptTokenCount` / `candidatesTokenCount`) reported zero tokens forever — silently zeroing
 * cost and defeating any spend cap. A manifest without `usageKeys` keeps the OpenAI names.
 */
function usageOf(
  u: Record<string, unknown>,
  keys?: { prompt: string; completion: string; cached?: string },
): { pt?: number; ct?: number; cc?: number } {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const pt = num(u[keys?.prompt ?? "prompt_tokens"]);
  const ct = num(u[keys?.completion ?? "completion_tokens"]);
  const cc = keys?.cached ? num(u[keys.cached]) : readCachedTokens(u);
  return { pt, ct, cc };
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
    const url = joinUrl(this.m.provider.baseUrl, ep.path);
    const res = await this.ctx.http.request({
      url,
      method: "GET",
      // Auth headers, then the endpoint's own static headers — the same order and the same merge
      // as `generateText` (`:338`). No `content-type`: this GET carries no body, and the catalogue
      // call has never sent one.
      //
      // The per-endpoint map is what lets a client-identity gate be satisfied. `agentrouter.org`
      // answers `401 unauthorized_client_error` on `GET /v1/models` for any unrecognised
      // `User-Agent` *before* it reads the key, and this is the call every ping, probe and catalog
      // refresh makes — so without it the provider is unreachable even when text generation is
      // configured correctly.
      headers: { ...authHeaders(this.m), ...renderHeaders(ep.headers, this.ctx.vars) },
      secretRef,
      signal,
    });
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text(), "response", retryAfterFrom(res.headers));
    const json: unknown = jsonBody(await res.text(), url);
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
    // v1.1 amendment (2026-09-30): normalize the OpenAI-shaped request into the dialect's own
    // message and tool_choice shapes before rendering the template. The manifest declares how its
    // dialect speaks via `messagesRoleMap` (role remapping + system hoisting) and `toolChoiceMap`
    // (string/function → dialect form); when either is absent, the corresponding values pass through
    // untouched. One loop for all dialects, zero branches in the interpreter.
    const { messages, systemContent } = normalizeDialectMessages(
      args.messages,
      ep.messagesRoleMap,
      ep.systemField,
    );
    // v1.1 amendment (2026-10-01): render any content-part arrays into this dialect's own shapes.
    // Applied AFTER role normalization (a hoisted system message is text by then) and before the
    // body template, because `{{messages}}` is a whole-structure substitution: whatever parts
    // survive to here are what the provider receives. A manifest that declares no templates leaves
    // the parts untouched — see `renderContentParts`.
    const dialectMessages = shapeMessageContent(
      messages,
      ep.contentPartTemplates,
      ep.contentField,
      renderTemplate,
    );
    const templateValues: Record<string, unknown> = {
      model: args.model,
      messages: dialectMessages,
      stream: args.stream,
      maxTokens: args.maxTokens ?? this.m.limits?.maxOutputTokens,
      temperature: args.temperature,
      tools: args.tools,
      toolChoice: translateToolChoice(args.toolChoice, ep.toolChoiceMap),
      responseFormat: args.responseFormat,
      ...this.ctx.vars,
    };
    // Hoisted system content lands in the dialect's system field (declared by `systemField`).
    // When the dialect declared a system field, the template will have a `{{system?}}` placeholder;
    // when it didn't, `systemContent` is undefined and the template field (if any) is omitted.
    if (systemContent !== undefined) {
      templateValues.system = systemContent;
    }
    const body = renderTemplate(ep.requestTemplate, templateValues);
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
    // A dialect may stream at a different endpoint than it dials unarily (Gemini:
    // `:generateContent` vs `:streamGenerateContent?alt=sse`).
    const dialedPath = args.stream && ep.streamPath ? ep.streamPath : ep.path;
    const url = joinUrl(this.m.provider.baseUrl, renderPath(dialedPath, args.model));
    const res = await this.ctx.http.request({
      url,
      method: "POST",
      headers: { ...authHeaders(this.m), "content-type": "application/json", ...renderHeaders(ep.headers, this.ctx.vars) },
      body: JSON.stringify(body),
      secretRef,
      signal,
    });
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text(), "response", retryAfterFrom(res.headers));

    if (!args.stream || !ep.stream) {
      const json: unknown = jsonBody(await res.text(), url);
      const text = selectText(json, ep.responseMap.text);
      if (typeof text === "string") yield text;
      if (ep.responseMap.toolCalls) emitToolCalls(args.onToolCall, selectOne(json, ep.responseMap.toolCalls));
      // Non-stream: pick up usage from the response body directly.
      if (args.onUsage && ep.responseMap.usage) {
        const u = selectOne(json, ep.responseMap.usage) as Record<string, unknown> | undefined;
        if (u && typeof u === "object") {
          const { pt, ct, cc } = usageOf(u, ep.responseMap.usageKeys);
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
      // Non-stream: surface finish reason via `responseFinish` selector (v1.1 amendment).
      if (args.onFinish && ep.responseFinish) {
        const fr = selectOne(json, ep.responseFinish);
        args.onFinish(typeof fr === "string" && fr && fr !== "null" ? fr : undefined);
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
    // The finish reason (stop/length/tool_calls/etc.), surfaced via `responseFinish` selector.
    // For Anthropic this maps from `stop_reason` via the manifest's `responseFinish` selector.
    let finishReason: string | undefined;

    // SSE path: `data: {...}` lines through chunkMap / errorMap / finish (§2.6 v1.1).
    // try/finally so the reassembled tool calls are reported on EVERY exit path, including
    // the early `return`s below (stopWhen, finish_reason, [DONE]).
    try {
      // **A body that is not SSE at all yields no `data:` lines, so the loop below skips every one
      // and the generator ends having said nothing.** The caller then reports "answered with an
      // empty response — the request succeeded but no content came back", which asserts a success
      // that did not happen: measured 2026-09-28, the "answer" was the provider's HTML SPA at status
      // 200. The first non-empty line is enough to tell the two apart — SSE opens with `data:`, an
      // event name or a comment, and HTML opens with `<`.
      let sawFirstLine = false;
      for await (const line of res.lines) {
        if (signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!sawFirstLine) {
          sawFirstLine = true;
          if (trimmed.startsWith("<")) throw new Error(htmlNotJson(url, trimmed.slice(0, 80)));
        }
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
        // A chunk delta may be a block ARRAY, not a string (Gemini's parts): join it the same
        // way the unary path does, or a dialect whose delta is structured yields nothing.
        const delta = joinTextParts(selectOne(json, ep.stream.chunkMap.delta));
        if (delta) yield delta;
        // Collect usage whenever present on any chunk (OpenAI: on final choice; Anthropic: on message_delta).
        if (ep.responseMap.usage) {
          const chunkUsage = selectOne(json, ep.responseMap.usage) as Record<string, unknown> | undefined;
          if (chunkUsage && typeof chunkUsage === "object") {
            const { pt, ct, cc } = usageOf(chunkUsage, ep.responseMap.usageKeys);
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
        // Collect the finish reason from the dialect's `responseFinish` selector — the same
        // selector is used on both non-stream and stream paths. MUST come before the stopWhen /
        // early-return checks: a chunk carrying finish_reason may also trigger stopWhen, and
        // returning before collecting would drop the reason.
        if (ep.responseFinish) {
          const fr = selectOne(json, ep.responseFinish);
          if (typeof fr === "string" && fr && fr !== "null") finishReason = fr;
        }
        if (ep.stream.stopWhen && selectOne(json, ep.stream.stopWhen.path) === ep.stream.stopWhen.equals) return;
        const finish = ep.stream.finish ? selectOne(json, ep.stream.finish) : undefined;
        // The `stream.finish` selector doubles as a finish-reason source: it may point at a
        // different path than `responseFinish` (Anthropic nests `stop_reason` under `delta`
        // in streaming, vs top-level in the non-stream body), so capture it here too.
        if (typeof finish === "string" && finish && finish !== "null") finishReason = finish;
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
      // Forward finish reason (v1.1 `responseFinish` surfacing). Absent when the provider
      // never emitted one or the abort flag is set — a cancelled stream has no finish reason.
      if (args.onFinish && !signal?.aborted) {
        args.onFinish(finishReason);
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
    // `endpointUrl`, not `url`: line below binds `url` to the provider's returned imageUrl.
    const endpointUrl = joinUrl(this.m.provider.baseUrl, renderPath(ep.path, args.model));
    const res = await this.ctx.http.request({
      url: endpointUrl,
      method: "POST",
      headers: { ...authHeaders(this.m), "content-type": "application/json", ...renderHeaders(ep.headers, this.ctx.vars) },
      body: JSON.stringify(body),
      secretRef,
      signal,
    });
    if (res.status >= 400) return { ok: false, status: res.status, errorBody: await res.text() };
    const json: unknown = jsonBody(await res.text(), endpointUrl);
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

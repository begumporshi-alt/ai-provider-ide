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

export class ManifestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly kind: "response" | "mid-stream" = "response",
  ) {
    super(`provider HTTP ${status} (${kind}): ${body.slice(0, 400)}`);
  }
}

export class ManifestInterpreter {
  constructor(private readonly m: AdapterManifest, private readonly ctx: AdapterContext) {}

  get manifest(): AdapterManifest {
    return this.m;
  }

  capabilities(): { text: boolean; image: boolean } {
    return this.m.capabilities;
  }

  tagModality(nativeId: string): "text" | "image" {
    const rules = this.m.modalityRules;
    if (rules?.image && new RegExp(rules.image.modelIdPattern).test(nativeId)) return "image";
    return "text";
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
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text());
    const json: unknown = JSON.parse(await res.text());
    const models: ModelEntry[] = [];
    for (const raw of selectAll(json, ep.map.models)) {
      const id = typeof raw === "string" ? raw : String((raw as Record<string, unknown>)?.id ?? "");
      if (id) models.push({ nativeId: id, raw });
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
    if (res.status >= 400) throw new ManifestHttpError(res.status, await res.text());

    if (!args.stream || !ep.stream) {
      const json: unknown = JSON.parse(await res.text());
      const text = selectOne(json, ep.responseMap.text);
      if (typeof text === "string") yield text;
      return;
    }

    // SSE path: `data: {...}` lines through chunkMap / errorMap / finish (§2.6 v1.1).
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
      const delta = selectOne(json, ep.stream.chunkMap.delta);
      if (typeof delta === "string" && delta) yield delta;
      if (ep.stream.stopWhen && selectOne(json, ep.stream.stopWhen.path) === ep.stream.stopWhen.equals) return;
      const finish = ep.stream.finish ? selectOne(json, ep.stream.finish) : undefined;
      if (typeof finish === "string" && finish !== "null") return;
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

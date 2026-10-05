/**
 * gateway-turn — the Assistant's generate port, served by the gateway engine (A1 Phase 1).
 *
 * Until this module existed, the Assistant ran the TypeScript engine (`store.ts`'s
 * `router.generateText`) while every external client — ZCode, Claude Code — ran the Rust
 * gateway. Two serving paths, two agent loops, two stream parsers, one drift register entry
 * (D95) documenting the gap between them. This module makes the Assistant a client of the same
 * gateway those clients use: same ingress, same admission control, same ledger writer, same
 * failover, same usage accounting. The IDE becomes the router's flagship client — the thing
 * that exercises the serving path every day.
 *
 * **The port contract is the TS engine's `exec` shape** (`chunks` async iterable, `reasoning()`),
 * so `Assistant.tsx` and `runAgentLoop` swap their `generate` implementation without changing
 * how they consume it. Tool calls ride the gateway's pass-through mode: the model's calls come
 * back as OpenAI `tool_calls`, the loop executes them host-side and continues — identical to
 * how Claude Code drives the same endpoint.
 *
 * **Deliberate semantics, kept from the TS path:**
 * - `AIP-Memory: off` — the Assistant does its own recall in the webview and builds its own
 *   memory blocks; without this header a host-side memory toggle would inject a *second* block
 *   and record the turns the webview already decided about.
 * - Errors are never cached and never retried here beyond the 401 re-mint: a failed completion
 *   surfaces to the user, who decides whether to retry.
 */
import { clearUiSession, gatewayBaseUrl, uiSessionKey } from "./gateway-client";

/** The subset of the loop's ToolCall the wire carries (ids come from the gateway). */
export interface GatewayToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export interface GatewayGenerateRequest {
  model: string;
  messages: unknown[];
  /** OpenAI tool declarations; the agent loop builds these from its registry. */
  tools?: unknown;
  toolChoice?: unknown;
  temperature?: number;
  maxTokens?: number;
  /** The thinking knob's level; the bridge reads `reasoning_effort` off the OpenAI body. */
  reasoning?: string;
  onToolCall?: (call: GatewayToolCall) => void;
  onFinish?: (reason?: string) => void;
  onReasoning?: (text: string) => void;
  /** UsageTokens-compatible counts (the wire reports none, so `cached_tokens` stays unset). */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
}

/** Serving attribution, when the wire carries it (`served_by` on the terminal chunk). */
export interface ServedBy {
  provider?: string;
  model?: string;
  key?: string;
}

/** The TS engine's exec shape — what `runAgentLoop` and the chat turn consume. */
export interface GatewayExec {
  chunks: AsyncIterable<string>;
  /** Everything the reasoning channel carried, for the NO_OUTPUT classification. */
  reasoning: () => string;
  /** Which provider/key/model actually served the turn, when the wire reports it. */
  served: () => ServedBy | undefined;
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    served_by?: ServedBy;
  }>;
  error?: { message?: string };
}

/**
 * One Assistant model call, over the gateway. Always streams — one code path for chat, the
 * agent loop, and the summarizer, and the caller sees progress on every turn.
 */
export async function gatewayGenerate(
  req: GatewayGenerateRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<GatewayExec> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;
  if (req.reasoning) body.reasoning_effort = req.reasoning;

  let res = await gatewayPost(
    "/v1/chat/completions",
    body,
    // The Assistant does its own recall (TS memory engine); gateway-side injection would add a
    // second memory block and record turns the webview already governs.
    { "AIP-Memory": "off" },
    opts.signal,
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`the gateway refused the turn (${res.status}): ${detail.slice(0, 400)}`);
  }
  if (!res.body) {
    throw new Error("the gateway returned a response with no body");
  }

  let reasoningAll = "";
  let served: ServedBy | undefined;
  const handlers = {
    onToolCall: req.onToolCall,
    onFinish: req.onFinish,
    onReasoning: (t: string) => {
      reasoningAll += t;
      req.onReasoning?.(t);
    },
    onUsage: req.onUsage
      ? (u: { prompt_tokens?: number; completion_tokens?: number }) =>
          req.onUsage!({
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
          })
      : undefined,
  };

  const chunks = consumeSse(res.body, {
    ...handlers,
    onServed: (s) => {
      served = s;
    },
  }, opts.signal);
  return { chunks, reasoning: () => reasoningAll, served: () => served };
}

/**
 * One image generation, over the gateway's OpenAI-shaped `/v1/images/generations`. The
 * response is normalized to what the Image tab consumes: `url` (a provider/CDN link) or
 * `base64` (the bytes), exactly one of which the gateway's image path produces.
 */
export async function gatewayGenerateImage(
  req: { model: string; prompt: string },
  opts: { signal?: AbortSignal } = {},
): Promise<{ url?: string; base64?: string }> {
  const res = await gatewayPost("/v1/images/generations", { model: req.model, prompt: req.prompt }, {}, opts.signal);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`the gateway refused the image (${res.status}): ${detail.slice(0, 400)}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const first = body.data?.[0] ?? {};
  return { url: first.url, base64: first.b64_json };
}

/**
 * The wizard/repair AI port (`AiTextPort.complete`, A1 Phase 3), backed by the gateway and
 * routed at the **System AI model** — the same model `ModelRouter.complete` used to pick, so
 * `excludeProviderIds` is deliberately not expressible here: naming the System AI model IS the
 * exclusion, because the planner routes to that model's own provider. The port throws when no
 * System AI model is configured, which is what `systemAiAvailable()` gates on.
 */
export function gatewaySystemAiPort(getModel: () => string | undefined): {
  complete(req: {
    prompt: string;
    system?: string;
    maxTokens: number;
    timeoutMs: number;
    excludeProviderIds: string[];
  }): Promise<string>;
} {
  return {
    async complete(req) {
      const model = getModel();
      if (!model) {
        throw new Error("no System AI model is configured — pick one in Router Settings");
      }
      const messages: unknown[] = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.prompt },
      ];
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), Math.max(req.timeoutMs, 1_000));
      try {
        const exec = await gatewayGenerate(
          { model, messages, maxTokens: req.maxTokens },
          { signal: ac.signal },
        );
        let out = "";
        for await (const chunk of exec.chunks) out += chunk;
        return out;
      } finally {
        window.clearTimeout(timer);
      }
    },
  };
}

function gatewayDown(e: unknown): Error {
  if (e instanceof DOMException && e.name === "AbortError") return e;
  return new Error(
    "the gateway is not reachable — start it on the Local Gateway screen (or run the " +
      `aiproviderd service). Underlying error: ${e instanceof Error ? e.message : String(e)}`,
  );
}

/**
 * POST one JSON body to the gateway with the UI session credential, re-minting once on 401 —
 * the S2 TTL may have rotated the credential under us, and the same self-healing the admin
 * client does applies here. `AIP-Memory: off` accompanies completions' bodies that carry it;
 * the header is per-call so images (which have no memory semantics) stay clean.
 */
async function gatewayPost(
  path: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const post = async (): Promise<Response> => {
    const [base, key] = await Promise.all([gatewayBaseUrl(), uiSessionKey()]);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal,
    });
  };
  let res = await post().catch((e: unknown) => {
    throw gatewayDown(e);
  });
  if (res.status === 401) {
    clearUiSession();
    res = await post().catch((e: unknown) => {
      throw gatewayDown(e);
    });
  }
  return res;
}

/**
 * Consume the OpenAI-shaped SSE stream, translating wire frames into the port's callbacks and
 * yielding answer-text chunks. The wire shapes consumed here are the ones the gateway's own
 * Rust tests pin: answer text and `reasoning_content` ride `delta`, tool calls arrive as
 * complete OpenAI objects in one frame, and the terminal chunk carries `finish_reason` beside
 * `usage` (audit 2026-10-03 M2). An `error` frame is a failed turn: throw with its message.
 */
async function* consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onToolCall?: (call: GatewayToolCall) => void;
    onFinish?: (reason?: string) => void;
    onReasoning: (t: string) => void;
    onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number }) => void;
    onServed?: (s: ServedBy) => void;
  },
  _signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const handleFrame = (frame: string): string | undefined => {
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return undefined;
      let evt: WireChunk;
      try {
        evt = JSON.parse(data) as WireChunk;
      } catch {
        continue; // keep-alives and partial frames are not wire events
      }
      if (evt.error) {
        throw new Error(evt.error.message || "the gateway reported an upstream error");
      }
      const choice = evt.choices?.[0];
      const delta = choice?.delta ?? {};
      if (delta.reasoning_content) handlers.onReasoning(delta.reasoning_content);
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          handlers.onToolCall?.({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments ?? "",
          });
        }
      }
      if (choice?.usage) handlers.onUsage?.(choice.usage);
      if (choice?.served_by) handlers.onServed?.(choice.served_by);
      if (choice?.finish_reason) handlers.onFinish?.(choice.finish_reason);
      if (delta.content) return delta.content;
    }
    return undefined;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const text = handleFrame(frame);
      if (text !== undefined) yield text;
      boundary = buffered.indexOf("\n\n");
    }
  }
  // A tail without the terminating blank line still gets its frame: a provider that closed
  // early must not silently swallow the last chunk.
  if (buffered.trim().length > 0) {
    const text = handleFrame(buffered);
    if (text !== undefined) yield text;
  }
}

/**
 * Gateway bridge (webview side): answers the Rust gateway's routed requests using the
 * router core, streams chunks back through the gateway_* commands, and aborts on cancel
 * events (§3.5). Ledger source is "gateway" (criterion 10 attribution).
 *
 * Phase 2 enhancement: raw upstream SSE is parsed by gateway-sse-parser.ts which
 * reassembles tool calls from delta fragments and emits structured tool_calls
 * via gateway_tool_calls, unblocking WorkBuddy/Claude Code/Codex from receiving
 * real tool calls instead of mercury-2.5 pseudo-markup.
 *
 * The master key never appears here — auth happened in Rust before this file ever runs
 * (invariants 10, 14).
 */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { router } from "./store";
import { normalizeGatewayRequest, detectClient } from "@aiprovider/router";
import type { LedgerSource, ToolCall } from "@aiprovider/router";

interface BridgeRequest {
  requestId: number;
  kind: "chat" | "responses" | "models" | "image";
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const active = new Map<number, AbortController>();

let started = false;

export async function startGatewayBridge(): Promise<void> {
  // React StrictMode double-invokes effects in dev; without this guard every gateway
  // request would be routed twice (duplicated chunks + duplicated ledger rows).
  if (started) return;
  started = true;
  await listen<BridgeRequest>("gateway-request", (event) => {
    void handle(event.payload);
  });
  await listen<{ requestId: number }>("gateway-cancel", (event) => {
    active.get(event.payload.requestId)?.abort();
    active.delete(event.payload.requestId);
  });
  // Liveness heartbeat: proves the router core answers (§3.5 availability).
  window.setInterval(() => {
    void invoke("gateway_heartbeat").catch(() => undefined);
  }, 2000);
  // Prime the heartbeat so the first request after enable isn't marked stale.
  void invoke("gateway_heartbeat").catch(() => undefined);
}

async function handle(req: BridgeRequest): Promise<void> {
  const ac = new AbortController();
  active.set(req.requestId, ac);
  const done = () => {
    active.delete(req.requestId);
    void invoke("gateway_done", { requestId: req.requestId }).catch(() => undefined);
  };
  try {
    if (req.kind === "chat" || req.kind === "responses") {
      const clientHint = detectClient(req.headers || {});
      // For Responses API requests, the body has already been normalized by Rust's
      // to_chat_body_responses() — but we still apply the normalizer for tool schema
      // hygiene and role fixes on top of what Rust provides.
      const normalizedBody = normalizeGatewayRequest(req.body, { clientHint });

      const model = String(normalizedBody.model ?? "");
      const messages = (normalizedBody.messages ?? []) as Array<{ role: "user" | "assistant" | "system"; content: string }>;
      const exec = await router.generateText(
        {
          model,
          messages,
          maxTokens: typeof normalizedBody.max_tokens === "number" ? normalizedBody.max_tokens : undefined,
          temperature: typeof normalizedBody.temperature === "number" ? normalizedBody.temperature : undefined,
          tools: normalizedBody.tools,
          toolChoice: normalizedBody.tool_choice,
          responseFormat: normalizedBody.response_format,
          onToolCall: (call: ToolCall) => {
            void invoke("gateway_tool_calls", {
              requestId: req.requestId,
              toolCallsJson: JSON.stringify([call]),
            }).catch(() => undefined);
          },
          onUsage: (usage) => {
            // Collect usage from the adapter; we emit it after the stream so Rust can
            // forward it to the client alongside the final SSE events.
            void invoke("gateway_usage", {
              requestId: req.requestId,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
            }).catch(() => undefined);
          },
        },
        { signal: ac.signal, source: "gateway" as LedgerSource },
      );

      // Phase 2: Filter out mercury-2.5 pseudo-tool-call markup from text chunks.
      // The adapter's onToolCall channel forwards real tool calls via gateway_tool_calls.
      // This suppresses in-text fallback (<|tool_call_start|>...<|tool_call_end|>)
      // so WorkBuddy receives clean text, not rendered markup.
      for await (const rawChunk of exec.chunks) {
        if (rawChunk.includes("<|tool_call_start|>") || rawChunk.includes("<function=")) {
          continue;
        }
        await invoke("gateway_chunk", { requestId: req.requestId, text: rawChunk }).catch(() => {
          ac.abort();
        });
      }
      done();
      return;
    }
    if (req.kind === "models") {
      const rows = await router.listModels();
      await invoke("gateway_result", {
        requestId: req.requestId,
        bodyJson: JSON.stringify({
          object: "list",
          data: rows.map((m) => ({ id: m.id, object: "model", owned_by: m.providerId })),
        }),
      });
      done();
      return;
    }
    if (req.kind === "image") {
      const res = await router.generateImage(
        { model: String(req.body.model ?? ""), prompt: String(req.body.prompt ?? "") },
        { signal: ac.signal, source: "gateway" as LedgerSource },
      );
      await invoke("gateway_result", {
        requestId: req.requestId,
        bodyJson: JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [res.url ? { url: res.url } : { b64_json: res.base64 ?? "" }] }),
      });
      done();
      return;
    }
    await invoke("gateway_error", { requestId: req.requestId, status: 400, message: `unknown bridge kind ${req.kind}` });
  } catch (e) {
    if (ac.signal.aborted) return; // client is gone; nothing to report
    const msg = String((e as Error)?.message ?? e);
    const status = /no route|not found/i.test(msg) ? 404 : 502;
    await invoke("gateway_error", { requestId: req.requestId, status, message: msg }).catch(() => undefined);
  }
}

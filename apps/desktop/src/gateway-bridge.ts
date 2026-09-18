/**
 * Gateway bridge (webview side): answers the Rust gateway's routed requests using the
 * router core, streams chunks back through the gateway_* commands, and aborts on cancel
 * events (§3.5). Ledger source is "gateway" (criterion 10 attribution).
 *
 * Tool execution loop: when the provider returns tool_calls, the bridge executes them
 * locally via gateway_tool_run, appends results to messages, and calls gateway_re_dispatch
 * to re-emit the request with updated context. Runs until the model stops returning
 * tool_calls, then emits gateway_done to the client.
 *
 * Mercury-2.5 handling: models trained on agent transcripts may emit tool calls as
 * inline text markers rather than structured OpenAI tool_calls. This bridge intercepts
 * those markers, parses them into structured calls, executes them locally, and filters
 * them from the client-visible stream so the user never sees raw marker syntax.
 *
 * The master key never appears here — auth happened in Rust before this file ever runs.
 */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { router } from "./store";
import { normalizeGatewayRequest, detectClient, parseOpenAIChatDelta, parseClaudeDelta, initAccumulatorState } from "@aiprovider/router-core";
import type { LedgerSource, AccumulatorState } from "@aiprovider/router-core";
import { parseAssistantStream, type ToolSegment } from "./lib/assistant-stream";

interface BridgeRequest {
  requestId: number;
  kind: "chat" | "responses" | "models" | "image";
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const active = new Map<number, AbortController>();
let started = false;

/**
 * Must match `GATEWAY_WINDOW` in src-tauri/src/gateway_cmds.rs. Rust emits requests to that
 * one window; if the UI window also registered a listener it would answer them too — two
 * upstream calls, two ledger rows, two streams to the client. Refusing to start anywhere else
 * makes that failure impossible rather than merely unlikely.
 */
const BRIDGE_WINDOW = "gateway";

export async function startGatewayBridge(): Promise<void> {
  if (started) return;
  if (getCurrentWindow().label !== BRIDGE_WINDOW) {
    // Not an error: this runs in the UI window during development if someone re-adds the
    // call. Silence is safer than a second listener.
    console.warn(
      `[gateway-bridge] refusing to start in window "${getCurrentWindow().label}" — the bridge ` +
        `only runs in "${BRIDGE_WINDOW}" (audit R1).`,
    );
    return;
  }
  started = true;
  await listen<BridgeRequest>("gateway-request", (event) => {
    void handle(event.payload);
  });
  await listen<{ requestId: number }>("gateway-cancel", (event) => {
    active.get(event.payload.requestId)?.abort();
    active.delete(event.payload.requestId);
  });
  window.setInterval(() => {
    void invoke("gateway_heartbeat").catch(() => undefined);
  }, 2000);
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
      const normalizedBody = normalizeGatewayRequest(req.body, { clientHint });
      const model = String(normalizedBody.model ?? "");
      let messages = (normalizedBody.messages ?? []) as Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
      }>;
      const tools = normalizedBody.tools;
      const toolChoice = normalizedBody.tool_choice;
      const responseFormat = normalizedBody.response_format;
      const maxTokens = typeof normalizedBody.max_tokens === "number" ? normalizedBody.max_tokens : undefined;
      const temperature = typeof normalizedBody.temperature === "number" ? normalizedBody.temperature : undefined;

      const emitProse = (t: string) => {
        if (!t) return;
        const segs = parseAssistantStream(t);
        const visible = segs
          .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
          .map((s) => s.text)
          .join("");
        if (visible) {
          void invoke("gateway_chunk", { requestId: req.requestId, text: visible }).catch(() => ac.abort());
        }
      };

      // The gateway Rust side initializes workspace_root to current_dir / home_dir on startup.
      // gateway_set_workspace_root can be called anytime to change it; nothing needed here.
      let _workspaceRoot: string | null = null;
      const ensureWorkspaceRoot = async (): Promise<string> => {
        if (_workspaceRoot !== null) return _workspaceRoot;
        try {
          const existing = await invoke<string | null>("gateway_get_workspace_root");
          if (existing) {
            _workspaceRoot = existing;
            return _workspaceRoot;
          }
        } catch {}
        // Fallback: should not normally reach here since Rust defaults to cwd/home.
        _workspaceRoot = "/tmp";
        await invoke("gateway_set_workspace_root", { path: _workspaceRoot }).catch(() => undefined);
        return _workspaceRoot;
      };

      const dispatchMercuryCalls = async (calls: ToolSegment[], list: Array<{ id?: string; name?: string; arguments?: string; raw?: unknown }>, emitted: { ref: boolean }) => {
        for (const seg of calls) {
          const callId = crypto.randomUUID().slice(0, 8);
          const argsObj: Record<string, string> = {};
          for (const [k, v] of Object.entries(seg.params)) {
            argsObj[k] = v;
          }
          list.push({ id: callId, name: seg.name ?? "", arguments: JSON.stringify(argsObj) });
          await invoke("gateway_tool_calls", {
            requestId: req.requestId,
            toolCallsJson: JSON.stringify([{ id: callId, type: "function", function: { name: seg.name ?? "", arguments: JSON.stringify(argsObj) } }]),
          }).catch(() => undefined);
          emitted.ref = true;
        }
      };

      while (true) {
        const accumulatedToolCalls: Array<{ id?: string; name?: string; arguments?: string; raw?: unknown }> = [];
        let toolCallEmitted = false;

        const exec = await router.generateText(
          {
            model,
            messages,
            maxTokens,
            temperature,
            tools,
            toolChoice,
            responseFormat,
            onToolCall: (call) => { accumulatedToolCalls.push(call); },
            onUsage: (usage) => {
              void invoke("gateway_usage", {
                requestId: req.requestId,
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
              }).catch(() => undefined);
            },
          },
          { signal: ac.signal, source: "gateway" as LedgerSource },
        );

        const state: AccumulatorState = initAccumulatorState();
        let pendingMercury: ToolSegment | null = null;

        for await (const rawChunk of exec.chunks) {
          let parsed: ReturnType<typeof parseOpenAIChatDelta> | null = null;
          try {
            parsed = parseOpenAIChatDelta(JSON.parse(rawChunk), state);
          } catch {
            continue;
          }
          if (!parsed) {
            try {
              parsed = parseClaudeDelta(JSON.parse(rawChunk), state);
            } catch {
              continue;
            }
          }

          if (parsed?.toolCalls && parsed.finishReason === "tool_calls") {
            for (const c of parsed.toolCalls) {
              if (!accumulatedToolCalls.some((a) => a.id === c.id)) {
                accumulatedToolCalls.push(c);
              }
            }
            await invoke("gateway_tool_calls", {
              requestId: req.requestId,
              toolCallsJson: JSON.stringify(parsed.toolCalls),
            }).catch(() => undefined);
            toolCallEmitted = true;
          }

          if (parsed?.usage) {
            void invoke("gateway_usage", {
              requestId: req.requestId,
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            }).catch(() => undefined);
          }

          // Mercury-2.5 inline text markers.
          const segs = parseAssistantStream(rawChunk);
          for (const seg of segs) {
            if (seg.kind === "tool" && seg.complete) {
              if (pendingMercury !== null) {
                pendingMercury = null;
              }
            } else if (seg.kind === "tool" && !seg.complete) {
              pendingMercury = seg;
            }
          }
          emitProse(segs.filter((s): s is { kind: "text"; text: string } => s.kind === "text").map((s) => s.text).join(""));
          const completedMercury = segs.filter((s): s is ToolSegment => s.kind === "tool" && s.complete);
          if (completedMercury.length > 0) {
            await dispatchMercuryCalls(completedMercury, accumulatedToolCalls, { ref: false } as { ref: boolean });
          }
        }

        if (pendingMercury !== null && pendingMercury.complete) {
          await dispatchMercuryCalls([pendingMercury], accumulatedToolCalls, { ref: false } as { ref: boolean });
        }

        if (!toolCallEmitted && state.toolCalls.size > 0 && state.finishReason === "tool_calls") {
          const calls = Array.from(state.toolCalls.values()).map((c) => ({
            id: c.id ?? "",
            type: c.type,
            function: c.function,
          }));
          void invoke("gateway_tool_calls", {
            requestId: req.requestId,
            toolCallsJson: JSON.stringify(calls),
          }).catch(() => undefined);
        }

        if (accumulatedToolCalls.length === 0) {
          done();
          return;
        }

        // Ensure workspace root is set before executing any tools.
        await ensureWorkspaceRoot().catch(() => undefined);

        for (const call of accumulatedToolCalls) {
          const name = call.name ?? "";
          let args = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            args = call.arguments ?? {};
          }
          try {
            const result = await invoke<{ ok: boolean; output: string; error?: string }>(
              "gateway_tool_run",
              { requestId: req.requestId, toolName: name, arguments: JSON.stringify(args) },
            );
            const resultText = result.ok ? result.output : (result.error ?? "tool execution failed");
            messages.push({ role: "tool", content: resultText, tool_call_id: call.id ?? name });
          } catch (e) {
            const errMsg = `Tool execution error: ${e instanceof Error ? e.message : String(e)}`;
            messages.push({ role: "tool", content: errMsg, tool_call_id: call.id ?? name });
          }
        }

        await invoke("gateway_re_dispatch", {
          requestId: req.requestId,
          messagesJson: JSON.stringify(messages),
        }).catch(() => undefined);
      }
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
    if (ac.signal.aborted) return;
    const msg = String((e as Error)?.message ?? e);
    const status = /no route|not found/i.test(msg) ? 404 : 502;
    await invoke("gateway_error", { requestId: req.requestId, status, message: msg }).catch(() => undefined);
  }
}

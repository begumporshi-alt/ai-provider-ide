/**
 * Gateway bridge (webview side): answers the Rust gateway's routed requests using the
 * router core, streams chunks back through the gateway_* commands, and aborts on cancel
 * events (§3.5). Ledger source is "gateway" (criterion 10 attribution).
 *
 * Tool calls have exactly two modes, and which one applies is decided by who declared the
 * tools — never guessed:
 *
 *   PASS-THROUGH  The client sent its own `tools` array. Those are the client's tools and
 *                 the client will run them. We emit them on the wire and end the request.
 *                 We do NOT also execute them: that would write the same file twice.
 *
 *   GATEWAY       The client sent no tools and the gateway tool toggle is on. We supply our
 *                 own sandboxed registry, execute each call in the Rust host, feed the
 *                 results back to the model, and keep going until it stops asking. The
 *                 client sees the model's prose as it arrives — including any preamble
 *                 before a tool call — but never the tool calls or their results, which stay
 *                 server-side. Suppressing the preamble would mean buffering text we might
 *                 never emit: an abort or the iteration cap would swallow it whole.
 *
 * Mercury-2.5 handling: models trained on agent transcripts may emit tool calls as
 * inline text markers rather than structured OpenAI tool_calls. Those markers are not part
 * of any client tool contract, so they are always executed locally and filtered out of the
 * client-visible stream — the user never sees raw marker syntax.
 *
 * The master key never appears here — auth happened in Rust before this file ever runs.
 */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { router } from "./store";
import { normalizeGatewayRequest, detectClient } from "@aiprovider/router-core";
import type { LedgerSource } from "@aiprovider/router-core";
import { parseAssistantStream, type ToolSegment } from "./lib/assistant-stream";
import { AGENT_TOOLS, registryToOpenAI } from "./lib/tools/registry";

interface BridgeRequest {
  requestId: number;
  kind: "chat" | "responses" | "models" | "image";
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Matches `maxIterations` in lib/tools/agentLoop.ts. A model that will not stop calling
 *  tools must not be able to spend without limit; 8 turns is enough for real work and
 *  bounded when something goes wrong. */
const MAX_TOOL_ITERATIONS = 8;

interface ToolCall {
  id?: string;
  name?: string;
  arguments?: string;
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
      const messages = (normalizedBody.messages ?? []) as Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
      }>;
      const clientTools = Array.isArray(normalizedBody.tools) && normalizedBody.tools.length > 0
        ? normalizedBody.tools
        : undefined;
      const responseFormat = normalizedBody.response_format;
      const maxTokens = typeof normalizedBody.max_tokens === "number" ? normalizedBody.max_tokens : undefined;
      const temperature = typeof normalizedBody.temperature === "number" ? normalizedBody.temperature : undefined;

      // Who owns the tools? The client, if it brought its own. Otherwise the gateway, but
      // only when the operator has turned gateway tools on.
      let gatewayTools = false;
      if (!clientTools) {
        try {
          gatewayTools = await invoke<boolean>("get_tools_enabled");
        } catch {
          gatewayTools = false;
        }
      }
      const tools = gatewayTools ? registryToOpenAI(AGENT_TOOLS) : clientTools;
      // Pass-through must honour the client's own tool_choice; only the gateway-supplied
      // registry is ours to steer with "auto".
      const toolChoice = gatewayTools ? "auto" : normalizedBody.tool_choice;

      // Emitting a chunk is also the liveness check: gateway_chunk fails once the HTTP
      // request is gone, and aborting here is what stops us paying for tokens nobody wants.
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

      // Must be awaited by the caller: this and gateway_done race on the same channel, and if
      // Done landed first the client would see a finished request with no tool calls in it.
      const emitToolCalls = async (calls: ToolCall[]) => {
        await invoke("gateway_tool_calls", {
          requestId: req.requestId,
          toolCallsJson: JSON.stringify(calls),
        }).catch(() => undefined);
      };

      const executeLocally = async (calls: ToolCall[]) => {
        for (const call of calls) {
          const name = call.name ?? "";
          let args: unknown = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            args = call.arguments ?? {};
          }
          let resultText: string;
          try {
            const result = await invoke<{ ok: boolean; output: string; error?: string }>(
              "gateway_tool_run",
              { requestId: req.requestId, toolName: name, arguments: JSON.stringify(args) },
            );
            resultText = result.ok ? result.output : (result.error ?? "tool execution failed");
          } catch (e) {
            resultText = `Tool execution error: ${e instanceof Error ? e.message : String(e)}`;
          }
          messages.push({ role: "tool", content: resultText, tool_call_id: call.id ?? name });
        }
      };

      /** Run the calls in the sandbox and leave the model a well-formed turn it can accept:
       *  the assistant message that requested the calls, then one result per call. Providers
       *  reject a `tool` message that is not answering a preceding `tool_calls` turn. */
      const sandboxTurn = async (turnText: string, calls: ToolCall[]) => {
        messages.push({
          role: "assistant",
          content: turnText,
          tool_calls: calls.map((c) => ({ id: c.id ?? "", name: c.name ?? "", arguments: c.arguments ?? "{}" })),
        });
        await executeLocally(calls);
      };

      for (let iter = 1; iter <= MAX_TOOL_ITERATIONS; iter++) {
        if (ac.signal.aborted) return;

        const collected: ToolCall[] = [];
        const mercuryCalls: ToolCall[] = [];
        let turnText = "";

        const exec = await router.generateText(
          {
            model,
            messages,
            maxTokens,
            temperature,
            tools,
            toolChoice,
            responseFormat,
            onToolCall: (call) => {
              if (!collected.some((c) => c.id && c.id === call.id)) collected.push(call as ToolCall);
            },
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

        for await (const rawChunk of exec.chunks) {
          if (ac.signal.aborted) break;

          // Chunks are decoded text deltas, not wire frames. The adapter resolves the
          // provider's SSE/JSON itself and yields `delta` strings
          // (manifest-interpreter: `yield delta`), and real tool calls never travel in
          // chunks at all — they arrive on `onToolCall` once the stream ends. Parsing a
          // chunk as JSON here used to throw on every chunk and `continue`, which silently
          // dropped the entire answer: the client saw an empty completion.
          //
          // Mercury-2.5 inline text markers: not part of any client tool contract, so these
          // are always ours to run.
          const segs = parseAssistantStream(rawChunk);
          const visible = segs
            .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
            .map((s) => s.text)
            .join("");
          turnText += visible;
          emitProse(visible);

          for (const seg of segs.filter((s): s is ToolSegment => s.kind === "tool" && s.complete)) {
            const id = crypto.randomUUID().slice(0, 8);
            const params: Record<string, string> = {};
            for (const [k, v] of Object.entries(seg.params)) params[k] = v;
            mercuryCalls.push({ id, name: seg.name ?? "", arguments: JSON.stringify(params) });
          }
        }

        if (ac.signal.aborted) return;

        // Mercury markers first: they are ours regardless of who declared the real tools.
        if (mercuryCalls.length > 0) {
          await sandboxTurn(turnText, mercuryCalls);
          continue;
        }

        // No tool calls at all: the model answered and the turn is over.
        if (collected.length === 0) {
          done();
          return;
        }

        // Pass-through: hand the client's calls back untouched and end the request. We do not
        // execute them — the client already will.
        if (!gatewayTools) {
          await emitToolCalls(collected);
          done();
          return;
        }

        // Gateway tools: run them in the sandbox and keep the conversation going.
        await sandboxTurn(turnText, collected);
      }

      // Iteration ceiling reached: return what we have rather than looping forever.
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
    if (ac.signal.aborted) return;
    const msg = String((e as Error)?.message ?? e);
    const status = /no route|not found/i.test(msg) ? 404 : 502;
    await invoke("gateway_error", { requestId: req.requestId, status, message: msg }).catch(() => undefined);
  }
}

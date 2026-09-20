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
 *                 client sees only the answer the model settles on: text from a turn that
 *                 goes on to call a tool is a preamble the client never asked for, so it is
 *                 held back and dropped when the next turn starts. Tool calls and their
 *                 results stay server-side entirely.
 *
 *                 Two exceptions, both deliberate. Pass-through and tools-off stream as they
 *                 arrive, because neither has a follow-up turn to wait for. And if the run
 *                 hits the iteration ceiling, the last turn is released rather than dropped:
 *                 a client that receives nothing cannot tell "gave up" from "broke".
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
import { normalizeGatewayRequest, detectClient, AllAttemptsFailedError } from "@aiprovider/router-core";
import type { LedgerSource } from "@aiprovider/router-core";
import { parseAssistantStream, type ToolSegment } from "./lib/assistant-stream";
import { AGENT_TOOLS, registryToOpenAI } from "./lib/tools/registry";
import { DEFAULT_MAX_ITERATIONS } from "./lib/tools/agentLoop";
import { toWireToolCalls } from "./lib/tools/wire";

/**
 * Upstream statuses that may be handed to the client unchanged.
 *
 * A whitelist, deliberately, not an echo. A `401`/`403` from an upstream means *our stored key* was
 * rejected — the client's own credentials are not in question, so passing it through would send the
 * client hunting for a problem it does not have. A 5xx is the provider's failure, which from the
 * client's side is a gateway failure. What remains is the set where the client's request is the
 * cause and a retry either helps (429) or never will (400/404/413/422).
 */
const CLIENT_ATTRIBUTABLE_STATUS = new Set([400, 404, 413, 422, 429]);

/**
 * The HTTP status to report to the client for a failed request.
 *
 * This used to be `const status = /no route|not found/i.test(msg) ? 404 : 502` — a regex over the
 * error *message*, which is not a contract. It reported every schema rejection as 502, telling the
 * client the gateway was broken and inviting retries for a request that can never succeed, and any
 * rewording of a message would have silently changed the status. The router already knows: an
 * `AllAttemptsFailedError` carries the attempts, and each one holds the upstream's own status.
 *
 * The message heuristic survives only for errors that carry no attempt at all — the empty-plan
 * guard, or a throw from outside the engine.
 */
export function gatewayStatus(e: unknown, msg: string): number {
  if (e instanceof AllAttemptsFailedError) {
    const last = e.chain[e.chain.length - 1];
    // `status: 0` means the attempt never reached the provider (DNS, TLS, timeout) — a gateway-side
    // failure, not a client one.
    if (last && CLIENT_ATTRIBUTABLE_STATUS.has(last.status)) return last.status;
  }
  return /no route|not found/i.test(msg) ? 404 : 502;
}

interface BridgeRequest {
  requestId: number;
  kind: "chat" | "responses" | "models" | "image";
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

// Imported, not re-declared. This used to be a second `= 8` kept in step with agentLoop's by a
// comment — so the gateway and the Assistant silently disagree the moment either one changes.
const MAX_TOOL_ITERATIONS = DEFAULT_MAX_ITERATIONS;

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
        // Left as `unknown[]`: an incoming client turn carries whatever shape its dialect uses,
        // and the turns we append carry the OpenAI wire shape from `toWireToolCalls`.
        tool_calls?: unknown[];
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

      // Gateway mode runs several model turns, and only the last one is an answer. Text from
      // a turn that goes on to call tools is a preamble ("on it:"), and the client did not
      // ask for it — so it is held here and released only once a turn ends without asking
      // for anything. Pass-through and tools-off have no follow-up turn, so they stream
      // straight through; there is nothing to wait for.
      let heldProse = "";

      // Emitting a chunk is also the liveness check: gateway_chunk fails once the HTTP
      // request is gone, and aborting here is what stops us paying for tokens nobody wants.
      const emitProse = (t: string) => {
        if (!t) return;
        const segs = parseAssistantStream(t);
        const visible = segs
          .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
          .map((s) => s.text)
          .join("");
        if (!visible) return;
        if (gatewayTools) {
          heldProse += visible;
          return;
        }
        void invoke("gateway_chunk", { requestId: req.requestId, text: visible }).catch(() => ac.abort());
      };

      /** Release what a finished turn produced. Awaited: it races gateway_done. */
      const flushProse = async () => {
        if (!heldProse) return;
        const text = heldProse;
        heldProse = "";
        await invoke("gateway_chunk", { requestId: req.requestId, text }).catch(() => undefined);
      };

      // Must be awaited by the caller: this and gateway_done race on the same channel, and if
      // Done landed first the client would see a finished request with no tool calls in it.
      const emitToolCalls = async (calls: ToolCall[]) => {
        await invoke("gateway_tool_calls", {
          requestId: req.requestId,
          toolCallsJson: JSON.stringify(calls),
        }).catch(() => undefined);
      };

      const executeLocally = async (calls: ToolCall[], ids: string[]) => {
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
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
          // Paired with the id the assistant turn declared — never a second, independent guess.
          messages.push({ role: "tool", content: resultText, tool_call_id: ids[i]! });
        }
      };

      /** Run the calls in the sandbox and leave the model a well-formed turn it can accept:
       *  the assistant message that requested the calls, then one result per call. Providers
       *  reject a `tool` message that is not answering a preceding `tool_calls` turn. */
      const sandboxTurn = async (turnText: string, calls: ToolCall[]) => {
        // One decision builds both halves, so the declared ids and the result ids cannot drift.
        const { wire, ids } = toWireToolCalls(calls);
        messages.push({ role: "assistant", content: turnText, tool_calls: wire });
        await executeLocally(calls, ids);
      };

      for (let iter = 1; iter <= MAX_TOOL_ITERATIONS; iter++) {
        if (ac.signal.aborted) return;

        // A turn that ends up calling tools has nothing to show the client, so whatever it
        // said goes no further. Starting a new turn discards the previous turn's preamble.
        heldProse = "";

        // Holding text back removes our only backpressure: `gateway_chunk` failing is how we
        // learn the client is gone, and in gateway mode nothing is emitted until the end. So
        // probe before EVERY turn — including the first.
        //
        // The first turn is the one that needed it. It used to be skipped (`iter > 1`), which
        // left Rust's first-message bound measuring silence that meant nothing: a healthy
        // worker grinding through a long turn looked exactly like a suspended one, so slow
        // requests failed as though the window had died. Measured on a live gateway — a
        // ~150k-token prompt ran past the bound finishing turn 1 and was answered 503 blaming
        // suspension, while the window was serving normally on both sides of it.
        //
        // Probing is safe by construction: the probe is sent BY the worker, so a genuinely
        // suspended worker still sends nothing and the bound still fires. What arrives is
        // proof of liveness — a better signal than any timeout. An empty chunk is answered
        // with nothing on the wire (Rust drops empty deltas); it is purely a liveness check,
        // and a failure here stops us paying for tokens nobody will read.
        if (gatewayTools) {
          const alive = await invoke("gateway_chunk", { requestId: req.requestId, text: "" })
            .then(() => true)
            .catch(() => false);
          if (!alive) return;
        }
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

        // No tool calls at all: the model answered and the turn is over. This is the only
        // text the client sees in gateway mode, so release it before finishing.
        if (collected.length === 0) {
          await flushProse();
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

      // Iteration ceiling reached: return what we have rather than looping forever. The last
      // turn is released even though it is not a clean answer — a client that gets nothing
      // at all cannot tell "gave up" from "broke".
      await flushProse();
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
    const status = gatewayStatus(e, msg);
    await invoke("gateway_error", { requestId: req.requestId, status, message: msg }).catch(() => undefined);
  }
}

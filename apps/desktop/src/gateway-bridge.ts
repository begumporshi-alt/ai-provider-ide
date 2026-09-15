/**
 * Gateway bridge (webview side): answers the Rust gateway's routed requests using the
 * router core, streams chunks back through the gateway_* commands, and aborts on cancel
 * events (§3.5). Ledger source is "gateway" (criterion 10 attribution).
 *
 * The master key never appears here — auth happened in Rust before this file ever runs
 * (invariants 10, 14).
 */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { router } from "./store";
import type { LedgerSource } from "@aiprovider/router";

interface BridgeRequest {
  requestId: number;
  kind: "chat" | "models" | "image";
  body: Record<string, unknown>;
}

const active = new Map<number, AbortController>();

export async function startGatewayBridge(): Promise<void> {
  await listen<BridgeRequest>("gateway-request", (event) => {
    void handle(event.payload);
  });
  await listen<{ requestId: number }>("gateway-cancel", (event) => {
    active.get(event.payload.requestId)?.abort();
    active.delete(event.payload.requestId);
  });
  // Liveness heartbeat: proves the router core answers (§3.5 availability).
  setInterval(() => {
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
    if (req.kind === "chat") {
      const model = String(req.body.model ?? "");
      const messages = (req.body.messages ?? []) as Array<{ role: "user" | "assistant" | "system"; content: string }>;
      const exec = await router.generateText(
        {
          model,
          messages,
          maxTokens: typeof req.body.max_tokens === "number" ? req.body.max_tokens : undefined,
          temperature: typeof req.body.temperature === "number" ? req.body.temperature : undefined,
        },
        { signal: ac.signal, source: "gateway" as LedgerSource },
      );
      for await (const chunk of exec.chunks) {
        await invoke("gateway_chunk", { requestId: req.requestId, text: chunk }).catch(() => {
          ac.abort(); // the gateway stopped listening; cancel upstream
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

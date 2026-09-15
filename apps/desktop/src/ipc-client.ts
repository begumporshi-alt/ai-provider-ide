/**
 * ipc-client (L4): THE only UI<->host bridge. Implements the router-core ports over Tauri
 * commands/channels so the TS core never knows it's in a desktop app (and tests never need
 * one). UI screens import ONLY this module — nothing else crosses to core or host.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { HttpPort, KeyVaultPort, StorePort } from "@aiprovider/router";

interface WireEgressResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type StreamEvent =
  | { type: "headers"; status: number; headers: Record<string, string> }
  | { type: "line"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** HttpPort over `egress:*` — unary for JSON bodies, Tauri Channel for SSE streams. */
export function createHttpPort(): HttpPort {
  return {
    async request(req) {
      const wire = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body ?? null,
        secret_ref: req.secretRef ?? null,
        timeout_ms: null,
      };
      const wantsStream = Boolean(req.headers["accept"]?.includes("text/event-stream")) || isChatStreamBody(req.body);
      if (!wantsStream) {
        const res = await invoke<WireEgressResponse>("egress_request", { req: wire });
        return {
          status: res.status,
          headers: res.headers,
          text: async () => res.body,
          lines: emptyLines(),
        };
      }
      // SSE: Rust pushes lines through the channel; we bridge them into an async iterable.
      const channel = new Channel<StreamEvent>();
      const queue: StreamEvent[] = [];
      let closed = false;
      let error: string | null = null;
      let resolve: (() => void) | null = null;
      const wake = () => {
        resolve?.();
        resolve = null;
      };
      channel.onmessage = (ev) => {
        queue.push(ev);
        if (ev.type === "done") closed = true;
        if (ev.type === "error") {
          error = ev.message;
          closed = true;
        }
        wake();
      };
      const headers: Record<string, string> = {};
      let status = 0;
      const settled = new Promise<void>((res) => {
        // The command promise resolves when the stream task finishes; keep a reference so we
        // can mark closed even if onmessage races.
        void invoke("egress_stream", { req: wire, onEvent: channel }).then(
          () => {
            closed = true;
            res();
            wake();
          },
          (e: unknown) => {
            error = String(e);
            closed = true;
            res();
            wake();
          },
        );
      });
      void settled;
      // The host streams the raw HTTP status as the first event before lines.
      const lines = (async function* () {
        for (;;) {
          while (queue.length) {
            const ev = queue.shift()!;
            if (ev.type === "headers") {
              status = ev.status;
              Object.assign(headers, ev.headers);
              continue;
            }
            if (ev.type === "line") yield ev.text;
            if (ev.type === "done") return;
            if (ev.type === "error") throw new Error(ev.message);
          }
          if (closed) {
            if (error) throw new Error(error);
            return;
          }
          if (req.signal?.aborted) {
            // §3.5 cancellation: stop consuming; the Rust task's stream drops when its
            // client half is gone.
            return;
          }
          await new Promise<void>((res) => (resolve = res));
        }
      })();
      return {
        get status() {
          return status || 200;
        },
        headers,
        text: async () => {
          let out = "";
          for await (const l of lines) out += l + "\n";
          return out;
        },
        lines,
      };
    },
  };
}

function isChatStreamBody(body?: string): boolean {
  if (!body) return false;
  try {
    const j = JSON.parse(body) as { stream?: boolean };
    return j.stream === true;
  } catch {
    return false;
  }
}

async function* emptyLines(): AsyncIterable<string> {
  return;
}

/** KeyVaultPort over `vault:*`. The secret goes IN once and never comes back OUT (invariant 14). */
export function createKeyVaultPort(): KeyVaultPort {
  return {
    async put(label, secret) {
      const account = `key:${label}`;
      await invoke("vault_put", { account, secret });
      return account;
    },
    async get() {
      // Intentionally unsupported: TS is key-blind (invariant 2). The egress gateway reads
      // the keychain host-side.
      throw new Error("vault.get is not callable from the webview (key-blind by construction)");
    },
    async delete(secretRef) {
      await invoke("vault_delete", { account: secretRef });
    },
  };
}

/** StorePort over `store:*` + `settings:*` — structured commands, no raw SQL (invariant 12). */
export function createStorePort(): StorePort {
  return {
    async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      throw new Error("raw SQL query is not exposed to the webview (invariant 12)");
    },
    async execute(_sql: string, _params?: unknown[]): Promise<void> {
      throw new Error("raw SQL execute is not exposed to the webview (invariant 12)");
    },
  };
}

/** Allowlist hygiene: register a provider baseUrl host with the egress gateway (invariant 3). */
export async function allowProviderHost(baseUrl: string): Promise<void> {
  const host = new URL(baseUrl).hostname;
  await invoke("egress_allow_host", { host });
}

export async function denyProviderHost(baseUrl: string): Promise<void> {
  const host = new URL(baseUrl).hostname;
  await invoke("egress_deny_host", { host });
}

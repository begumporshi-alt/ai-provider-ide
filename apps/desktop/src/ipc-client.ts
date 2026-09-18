/**
 * ipc-client (L4): THE only UI<->host bridge. Implements the router-core ports over Tauri
 * commands/channels so the TS core never knows it's in a desktop app (and tests never need
 * one). UI screens import ONLY this module — nothing else crosses to core or host.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { HttpPort, KeyVaultPort, StorePort } from "@aiprovider/router-core";

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

/**
 * HttpPort over `egress:*` — unary for JSON bodies, Tauri Channel for SSE streams.
 *
 * Streaming contract (diff-review M3): `request()` RESOLVES only after the host has sent
 * the `headers` event, so `status` is authoritative before the interpreter inspects it —
 * a real 401/429 on the stream path reaches the health tracker exactly like a 401/429 on
 * the unary path. The command promise is kept so completion/errors still surface while
 * lines are consumed.
 */
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

      const channel = new Channel<StreamEvent>();
      const queue: StreamEvent[] = [];
      let closed = false;
      let streamError: { message: string; status?: number } | null = null;
      let wake: (() => void) | null = null;
      const notify = () => {
        wake?.();
        wake = null;
      };
      let status = 0;
      let headers: Record<string, string> = {};
      let resolveHeaders: () => void = () => {};
      let rejectHeaders: (e: unknown) => void = () => {};
      const headersArrived = new Promise<void>((resolve, reject) => {
        resolveHeaders = resolve;
        rejectHeaders = reject;
      });

      channel.onmessage = (ev) => {
        if (ev.type === "headers") {
          status = ev.status;
          headers = ev.headers;
          resolveHeaders();
          if (status >= 400) {
            // The host will follow with one error event; queue it too.
          }
          return;
        }
        queue.push(ev);
        if (ev.type === "done") closed = true;
        if (ev.type === "error") {
          const m = /^http (\d{3}):/.exec(ev.message);
          streamError = { message: ev.message, status: m ? Number(m[1]) : undefined };
          closed = true;
          rejectHeaders(new Error(ev.message)); // headers+error both known -> fail fast
        }
        notify();
      };

      // Keep the completion promise; it marks the stream closed even if events race.
      void invoke("egress_stream", { req: wire, onEvent: channel }).then(
        () => {
          closed = true;
          resolveHeaders();
          notify();
        },
        (e: unknown) => {
          streamError = { message: String(e) };
          closed = true;
          rejectHeaders(e);
          notify();
        },
      );

      // Await authoritative status BEFORE resolving (interpreter reads res.status first).
      try {
        await headersArrived;
      } catch {
        // fall through: lines generator below throws the real error
      }
      if (streamError) {
        // Error before/without headers: surface as a high status so classify() works.
        status = status || 599;
      }

      const lines = (async function* () {
        const getError = () => streamError; // closure read defeats flow-narrowing (mutated by onmessage)
        for (;;) {
          while (queue.length) {
            const ev = queue.shift()!;
            if (ev.type === "line") yield ev.text;
            else if (ev.type === "done") return;
            else if (ev.type === "error") throw new Error(ev.message);
          }
          if (closed) {
            const e = getError();
            if (e) throw new Error(e.message);
            return;
          }
          if (req.signal?.aborted) return; // §3.5: stop consuming -> host cancels upstream
          await new Promise<void>((res) => (wake = res));
        }
      })();

      const waitForClose = async () => {
        while (!closed) await new Promise<void>((res) => (wake = res));
      };
      return {
        status: status || 200,
        headers,
        text: async () => {
          // On an HTTP-error stream the host sends one error event after the headers; wait
          // for it so the interpreter can wrap it in ManifestHttpError and the engine
          // classifies 401/429 correctly (the auth breaker depends on this).
          if ((status || 0) >= 400) {
            await waitForClose();
            return streamError?.message ?? "";
          }
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

interface WireImageFetch {
  status: number;
  content_type: string;
  base64: string;
  bytes: number;
}

/**
 * Invariant-3 carve-out: render a provider-returned image URL. The webview's CSP forbids
 * remote content, and the URL's host may be a CDN the allowlist never saw — the host fetches
 * it scoped to that response (no secret attached) and hands back bytes as base64, which the
 * UI shows as a `data:` URI. A non-2xx answer throws so the caller can show the raw link.
 */
export async function fetchImageUrl(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await invoke<WireImageFetch>("egress_fetch_image", { req: { url, timeout_ms: timeoutMs } });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`image fetch failed: http ${res.status}`);
  }
  return `data:${res.content_type};base64,${res.base64}`;
}

/** KeyVaultPort over `vault:*`. The secret goes IN once and never comes back OUT (invariant 14). */
export function createKeyVaultPort(): KeyVaultPort {
  return {
    async put(label, secret) {
      await invoke("vault_put", { account: label, secret });
      return label;
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

/** StorePort is deliberately NOT exposed to TS persistence: the host owns SQL. Consumers get
 *  the structured persist commands via the `persist` namespace below instead (invariant 12). */
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

/** Host-side allowlist helpers (webview may NOT call these; the commands no longer exist —
 *  provider CRUD syncs the allowlist host-side). Kept as no-op guards for old call sites. */
export async function allowProviderHost(_baseUrl: string): Promise<void> {
  // Intentionally empty: allowlisting happens in provider_upsert (Rust).
}
export async function denyProviderHost(_baseUrl: string): Promise<void> {
  // Intentionally empty: allowlisting happens in provider_delete (Rust).
}

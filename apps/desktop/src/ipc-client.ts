/**
 * ipc-client (L4): THE only UI<->host bridge. Implements the router-core ports over Tauri
 * commands/channels so the TS core never knows it's in a desktop app (and tests never need
 * one). UI screens import ONLY this module — nothing else crosses to core or host.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl as pluginOpenUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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
      // the secrets file host-side.
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

// ---------- artifacts: previewing files the agent produced ----------

export interface ArtifactBytes {
  media_type: string;
  /** Base64 of the raw bytes; empty when `as_text` was requested. */
  base64: string;
  /** UTF-8 text; only present when `as_text` was requested. */
  text?: string;
  bytes: number;
}

/**
 * Read one previewable workspace file (HTML page, PDF, image) for a transcript card.
 *
 * The host confines the path to `root` and refuses any extension outside its allowlist
 * (`core/artifact.rs`), so this cannot become a general file reader for the webview. `as_text`
 * exists because the HTML card wants text for a `srcdoc` and decoding on the host side avoids
 * re-implementing UTF-8 recovery in the UI.
 */
export async function artifactRead(
  path: string,
  root: string,
  asText = false,
): Promise<ArtifactBytes> {
  return invoke<ArtifactBytes>("artifact_read", { req: { path, root, as_text: asText } });
}

/** Base64 (no data-URI header) decoded to bytes — the shape pdf.js and Blob want. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hand a URL to the user's default browser.
 *
 * The transcript's links used to be inert: markdown rendered an `<a href>`, and clicking one
 * either did nothing (the CSP refuses the navigation) or replaced the app's own document. The
 * opener plugin is the granted path for this (`opener:allow-default-urls` allows http/https), so
 * the link does what the reader expects without the webview ever navigating away.
 */
export async function openExternal(url: string): Promise<void> {
  await pluginOpenUrl(url);
}

/** Show a file in the OS file manager. `revealItemInDir` needs no path scope, so it is granted. */
export async function revealPath(absolutePath: string): Promise<void> {
  await revealItemInDir(absolutePath);
}

/**
 * Fetch a URL's body as text through the host's egress path — no secret attached.
 *
 * Deliberately NOT `fetchAdmin`: that takes an admin *path* and attaches the UI session key, so
 * pointing it at a user-supplied URL would hand this app's gateway credential to whatever is
 * listening there. This sends `secret_ref: null`, which is the same shape the router uses for a
 * provider with no key, and the host still enforces its own egress policy (loopback or allowlist,
 * https-or-local-http) — so a refusal here is the policy working, not a bug to route around.
 */
export async function fetchUrlText(
  url: string,
  timeoutMs = 20_000,
): Promise<{ status: number; body: string }> {
  const res = await invoke<WireEgressResponse>("egress_request", {
    req: { url, method: "GET", headers: {}, body: null, secret_ref: null, timeout_ms: timeoutMs },
  });
  return { status: res.status, body: res.body };
}

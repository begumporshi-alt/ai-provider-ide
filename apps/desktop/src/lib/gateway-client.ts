/**
 * The UI's own credential for the admin HTTP surface (D51).
 *
 * §10 decision 2 is pure HTTP: the UI is a client like any other and reaches the gateway over
 * `fetch()`. But TypeScript is key-blind by construction (invariant 2) — it holds `secretRef`,
 * never a secret. So the webview had nothing to send, and every `/admin/*` route answered 401.
 *
 * The fix: the host mints a local, revocable session credential (`core/ui_session.rs`) and hands
 * it to the webview via `ui_session_key`. This module caches it in memory for the session and
 * exposes it as a `Bearer` token.
 *
 * **The secret is never persisted in TypeScript.** It lives in `let` — not `localStorage`, not
 * `sessionStorage`, not a cookie — so it vanishes when the webview reloads, and a new one is
 * minted on the next call. That is the point: a secret that survives a reload is a secret that
 * can be extracted from a compromised webview, and the whole of invariant 2 exists to prevent
 * exactly that.
 *
 * **Usage:** `await fetchAdmin("GET", "/admin/providers")` — this module supplies the
 * `Authorization` header and the base URL.
 */

import { invoke } from "@tauri-apps/api/core";

let _cached: string | null = null;

/** The session credential, minted on first call and held in memory only. */
export async function uiSessionKey(): Promise<string> {
  if (_cached) return _cached;
  const secret = await invoke<string>("ui_session_key");
  _cached = secret;
  return secret;
}

/** Drop the cached credential. Called on gateway stop so the next start mints a fresh one. */
export function clearUiSession(): void {
  _cached = null;
}

/**
 * The gateway base URL.
 *
 * **The live port is the authority.** `gateway_status` reports the port the host actually bound,
 * and that is the only thing that answers "where is the listener". Reading the `gateway` settings
 * row instead was wrong in two reachable ways: the row is only written once the operator toggles
 * the switch, so on a first run there is no row at all; and a row written from an emptied port
 * field carries no `port` key while the host binds its own default.
 *
 * The fallback is for a failed status call, and its constant must match `gateway::DEFAULT_PORT` —
 * it used to say `8800`, which this app has never bound, so the UI dialled a closed port while the
 * gateway was healthy. `gateway_status` is cached host-side (see `master_key_state`), so asking it
 * per call is a cheap local read, not a secrets-file read.
 */
export async function gatewayBaseUrl(): Promise<string> {
  const status = await invoke<{ port?: number }>("gateway_status").catch(() => null);
  if (typeof status?.port === "number" && status.port > 0) {
    return `http://127.0.0.1:${status.port}`;
  }
  const raw = await invoke<string | null>("settings_get", { key: "gateway" });
  const s = raw ? (JSON.parse(raw) as { port?: number }) : {};
  return `http://127.0.0.1:${s.port ?? 8787}`;
}

/** One authenticated `fetch()` to the admin surface.
 *
 *  - `method`: GET, POST, PUT, DELETE
 *  - `path`: the `/admin/…` path, with leading slash
 *  - `body`: optional JSON body for POST/PUT
 *
 *  Returns the parsed JSON response. Throws on non-2xx with the response text as the message.
 */
export async function fetchAdmin(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const [base, key] = await Promise.all([gatewayBaseUrl(), uiSessionKey()]);
  const url = `${base}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  // 204 No Content returns empty; JSON.parse on "" throws, so guard it.
  if (res.status === 204) return undefined;
  return res.json();
}

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

/** The gateway base URL, read from the `gateway` settings row. */
export async function gatewayBaseUrl(): Promise<string> {
  const raw = await invoke<string | null>("settings_get", { key: "gateway" });
  const s = raw ? (JSON.parse(raw) as { port?: number }) : {};
  const port = s.port ?? 8800;
  return `http://127.0.0.1:${port}`;
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

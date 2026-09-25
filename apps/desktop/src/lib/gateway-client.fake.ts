/**
 * A fake admin transport, for specs that exercise `store.ts` (2026-09-25, increment 26j).
 *
 * **Why this exists, and why it is one file rather than two inline mocks.** 26i moved a group of
 * store functions from `invoke` to `fetchAdmin`, which dials `http://127.0.0.1:<port>`. The two
 * specs that cover those functions mock **only** `@tauri-apps/api/core`, so the migrated path fell
 * through to a real socket and every one of them failed with `ECONNREFUSED 127.0.0.1:8800` — five
 * tests, all red, while `tsc` stayed clean. A typecheck cannot see a transport.
 *
 * The seam is the **module boundary**, not a test-only parameter inside production code: `store.ts`
 * imports `fetchAdmin` from `./lib/gateway-client`, so replacing that module replaces the transport
 * and leaves the store's own logic — what it sends, what it parses, whether it swallows — under
 * test. That is the thing these specs are actually about.
 *
 * **Defaults are a convenience, not a claim.** A spec that asserts on a response seeds it with
 * `seedAdmin`; the defaults below exist only so an incidental call in the middle of a path does not
 * throw. Reading a default and calling it data would be the same mistake as reading a real gateway
 * that happens to be empty.
 *
 * **Failures are injected per `METHOD path`**, mirroring the `failing` map in
 * `store.trail-writes.test.ts`, so "this write did not land" stays arrangeable after the migration —
 * that property is the whole point of that file.
 */

export type AdminCall = { method: string; path: string; body?: unknown };

const calls: AdminCall[] = [];
const failing = new Map<string, string>();
const responses = new Map<string, unknown>();

const key = (method: string, path: string): string => `${method} ${path}`;

/** Empty every recorded call, injected failure and seeded response. */
export function resetAdmin(): void {
  calls.length = 0;
  failing.clear();
  responses.clear();
}

/** Make `METHOD path` reject with `message`, the way a dead gateway or a 401 would. */
export function failAdmin(method: string, path: string, message: string): void {
  failing.set(key(method, path), message);
}

/** Make `METHOD path` answer `value`. A spec that asserts on a response must seed it. */
export function seedAdmin(method: string, path: string, value: unknown): void {
  responses.set(key(method, path), value);
}

/** The recorded calls, optionally narrowed — the assertion surface for "what the UI sent". */
export function adminCalls(method?: string, path?: string): AdminCall[] {
  return calls.filter((c) => (method ? c.method === method : true) && (path ? c.path === path : true));
}

/** The bodies sent to `METHOD path`, which is what distinguishes one write from another. */
export function adminBodies(method: string, path: string): unknown[] {
  return adminCalls(method, path).map((c) => c.body);
}

/**
 * Shape-only fallbacks. Every `GET` in the admin surface returns a collection except the three
 * named here, and every write returns either `{ ok: true }` or — for the batch capture — a count.
 */
function defaultResponse(method: string, path: string): unknown {
  if (method === "GET") {
    if (path.startsWith("/admin/tools")) {
      return { enabled: true, mutationEnabled: true, persistedEnabled: true };
    }
    if (path.startsWith("/admin/memory/stats")) return { total: 0, byLayer: {}, injectable: 0 };
    if (path.startsWith("/admin/context")) return { nodes: [], edges: [] };
    return [];
  }
  if (path.startsWith("/admin/memory/batch")) return { captured: 0 };
  return { ok: true };
}

/** The `fetchAdmin` signature, verbatim — the fake is a drop-in for the real module. */
export async function fetchAdmin(method: string, path: string, body?: unknown): Promise<unknown> {
  calls.push({ method, path, body });
  const k = key(method, path);
  const failure = failing.get(k);
  if (failure) throw new Error(failure);
  if (responses.has(k)) return responses.get(k);
  return defaultResponse(method, path);
}

/** Present so a spec that clears the cached credential compiles against the same shape. */
export function clearUiSession(): void {
  /* the fake holds no credential */
}

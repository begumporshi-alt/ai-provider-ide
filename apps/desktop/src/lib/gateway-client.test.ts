/**
 * `fetchAdmin`'s 401 recovery — the handover's missing half (D64).
 *
 * The mechanism these tests pin: `gateway_disable` revokes the UI's session credential host-side
 * (D51), and the Start handover calls it. So bringing the service up revokes the key the webview
 * is still holding, and every `/admin/*` call afterwards presents a secret whose `gateway_keys`
 * row has been deleted. The recovery is to drop the cache and re-mint once against the new
 * listener — and to stop there, because a second refusal is a refusal.
 *
 * Asserted on the **Authorization header of the retry**, not on a call count alone: a retry that
 * re-sent the same stale key would satisfy "two calls" while fixing nothing.
 */
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => {
  const keys: string[] = [];
  let minted = 0;
  return {
    keys,
    nextKey: () => {
      minted += 1;
      const k = `ui-session-secret-${minted}`;
      keys.push(k);
      return k;
    },
    reset: () => {
      keys.length = 0;
      minted = 0;
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "ui_session_key") return h.nextKey();
    if (cmd === "gateway_status") return { port: 8800 };
    return null;
  },
}));

import { clearUiSession, fetchAdmin } from "./gateway-client";

const seen: Array<string | undefined> = [];
let respond: (n: number) => Response;

beforeEach(() => {
  seen.length = 0;
  h.reset();
  clearUiSession();
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push((init.headers as Record<string, string>).Authorization);
    return respond(seen.length);
  }) as unknown as typeof fetch;
});

const unauthorized = () =>
  new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("a 401 re-mints the credential and the retry succeeds with a different key", async () => {
  respond = (n) => (n === 1 ? unauthorized() : ok({ id: "key-01" }));

  await expect(fetchAdmin("POST", "/admin/api-keys", { label: "x" })).resolves.toEqual({
    id: "key-01",
  });

  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
  expect(seen[1]).toBe(`Bearer ui-session-secret-2`);
});

test("a second 401 is a refusal, not another retry", async () => {
  respond = () => unauthorized();

  await expect(fetchAdmin("POST", "/admin/api-keys", {})).rejects.toThrow(/401/);

  // Exactly one retry: re-minting against a real refusal would dress it up as a retry.
  expect(seen).toHaveLength(2);
});

test("a non-401 failure is not retried at all", async () => {
  respond = () => new Response("boom", { status: 500 });

  await expect(fetchAdmin("GET", "/admin/providers")).rejects.toThrow(/500/);

  expect(seen).toHaveLength(1);
});

test("a successful call mints once and never retries", async () => {
  respond = () => ok({ providers: [] });

  await expect(fetchAdmin("GET", "/admin/providers")).resolves.toEqual({ providers: [] });
  await expect(fetchAdmin("GET", "/admin/providers")).resolves.toEqual({ providers: [] });

  // Two requests, one mint: the cache is what keeps this off the host on every call.
  expect(seen).toHaveLength(2);
  expect(h.keys).toHaveLength(1);
});

/**
 * `gatewayBaseUrl` and the `gateway` settings row (audit M3).
 *
 * The defect these specs pin: the row was read with a bare `JSON.parse(raw) as { port?: number }`.
 * `gatewayBaseUrl` is awaited by `sendAdmin`, so a corrupt or hand-edited row threw inside **every**
 * `/admin/*` call — and the failure surfaced as a network fault, not as one bad settings row.
 *
 * The specs therefore assert two separate properties, and both matter:
 *
 * - **It resolves rather than rejects**, for every unusable row. A row the app cannot read is a row
 *   it does not have; the port is a preference, and the default is the honest answer.
 * - **It still honours a readable row**, including a hand-edited one. Falling back to `8787` when
 *   the row plainly says `9123` would dial a port the operator never configured — the same
 *   closed-port symptom the module comment already records once.
 *
 * `gateway_status` is the authority and is checked first, so the row is only consulted when the
 * status call yields no usable port.
 */
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: {} as unknown,
  row: null as string | null,
  invokes: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    h.invokes.push(cmd);
    if (cmd === "gateway_status") return h.status;
    if (cmd === "settings_get") return h.row;
    if (cmd === "ui_session_key") return "ui-session-secret-1";
    return undefined;
  },
}));

import { gatewayBaseUrl } from "./gateway-client";

beforeEach(() => {
  h.status = {};
  h.row = null;
  h.invokes = [];
});

test("the bound port from `gateway_status` wins, and the row is never read", async () => {
  h.status = { port: 8800 };
  h.row = JSON.stringify({ port: 9123 });

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:8800");
  expect(h.invokes).not.toContain("settings_get");
});

test("a zero or absent status port falls through to the row", async () => {
  h.status = { port: 0 };
  h.row = JSON.stringify({ port: 9123 });

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:9123");
});

test("a hand-edited row holding the port as a string is honoured, not discarded", async () => {
  // `{"port":"9123"}` is what a hand edit produces. The old `as` accepted it and the template
  // happened to render correctly; a naive strict guard would now drop it to 8787, which is a
  // *worse* answer than the one the row plainly states.
  h.row = JSON.stringify({ port: "9123" });

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:9123");
});

test("a corrupt row resolves to the default instead of throwing", async () => {
  // The M3 defect, verbatim: this used to reject out of `sendAdmin`'s URL builder.
  h.row = "{not json";

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:8787");
});

test("valid JSON of the wrong shape also resolves to the default", async () => {
  h.row = "[1,2]";

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:8787");
});

test("a port field that is not a port resolves to the default", async () => {
  for (const bad of ['"nope"', "-1", "0", "70000", "1.5", "null", "{}"]) {
    h.row = `{"port":${bad}}`;
    await expect(gatewayBaseUrl(), `port ${bad}`).resolves.toBe("http://127.0.0.1:8787");
  }
});

test("no row at all resolves to the default", async () => {
  h.row = null;

  await expect(gatewayBaseUrl()).resolves.toBe("http://127.0.0.1:8787");
});

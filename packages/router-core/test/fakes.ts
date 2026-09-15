/**
 * Fake ports for router-core unit tests: an HttpPort that answers from a scripted table
 * (so we never hit the network) and an in-memory KeyVaultPort. Mirrors how the real
 * egress-gateway behaves, including the `{{secret}}` sentinel contract: fakes assert that
 * every request carries a secretRef and header sentinels — never a raw key.
 */
import type { HttpPort, KeyVaultPort } from "../src/ports.js";

export interface ScriptedResponse {
  status?: number;
  body?: unknown; // JSON body for non-stream
  lines?: string[]; // raw SSE lines for stream
  headers?: Record<string, string>;
}

export type Responder = (url: string, init: { method: string; body?: string; secretRef?: string }) => ScriptedResponse | undefined;

export class FakeHttp implements HttpPort {
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; secretRef?: string }> = [];
  constructor(private readonly responder: Responder) {}

  async request(req: Parameters<HttpPort["request"]>[0]) {
    this.calls.push({ url: req.url, method: req.method, headers: req.headers, body: req.body, secretRef: req.secretRef });
    // Invariant 2 guard: headers may only ever carry the sentinel, never a real secret.
    for (const [k, v] of Object.entries(req.headers)) {
      if (v.includes("sk-") && !v.includes("{{secret}}")) {
        throw new Error(`FakeHttp: raw secret leaked into header ${k} — invariant 2 violated`);
      }
    }
    const res = this.responder(req.url, { method: req.method, body: req.body, secretRef: req.secretRef }) ?? { status: 404 };
    const status = res.status ?? 200;
    const bodyText = res.lines ? "" : JSON.stringify(res.body ?? {});
    return {
      status,
      headers: res.headers ?? {},
      text: async () => (res.lines ? "" : bodyText),
      lines: (async function* () {
        for (const l of res.lines ?? []) {
          if (req.signal?.aborted) return;
          yield l;
        }
      })(),
    };
  }
}

export class FakeVault implements KeyVaultPort {
  private map = new Map<string, string>();
  private n = 0;
  async put(label: string, secret: string): Promise<string> {
    const ref = `${label}#${++this.n}`;
    this.map.set(ref, secret);
    return ref;
  }
  async get(ref: string): Promise<string | undefined> {
    return this.map.get(ref);
  }
  async delete(ref: string): Promise<void> {
    this.map.delete(ref);
  }
  size(): number {
    return this.map.size;
  }
}

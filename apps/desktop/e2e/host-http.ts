/**
 * host-http.ts — the E2E stand-in for the Rust egress-gateway (src-tauri/src/egress.rs).
 *
 * Why this lives in apps/desktop/e2e and NOT in packages/router-core: router-core must never
 * hold a raw secret and never perform network I/O (security invariants 1-2). HttpPort is the
 * host boundary. In the real app that boundary is the Rust `egress_*` commands; in these live
 * tests it is this class. It is the ONLY place in the test process that combines a secret with
 * a request — the harness resolves secretRef -> secret here, substitutes the `{{secret}}`
 * sentinel, and drops the value, exactly as Rust does.
 *
 * Behavior is mirrored 1:1 from egress.rs so a green E2E means the same contract the Rust host
 * enforces is exercised over real HTTP:
 *   - allowlist: localhost always permitted; any other host must be explicitly allowed.
 *   - secretRef may only meet its OWN provider host (a stolen ref cannot be paired with an
 *     attacker URL).
 *   - sentinel discipline: a secret is injected only into `{{secret}}` slots; a request
 *     carrying a sentinel with no resolvable secret is refused rather than leaking the literal.
 *   - GET/POST only; redirects are never followed (auth headers would ride along).
 *   - SSE is re-framed to raw text lines split on \n with \r trimmed; a consumer that stops
 *     iterating (abort) cancels the upstream connection.
 */
import type { HttpPort } from "@aiprovider/router-core";

export const SENTINEL = "{{secret}}";

export type EgressKind =
  | "host_denied"
  | "bad_url"
  | "secret_missing"
  | "sentinel_missing"
  | "key_host_mismatch"
  | "method_not_permitted"
  | "http";

export class EgressError extends Error {
  constructor(readonly kind: EgressKind, message: string) {
    super(message);
    this.name = "EgressError";
  }
}

/** Resolves a secretRef the way the Rust host joins `api_keys` x `providers` in SQLite. */
export interface SecretResolver {
  (secretRef: string): { secret: string | undefined; expectedHost: string | undefined };
}

export interface HostHttpOptions {
  /** Non-local hosts the allowlist admits. Localhost is always allowed (dev providers). */
  allowHosts?: string[];
}

/** A request as recorded BEFORE secret substitution — the key-leak audit inspects these. */
export interface EgressAuditEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  secretRef?: string;
}

export function isLocal(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export class HostHttp implements HttpPort {
  readonly audit: EgressAuditEntry[] = [];
  private readonly allow = new Set<string>();

  constructor(
    private readonly resolveSecret: SecretResolver,
    opts?: HostHttpOptions,
  ) {
    for (const h of opts?.allowHosts ?? []) this.allow.add(h.toLowerCase());
  }

  async request(req: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    secretRef?: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    lines: AsyncIterable<string>;
  }> {
    // --- allowlist (invariant 3: no telemetry is mechanically true) ---
    let destHost: string;
    try {
      destHost = new URL(req.url).hostname;
    } catch {
      throw new EgressError("bad_url", `invalid url: ${req.url}`);
    }
    if (!isLocal(destHost) && !this.allow.has(destHost.toLowerCase())) {
      throw new EgressError("host_denied", `host not allowlisted: ${destHost} (invariant 3)`);
    }

    // --- secretRef -> own provider host pairing (the webview is untrusted) ---
    let secret: string | undefined;
    if (req.secretRef) {
      const r = this.resolveSecret(req.secretRef);
      const expected = r.expectedHost?.toLowerCase();
      if (r.secret === undefined || expected === undefined) {
        throw new EgressError(
          "secret_missing",
          `secret ${req.secretRef} not found in keychain (re-enter the key)`,
        );
      }
      if (expected !== destHost.toLowerCase()) {
        throw new EgressError(
          "key_host_mismatch",
          `secret_ref ${req.secretRef} may only be used against its own provider host ${expected} (got ${destHost})`,
        );
      }
      secret = r.secret;
    }

    // --- sentinel injection (the ONLY place a secret meets a header value) ---
    const hasSentinel = Object.values(req.headers).some((v) => v.includes(SENTINEL));
    if (secret !== undefined && !hasSentinel) {
      throw new EgressError(
        "sentinel_missing",
        `secret_ref given but no header carries the {{secret}} sentinel — refusing to send unauthenticated`,
      );
    }
    if (secret === undefined && hasSentinel) {
      throw new EgressError(
        "sentinel_missing",
        `no secret resolvable but a header carries the {{secret}} sentinel — refusing to leak the literal`,
      );
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = secret !== undefined ? v.split(SENTINEL).join(secret) : v;
    }

    // Pre-substitution record: a raw secret appearing here (outside the sentinel slot) is a leak.
    this.audit.push({ url: req.url, method: req.method, headers: { ...req.headers }, secretRef: req.secretRef });

    if (req.method !== "GET" && req.method !== "POST") {
      throw new EgressError("method_not_permitted", `method not permitted: ${req.method}`);
    }

    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.body,
        signal: req.signal,
        // v1: never follow redirects — a 3x would re-send auth (incl. x-api-key, which fetch's
        // default policy does NOT strip cross-host) to the redirect target (diff-review Blocker 1).
        redirect: "manual",
      });
    } catch (e) {
      throw new EgressError("http", `http error: ${String((e as Error).message ?? e)}`);
    }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k.toLowerCase()] = v));

    const body = new Body(res.body ?? null, req.signal);
    return {
      status: res.status,
      headers: resHeaders,
      text: () => body.text(),
      lines: body.lines(),
    };
  }
}

/**
 * Single-read body multiplexer: the interpreter calls text() (unary requests + the >=400 status
 * check) or iterates lines() (SSE) — never both concurrently. Either path may run first; the
 * second one replays from the buffered body instead of re-reading the stream.
 */
class Body {
  consumed = false;
  full = ""; // complete decoded body (text())
  pending = ""; // un-split tail (lines())
  private readonly decoder = new TextDecoder();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private readonly stream: ReadableStream<Uint8Array> | null,
    private readonly signal?: AbortSignal,
  ) {}

  feed(chunk?: Uint8Array): void {
    const s =
      chunk === undefined ? this.decoder.decode() : this.decoder.decode(chunk, { stream: true });
    this.full += s;
    this.pending += s;
  }

  async text(): Promise<string> {
    if (this.consumed) return this.full;
    for await (const chunk of this.chunks()) this.feed(chunk);
    this.feed();
    this.consumed = true;
    return this.full;
  }

  async *lines(): AsyncIterable<string> {
    if (this.consumed) {
      for (const l of this.full.split("\n")) yield l.replace(/\r$/, "");
      return;
    }
    for await (const chunk of this.chunks()) {
      this.feed(chunk);
      let idx: number;
      while ((idx = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, idx);
        this.pending = this.pending.slice(idx + 1);
        yield line.replace(/\r$/, "");
        if (this.signal?.aborted) {
          this.consumed = true;
          return; // consumer gone -> cancel upstream (§3.5)
        }
      }
    }
    this.feed(); // flush the decoder's trailing bytes
    this.consumed = true;
    if (this.pending.length) {
      yield this.pending.replace(/\r$/, ""); // trailing line with no newline
      this.pending = "";
    }
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    if (!this.stream) return;
    if (!this.reader) this.reader = this.stream.getReader();
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        /* already released (cancel/abort path) */
      }
    }
  }
}

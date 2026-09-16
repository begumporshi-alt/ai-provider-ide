/**
 * web-test/shim.ts — DEV-ONLY in-browser stand-in for the Rust host.
 *
 * The production UI is 100% Tauri-coupled: every host call goes through
 * `@tauri-apps/api/core`'s `invoke`, which reads `window.__TAURI_INTERNALS__`. This module
 * installs that object BEFORE `/src/main.tsx` boots, backed by an in-memory store and real
 * browser `fetch`, so the genuine, unmodified React UI can run in a plain browser and be
 * driven by Playwright — including typing, which the WRY webview can't accept from CUA.
 *
 * Host-boundary discipline is preserved 1:1 with the real app:
 *   - router-core stays key-blind and performs no network I/O;
 *   - THIS module is the only place in the browser process that combines a secret with a
 *     request (it owns the keychain map and substitutes the `{{secret}}` sentinel), exactly
 *     as `egress.rs` is the only such place in production, and as `e2e/host-http.ts` is in
 *     the live Node tests. Nothing else in the page ever sees a raw key.
 *
 * This file is excluded from the app build and the shipped binary. Do not import it from
 * anything under `src/` — it exists solely for `web-test/index.html`.
 */
import { seedByName, type SeedInput } from "./seeds";

// ---------------------------------------------------------------------------
// Store: the tables the Rust host owns (SQLite + keychain), in memory.
// ---------------------------------------------------------------------------

interface Row {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

const providers = new Map<string, Row>();
const keys = new Map<string, Row>();
const models: Row[] = [];
const manifests: Row[] = []; // every version; isActive marks the live one
const aliases: Row[] = [];
const settings = new Map<string, string>();
const ledger: Row[] = [];
const drift: { providerId: string; triggerJson: string; resolved: string | null }[] = [];
const audits: Row[] = [];
const sessions: Row[] = [];
/** secretRef (== key label) -> raw secret. The keychain. Never leaves this module. */
const keychain = new Map<string, string>();
let sessionSeq = 0;
let auditSeq = 0;

// ---------------------------------------------------------------------------
// Persistence: the real host commits every write to SQLite before it replies, so a restart
// finds the store where the app left it. sessionStorage gives this page the same property —
// it is scoped to this tab and cleared with it, so a seeded scenario never leaks into the
// next test's fresh browser context.
// ---------------------------------------------------------------------------

const SNAP_KEY = "webTestStore";

interface Snapshot {
  providers: Row[];
  keys: Row[];
  models: Row[];
  manifests: Row[];
  aliases: Row[];
  settings: [string, string][];
  ledger: Row[];
  drift: { providerId: string; triggerJson: string; resolved: string | null }[];
  audits: Row[];
  sessions: Row[];
  keychain: [string, string][];
}

function snapshot(): Snapshot {
  return {
    providers: [...providers.values()],
    keys: [...keys.values()],
    models: [...models],
    manifests: [...manifests],
    aliases: [...aliases],
    settings: [...settings.entries()],
    ledger: [...ledger],
    drift: [...drift],
    audits: [...audits],
    sessions: [...sessions],
    keychain: [...keychain.entries()],
  };
}

function restore(s: Snapshot): void {
  providers.clear();
  for (const p of s.providers) providers.set(p.id, { ...p });
  keys.clear();
  for (const k of s.keys) keys.set(k.id, { ...k });
  models.length = 0;
  models.push(...s.models);
  manifests.length = 0;
  manifests.push(...s.manifests);
  aliases.length = 0;
  aliases.push(...s.aliases);
  settings.clear();
  for (const [k, v] of s.settings) settings.set(k, v);
  ledger.length = 0;
  ledger.push(...s.ledger);
  drift.length = 0;
  drift.push(...s.drift);
  audits.length = 0;
  audits.push(...s.audits);
  sessions.length = 0;
  sessions.push(...s.sessions);
  keychain.clear();
  for (const [ref, secret] of s.keychain) keychain.set(ref, secret);
}

function persist(): void {
  try {
    sessionStorage.setItem(SNAP_KEY, JSON.stringify(snapshot()));
  } catch {
    // storage may be unavailable (private mode, disabled) — degrade to in-memory, as before
  }
}

function storedSnapshot(): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(SNAP_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeding (?seed=<name>) so multi-step scenarios don't need minutes of typing.
// Runs synchronously at import, before App bootstraps from the store.
// ---------------------------------------------------------------------------

// A stored snapshot always wins over the query param: a reload picks the store up exactly
// where the app left it, and ?seed= only ever initializes an empty database.
const seedName = new URLSearchParams(location.search).get("seed");
const stored = storedSnapshot();
if (stored) {
  restore(stored);
} else if (seedName) {
  // A broken seed must not take the app down with it: this runs before the internals install
  // below, so an exception here would otherwise leave the page with no host at all.
  try {
    applySeed(seedByName(seedName));
  } catch (e) {
    console.error(`[web-test] seed "${seedName}" failed:`, e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySeed(s: SeedInput | null): void {
  if (!s) return;
  for (const p of s.providers ?? []) providers.set(p.id, { ...p });
  for (const k of s.keys ?? []) {
    keys.set(k.id, { ...k });
    if (k.secret) keychain.set(k.secretRef, k.secret);
  }
  for (const m of s.models ?? []) models.push({ ...m });
  for (const m of s.manifests ?? []) manifests.push({ ...m });
  for (const a of s.aliases ?? []) aliases.push({ ...a });
  for (const [k, v] of Object.entries(s.settings ?? {})) settings.set(k, v);
}

// ---------------------------------------------------------------------------
// Tauri IPC primitives: invoke + the callback registry that Channel/events use.
// ---------------------------------------------------------------------------

const SERIALIZE = "__TAURI_TO_IPC_KEY__";
const callbacks = new Map<number, (raw: unknown) => void>();
let cbSeq = 0;

interface Internals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: (raw: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (p: string, protocol?: string) => string;
}

const internals: Internals = {
  async invoke(cmd, args = {}) {
    return handle(cmd, toWire(args));
  },
  transformCallback(cb, once = false) {
    const id = ++cbSeq;
    callbacks.set(id, (raw) => {
      cb(raw);
      if (once) callbacks.delete(id);
    });
    return id;
  },
  unregisterCallback(id) {
    callbacks.delete(id);
  },
  convertFileSrc(p) {
    return p;
  },
};

// Tauri serializes args (Channels become "__CHANNEL__:<id>" strings) — do the same so the
// shim sees exactly what Rust would see.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toWire(args: Record<string, unknown>): Record<string, any> {
  const json = JSON.stringify(args, (k, v) => {
    if (v && typeof v === "object" && SERIALIZE in v) return (v as Row)[SERIALIZE]();
    return v;
  });
  return JSON.parse(json);
}

/** Deliver a message to a Channel the webview handed us (egress_stream's `onEvent`). */
function emitToChannel(channelId: string, message: unknown, end = false): void {
  const m = /^__CHANNEL__:(\d+)$/.exec(channelId);
  if (!m) return;
  const cb = callbacks.get(Number(m[1]));
  if (!cb) return;
  const index = channelIndex(channelId);
  cb(end ? { index, end: true } : { index, message });
}

const channelCounters = new Map<string, number>();
function channelIndex(channelId: string): number {
  const n = (channelCounters.get(channelId) ?? -1) + 1;
  channelCounters.set(channelId, n);
  return n;
}
function closeChannel(channelId: string): void {
  emitToChannel(channelId, null, true);
  channelCounters.delete(channelId);
}

// --- events: the gateway bridge listens for "gateway-request" / "gateway-cancel" ---
const listeners = new Map<string, { eventId: number; cbId: number }[]>();
let eventSeq = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__webTest = {
  /** Emit a host->webview event, as the Rust gateway emitter would. */
  emit(event: string, payload: unknown): void {
    for (const l of listeners.get(event) ?? []) {
      const cb = callbacks.get(l.cbId);
      cb?.({ event, id: l.eventId, payload });
    }
  },
  /** Read-only view of the persisted store (spec assertions inspect this). */
  store: {
    providers: () => [...providers.values()],
    keys: () => [...keys.values()],
    ledger: () => [...ledger],
    aliases: () => [...aliases],
    manifests: () => [...manifests],
    settings: (k: string) => settings.get(k) ?? null,
  },
};

// ---------------------------------------------------------------------------
// The command table — mirrors src-tauri command-for-command.
// ---------------------------------------------------------------------------

async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await dispatch(cmd, args);
  persist(); // commit before the webview sees the reply, as the Rust host does
  return result;
}

async function dispatch(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    // ---- reads ----
    case "providers_list":
      return [...providers.values()];
    case "api_keys_list":
      return [...keys.values()].filter((k) => args.providerId == null || k.providerId === args.providerId);
    case "models_cache_list":
      return models;
    case "manifests_active":
      return manifests.filter((m) => m.isActive);
    case "manifests_history":
      return manifests
        .filter((m) => m.providerId === args.providerId)
        .sort((a, b) => b.version - a.version);
    case "aliases_list":
      return aliases;
    case "settings_get":
      return settings.get(args.key as string) ?? null;
    case "ledger_recent":
      return ledger.slice(-(args.limit as number));
    case "config_export":
      return {
        schemaVersion: 1,
        exportedAt: Date.now(),
        providers: [...providers.values()],
        keys: [...keys.values()].map(({ secretRef, ...rest }) => ({ ...rest, secretRef })), // refs, never secrets
        models,
        manifests: manifests.filter((m) => m.isActive),
        aliases,
        settings: Object.fromEntries(settings),
      };
    case "diagnostics_bundle":
      return JSON.stringify({
        schemaVersion: 1,
        ledger: ledger.slice(-50),
        drift: drift.map((d) => ({ providerId: d.providerId, resolved: d.resolved })),
        generatedAt: Date.now(),
      });
    case "onboarding_latest_active":
      return sessions.filter((s) => !s.outcome).slice(-1)[0] ?? null;

    // ---- writes ----
    case "provider_upsert": {
      const p = args.p as Row;
      providers.set(p.id, { ...p });
      return null;
    }
    case "provider_delete": {
      const id = args.id as string;
      providers.delete(id);
      for (const k of [...keys.values()].filter((k) => k.providerId === id)) keys.delete(k.id);
      for (let i = manifests.length - 1; i >= 0; i--) if (manifests[i].providerId === id) manifests.splice(i, 1);
      for (let i = models.length - 1; i >= 0; i--) if (models[i].providerId === id) models.splice(i, 1);
      for (let i = aliases.length - 1; i >= 0; i--) if (aliases[i].providerId === id) aliases.splice(i, 1);
      return null;
    }
    case "api_key_upsert": {
      const k = args.k as Row;
      keys.set(k.id, { ...k });
      return null;
    }
    case "api_key_delete": {
      const k = keys.get(args.id as string);
      if (k) keychain.delete(k.secretRef);
      keys.delete(args.id as string);
      return null;
    }
    case "models_cache_replace": {
      const pid = args.providerId as string;
      for (let i = models.length - 1; i >= 0; i--) if (models[i].providerId === pid) models.splice(i, 1);
      models.push(...(args.rows as Row[]));
      return null;
    }
    case "aliases_replace":
      aliases.splice(0, aliases.length, ...(args.rows as Row[]));
      return null;
    case "manifest_upsert_active": {
      const m = args.m as Row;
      if (m.isActive) for (const r of manifests.filter((r) => r.providerId === m.providerId)) r.isActive = false;
      manifests.push({ ...m });
      return null;
    }
    case "manifest_stage": {
      const m = args.m as Row;
      const next = manifests.filter((r) => r.providerId === m.providerId).reduce((n, r) => Math.max(n, r.version), 0) + 1;
      const row = { ...m, version: next, isActive: false };
      manifests.push(row);
      return next;
    }
    case "manifest_activate": {
      const pid = args.providerId as string;
      const version = args.version as number;
      const prevRow = manifests.find((r) => r.providerId === pid && r.isActive);
      for (const r of manifests.filter((r) => r.providerId === pid)) r.isActive = r.version === version;
      return prevRow && prevRow.version !== version ? prevRow.version : null;
    }
    case "settings_set":
      settings.set(args.key as string, args.valueJson as string);
      return null;
    case "ledger_append":
      ledger.push({ ...(args.e as Row) });
      return null;
    case "drift_event_record":
      drift.push({ providerId: args.providerId as string, triggerJson: args.triggerJson as string, resolved: null });
      return null;
    case "drift_event_resolve": {
      const d = drift.find((d) => d.providerId === args.providerId && !d.resolved);
      if (d) d.resolved = args.resolution as string;
      return null;
    }
    case "generator_audit_record":
      audits.push({ id: ++auditSeq, ...(args.e as Row) });
      return null;
    case "config_import": {
      const raw = args.raw as Row;
      let providersN = 0;
      let keysN = 0;
      for (const p of (raw.providers as Row[]) ?? []) {
        providers.set(p.id, { ...p, status: "draft" }); // forced draft: nothing routes until re-checked
        providersN++;
      }
      for (const k of (raw.keys as Row[]) ?? []) {
        keys.set(k.id, { ...k, status: "invalid" }); // keys must be re-entered (audit H7)
        keysN++;
      }
      return { providers: providersN, keys: keysN };
    }
    case "onboarding_save": {
      const row = args.row as Row;
      if (row.id == null) {
        const id = ++sessionSeq;
        sessions.push({ ...row, id });
        return id;
      }
      const existing = sessions.find((s) => s.id === row.id);
      if (existing) Object.assign(existing, row);
      else sessions.push({ ...row });
      return row.id;
    }

    // ---- keychain (the secret goes IN once and never comes OUT) ----
    case "vault_put":
      keychain.set(args.account as string, args.secret as string);
      return null;
    case "vault_delete":
      keychain.delete(args.account as string);
      return null;

    // ---- egress: the host boundary. Sentinel substitution happens HERE. ----
    case "egress_request":
      return egressUnary(args.req as WireReq);
    case "egress_stream":
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return egressStream(args.req as WireReq, args.onEvent as string);
    case "egress_fetch_image": {
      const req = args.req as { url: string; timeout_ms?: number | null };
      return fetchImage(req.url, req.timeout_ms ?? 30_000);
    }

    // ---- gateway bridge: the webview calls these; the real Rust gateway consumes them ----
    case "gateway_heartbeat":
    case "gateway_done":
    case "gateway_chunk":
    case "gateway_result":
    case "gateway_error":
      return null;

    // ---- events ----
    case "plugin:event|listen": {
      const event = args.event as string;
      const entry = { eventId: ++eventSeq, cbId: args.handler as number };
      (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(entry);
      return entry.eventId;
    }
    case "plugin:event|unlisten": {
      const arr = listeners.get(args.event as string) ?? [];
      const i = arr.findIndex((l) => l.eventId === args.eventId);
      if (i >= 0) arr.splice(i, 1);
      return null;
    }

    default:
      // Unknown commands must reject, exactly as Rust would, so a typo can't pass silently.
      throw new Error(`web-test shim: unknown command "${cmd}"`);
  }
}

// ---------------------------------------------------------------------------
// Egress — browser mirror of egress.rs / e2e/host-http.ts.
// ---------------------------------------------------------------------------

const SENTINEL = "{{secret}}";

interface WireReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
  secret_ref?: string | null;
  timeout_ms?: number | null;
}

function isLocal(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/**
 * Resolve a secretRef the way Rust joins api_keys x providers, and enforce the same pairing
 * rule: a ref may only meet its OWN provider host.
 */
function resolveSecret(secretRef: string): { secret: string; expectedHost: string } {
  const k = [...keys.values()].find((k) => k.secretRef === secretRef);
  if (!k) throw new Error(`secret ${secretRef} not found in keychain (re-enter the key)`);
  const p = providers.get(k.providerId);
  if (!p) throw new Error(`secret ${secretRef} has no provider (re-enter the key)`);
  let expectedHost: string;
  try {
    expectedHost = new URL(p.baseUrl).hostname;
  } catch {
    throw new Error(`provider ${p.slug} has an invalid baseUrl`);
  }
  const secret = keychain.get(secretRef);
  if (secret === undefined) throw new Error(`secret ${secretRef} not found in keychain (re-enter the key)`);
  return { secret, expectedHost };
}

/** Substitute the sentinel and enforce the egress contract; returns fetch-ready headers. */
function authorize(req: WireReq): Record<string, string> {
  let destHost: string;
  try {
    destHost = new URL(req.url).hostname;
  } catch {
    throw new Error(`invalid url: ${req.url}`);
  }
  if (!isLocal(destHost)) throw new Error(`host not allowlisted: ${destHost} (invariant 3)`);

  let secret: string | undefined;
  if (req.secret_ref) {
    const r = resolveSecret(req.secret_ref);
    if (r.expectedHost.toLowerCase() !== destHost.toLowerCase()) {
      throw new Error(
        `secret_ref ${req.secret_ref} may only be used against its own provider host ${r.expectedHost} (got ${destHost})`,
      );
    }
    secret = r.secret;
  }

  const hasSentinel = Object.values(req.headers).some((v) => v.includes(SENTINEL));
  if (secret !== undefined && !hasSentinel) {
    throw new Error("secret_ref given but no header carries the {{secret}} sentinel — refusing to send unauthenticated");
  }
  if (secret === undefined && hasSentinel) {
    throw new Error("no secret resolvable but a header carries the {{secret}} sentinel — refusing to leak the literal");
  }
  if (req.method !== "GET" && req.method !== "POST") throw new Error(`method not permitted: ${req.method}`);

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = secret !== undefined ? v.split(SENTINEL).join(secret) : v;
  return out;
}

async function egressUnary(req: WireReq): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const headers = authorize(req);
  const res = await fetch(req.url, { method: req.method, headers, body: req.body ?? undefined, redirect: "manual" });
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k.toLowerCase()] = v));
  const body = await res.text();
  recordReturnedHosts(body);
  return { status: res.status, headers: resHeaders, body };
}

// ---------------------------------------------------------------------------
// Image fetch — the invariant-3 carve-out, mirrored from egress.rs §fetch_image:
// a host returned in a provider response body is fetchable for a short window
// (scoped, expiring), never added to the allowlist; no secret is ever attached.
// ---------------------------------------------------------------------------

/** host -> recorded-at (ms). Transient: never persisted, never in the allowlist. */
const returnedHosts = new Map<string, number>();
const RETURNED_HOST_TTL_MS = 10 * 60 * 1000;
const IMAGE_FETCH_MAX_BYTES = 32 * 1024 * 1024;

function recordReturnedHosts(body: string): void {
  if (body.length > 2 * 1024 * 1024) return;
  const now = Date.now();
  let rest = body;
  for (;;) {
    const m = /https?:\/\/([A-Za-z0-9._\-[\]]+)/.exec(rest);
    if (!m) break;
    returnedHosts.set(m[1]!.toLowerCase(), now);
    rest = rest.slice(m.index + m[0].length);
  }
  for (const [h, t] of [...returnedHosts]) if (now - t > RETURNED_HOST_TTL_MS) returnedHosts.delete(h);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchImage(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; content_type: string; base64: string; bytes: number }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const providerHosts = new Set(
    [...providers.values()].map((p) => {
      try {
        return new URL(p.baseUrl as string).hostname.toLowerCase();
      } catch {
        return "";
      }
    }),
  );
  const lease = returnedHosts.get(host);
  const leased = lease !== undefined && Date.now() - lease <= RETURNED_HOST_TTL_MS;
  if (!isLocal(host) && !providerHosts.has(host) && !leased) {
    throw new Error(`image host not allowlisted: ${host} (invariant 3)`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // The browser follows redirects itself here; the Rust path re-validates each hop. The
    // mock never redirects, so this stays faithful for the harness's purposes.
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > IMAGE_FETCH_MAX_BYTES) throw new Error("response exceeds 32 MiB cap");
    const bytes = new Uint8Array(buf);
    return {
      status: res.status,
      content_type: res.headers.get("content-type") ?? "application/octet-stream",
      base64: bytesToBase64(bytes),
      bytes: bytes.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function egressStream(req: WireReq, onEvent: string): Promise<null> {
  let headers: Record<string, string>;
  try {
    headers = authorize(req);
  } catch (e) {
    emitToChannel(onEvent, { type: "error", message: String((e as Error).message ?? e) });
    closeChannel(onEvent);
    return null;
  }
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers, body: req.body ?? undefined, redirect: "manual" });
  } catch (e) {
    emitToChannel(onEvent, { type: "error", message: `http error: ${String((e as Error).message ?? e)}` });
    closeChannel(onEvent);
    return null;
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k.toLowerCase()] = v));
  emitToChannel(onEvent, { type: "headers", status: res.status, headers: resHeaders });

  if (res.status >= 400) {
    const body = await res.text().catch(() => "");
    emitToChannel(onEvent, { type: "error", message: `http ${res.status}: ${body || res.statusText}` });
    closeChannel(onEvent);
    return null;
  }

  const reader = (res.body ?? new ReadableStream({ start: (c) => c.close() })).getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        emitToChannel(onEvent, { type: "line", text: line.replace(/\r$/, "") });
      }
    }
    pending += decoder.decode();
    if (pending.length) emitToChannel(onEvent, { type: "line", text: pending.replace(/\r$/, "") });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  emitToChannel(onEvent, { type: "done" });
  closeChannel(onEvent);
  return null;
}

// Install BEFORE main.tsx executes. Vite loads this module first (document order), so the
// internals object exists when the app's first `invoke` fires.
(globalThis as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__ = internals;
(globalThis as unknown as {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, eventId: number) => void };
}).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, eventId) {
    const arr = listeners.get(event) ?? [];
    const i = arr.findIndex((l) => l.eventId === eventId);
    if (i >= 0) arr.splice(i, 1);
  },
};

export {};

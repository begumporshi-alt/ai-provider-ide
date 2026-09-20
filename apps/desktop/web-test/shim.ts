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
/**
 * Settings, backed by `localStorage` so they survive a page reload.
 *
 * Everything else in this mirror is deliberately per-load — a fresh page is a fresh app. Settings
 * are the exception because that is the entire point of a setting: the app reads it back on the
 * next launch. Without this, a spec could toggle something, reload, see the default again, and
 * there would be no way to tell "not persisted" from "the test reloaded the world".
 */
const SETTINGS_STORAGE_KEY = "web-test.settings";
const settings = new Map<string, string>((() => {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as [string, string][]) : [];
  } catch {
    return [];
  }
})());
function persistSettings(): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify([...settings]));
  } catch {
    // Storage unavailable (private mode, quota) — the in-memory map still works this session.
  }
}
const ledger: Row[] = [];
const drift: { providerId: string; triggerJson: string; resolved: string | null }[] = [];
const audits: Row[] = [];
const sessions: Row[] = [];
/** secretRef (== key label) -> raw secret. The keychain. Never leaves this module. */
const keychain = new Map<string, string>();
let sessionSeq = 0;
let auditSeq = 0;

// P4/P5/P6 tables. Mirrors of context.rs / skills.rs / orchestrator.rs — same vocabularies, same
// rejection rules — so a screen that renders here renders for the same reasons it will there.
const contextNodes: Row[] = [];
const contextEdges: Row[] = [];
const skills: Row[] = [];
const agentRuns: Row[] = [];
const agentSteps: Row[] = [];
// P7 memory. Mirrors memory.rs: same four layers, same dedupe-on-(layer,text) rule.
const memories: Row[] = [];

/**
 * Gateway status is host-owned — the Rust side owns the listener and the worker window, so there
 * is nothing in this page to derive it from. The shim models it as plain settable state and specs
 * drive it through `__webTest.gatewayStatus`. Until this existed, `gateway_status` was not in the
 * table at all, so the command threw, `status` stayed null and the Gateway screen rendered in its
 * "Stopped" branch whatever the host would have said — which made the screen's own copy untestable.
 */
const gatewayStatus = {
  running: false,
  port: 8787,
  hasKey: false,
  endpointUrl: "http://127.0.0.1:8787/v1",
  background: false,
  workerAwake: true,
  heartbeatAgeMs: 0,
  workerError: null as string | null,
};

const NODE_KINDS = ["artifact", "memory", "skill", "message"];
const EDGE_KINDS = [
  "produced", "used", "recalled", "follows", "references",
  "routes_to", "served_by", "aliases", "backed_by",
];
const RUN_STATUSES = ["running", "ok", "error", "stopped"];
/** memory.rs accepts exactly these four layers. */
const MEMORY_LAYERS = ["L0", "L1", "L2", "L3"];
const STEP_KINDS = ["assistant", "tool_call", "tool_result", "done", "denied"];
/** context.rs caps a repeated edge's weight so one hot pair cannot swamp the layout. */
const MAX_WEIGHT = 50;

// Tool sandbox emulation — the Rust tool_run lives behind a host that the browser harness does
// not run, so the shim provides a small virtual FS just enough to let an Assistant agent turn
// complete in tests. Path confinement mirrors tools.rs: paths containing ".." or starting "/"
// are refused (ok:false), the same way a real escape attempt would be.
const virtualFs = new Map<string, string>([["README.md", "hello\nworld\n"]]);
/** Directories created by `mkdir`. The virtual fs is flat, so dirs are tracked separately. */
const virtualDirs = new Set<string>();

/** What `tools_default_root` answers. There is no HOME or filesystem here, so the shim names a
 *  fixed absolute path — the same shape the host returns (`$HOME/AI-Provider-Router-Workspace`). */
const DEFAULT_WORKSPACE_ROOT = "/Users/tester/AI-Provider-Router-Workspace";

const TOOLS_POLICY = {
  programs: ["ls", "cat", "echo", "grep", "rg", "find", "git", "node", "npm", "npx", "pnpm", "python3", "make", "tar", "sed", "awk"],
  git_subcommands: ["status", "log", "diff", "show"],
  max_command_ms: 60_000,
  max_output_bytes: 64 * 1024,
};

/** Confinement: real tools.rs refuses paths containing ".." or starting with "/" (the root is
 *  stripped before resolution). Mirror it so tests catch escape attempts that production would. */
function isConfinedPath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").includes("..");
}

/** Sequence number from a node id (`skill:s-1:12` → 12). Ties break on ts, which is what
 *  re-keyed memory nodes are dated by. Mirrors `seq_of` in context.rs. */
function seqKey(id: string, ts: number): [number, number] {
  const tail = id.split(":").pop() ?? "";
  const n = Number(tail);
  return [Number.isFinite(n) && tail !== "" ? n : ts, ts];
}

function flattenPreview(label: string): string {
  const flat = label.split(/\s+/).filter((s) => s.length > 0).join(" ");
  return flat.length <= 120 ? flat : `${flat.slice(0, 120)}…`;
}

const BUILTIN_SKILLS: { slug: string; name: string; description: string; body: string }[] = [
  { slug: "code-review", name: "Code review", description: "Review a change for correctness, security and clarity before it lands.", body: "Review the change the user points at.\n\n1. Read the changed files.\n2. Look for correctness bugs, unhandled errors, security problems, then clarity.\n3. Report as a short list: file, line, what is wrong, why it matters." },
  { slug: "commit-message", name: "Commit message", description: "Write a conventional commit message from what actually changed.", body: "Write a commit message for the pending change.\n\n1. Inspect the change; do not guess from the branch name.\n2. First line: type(scope): summary, imperative, under 72 characters.\n3. Body: why the change was needed, not what it did." },
  { slug: "explain-code", name: "Explain code", description: "Explain a file, module or symbol to someone seeing it for the first time.", body: "Explain the code the user names.\n\n1. Read it before explaining it.\n2. Lead with the one thing it is for.\n3. Then the shape: entry points, main data flow, dependencies." },
  { slug: "test-writer", name: "Write tests", description: "Write focused tests for a module, covering behaviour rather than implementation.", body: "Write tests for the module the user names.\n\n1. Read the module and any existing tests.\n2. Cover behaviour: normal path, edge cases, error cases.\n3. Match the conventions already there." },
];

/** Builtins seed once, exactly as skills.rs does — otherwise a revoked one would come back. */
function seedSkillsOnce(): void {
  if (settings.get("skills_seeded") === "1") return;
  const now = Date.now();
  for (const b of BUILTIN_SKILLS) {
    if (!skills.some((s) => s.slug === b.slug)) {
      skills.push({ id: `builtin-${b.slug}`, slug: b.slug, name: b.name, description: b.description, version: "1.0.0", source: "builtin", body: b.body, enabled: true, installed_at: now });
    }
  }
  settings.set("skills_seeded", "1");
}

function slugifySkillName(name: string): string {
  const lowered = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
  const collapsed = lowered.replace(/-{2,}/g, "-");
  return collapsed === "" ? `skill-${Date.now()}` : collapsed;
}

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
  contextNodes: Row[];
  contextEdges: Row[];
  skills: Row[];
  agentRuns: Row[];
  agentSteps: Row[];
  memories: Row[];
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
    contextNodes: [...contextNodes],
    contextEdges: [...contextEdges],
    skills: [...skills],
    agentRuns: [...agentRuns],
    agentSteps: [...agentSteps],
    memories: [...memories],
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
  contextNodes.length = 0;
  contextNodes.push(...(s.contextNodes ?? []));
  contextEdges.length = 0;
  contextEdges.push(...(s.contextEdges ?? []));
  skills.length = 0;
  skills.push(...(s.skills ?? []));
  agentRuns.length = 0;
  agentRuns.push(...(s.agentRuns ?? []));
  agentSteps.length = 0;
  agentSteps.push(...(s.agentSteps ?? []));
  memories.length = 0;
  memories.push(...(s.memories ?? []));
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
  /**
   * Call a host command the way the UI would, so a spec can seed state the UI has no way to
   * produce on its own (an agent run, for instance, needs a real model round-trip).
   * Dev-only: it bypasses the React tree, so it is for arranging, never for asserting.
   */
  invoke: (cmd: string, args: Record<string, unknown> = {}) => handle(cmd, args),
  /** Read-only view of the persisted store (spec assertions inspect this). */
  store: {
    providers: () => [...providers.values()],
    keys: () => [...keys.values()],
    ledger: () => [...ledger],
    aliases: () => [...aliases],
    manifests: () => [...manifests],
    settings: (k: string) => settings.get(k) ?? null,
    skills: () => [...skills],
    contextNodes: () => [...contextNodes],
    contextEdges: () => [...contextEdges],
    agentRuns: () => [...agentRuns],
    agentSteps: () => [...agentSteps],
    memories: () => [...memories],
    /** Outgoing egress bodies, oldest first. Specs use this to assert what the app actually sent. */
    requests: () => [...egressLog],
  },
  /**
   * Set what `gateway_status` reports. The host owns the listener and the worker window, so a spec
   * cannot reach those states through the UI — arranging them here is the only way to test the
   * screen's copy for a sleeping worker or a lapsed heartbeat.
   */
  gatewayStatus: (next: Partial<typeof gatewayStatus>): void => {
    Object.assign(gatewayStatus, next);
  },
};

// ---------------------------------------------------------------------------
// The command table — mirrors src-tauri command-for-command.
// ---------------------------------------------------------------------------

/**
 * Tauri renames command arguments from camelCase (JS) to snake_case (Rust) — the macro does it
 * unconditionally, see tauri-macros' wrapper: "we always convert to camelCase". The command
 * table below mirrors Rust, so it has to be handed Rust-side names.
 *
 * Without this, a multi-word argument arrives as `undefined` and silently matches nothing:
 * `agent_run_steps` returned zero steps for a run that had three, because the UI sent `runId`
 * and the table read `run_id`. That failure mode is invisible without a live call, which is
 * exactly why it belongs here rather than in a comment.
 *
 * Only top-level keys are renamed — nested payloads are deserialized by serde with the names
 * the caller wrote, so a node's `session_id` is passed through untouched.
 */
function toRustArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = v;
  }
  return out;
}

async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await dispatch(cmd, toRustArgs(args));
  persist(); // commit before the webview sees the reply, as the Rust host does
  return result;
}

async function dispatch(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    // ---- reads ----
    case "providers_list":
      return [...providers.values()];
    case "api_keys_list":
      return [...keys.values()].filter((k) => args.provider_id == null || k.providerId === args.provider_id);
    case "models_cache_list":
      return models;
    case "manifests_active":
      return manifests.filter((m) => m.isActive);
    case "manifests_history":
      return manifests
        .filter((m) => m.providerId === args.provider_id)
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
      const pid = args.provider_id as string;
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
      const pid = args.provider_id as string;
      const version = args.version as number;
      const prevRow = manifests.find((r) => r.providerId === pid && r.isActive);
      for (const r of manifests.filter((r) => r.providerId === pid)) r.isActive = r.version === version;
      return prevRow && prevRow.version !== version ? prevRow.version : null;
    }
    case "settings_set":
      settings.set(args.key as string, args.value_json as string);
      persistSettings();
      return null;
    case "ledger_append":
      ledger.push({ ...(args.e as Row) });
      return null;
    case "drift_event_record":
      drift.push({ providerId: args.provider_id as string, triggerJson: args.trigger_json as string, resolved: null });
      return null;
    case "drift_event_resolve": {
      const d = drift.find((d) => d.providerId === args.provider_id && !d.resolved);
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
      return egressStream(args.req as WireReq, args.on_event as string);
    case "egress_fetch_image": {
      const req = args.req as { url: string; timeout_ms?: number | null };
      return fetchImage(req.url, req.timeout_ms ?? 30_000);
    }

    // ---- gateway status: host-reported, since the host owns the listener and the worker ----
    case "gateway_status":
      return { ...gatewayStatus };

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
      const i = arr.findIndex((l) => l.eventId === args.event_id);
      if (i >= 0) arr.splice(i, 1);
      return null;
    }

    // ---- P4: context graph ----
    case "context_record": {
      const nodes = (args.nodes ?? []) as Row[];
      const edges = (args.edges ?? []) as Row[];
      for (const n of nodes) {
        if (!NODE_KINDS.includes(n.kind)) throw new Error(`unknown node kind '${n.kind}'`);
      }
      for (const e of edges) {
        if (!EDGE_KINDS.includes(e.kind)) throw new Error(`unknown edge kind '${e.kind}'`);
      }
      for (const n of nodes) {
        const at = contextNodes.findIndex((x) => x.id === n.id);
        const row = { ...n };
        if (at >= 0) contextNodes[at] = { ...contextNodes[at], ...row };
        else contextNodes.push(row);
      }
      for (const e of edges) {
        // Rust rejects a dangling edge inside the same transaction, after the nodes above
        // landed. The UI must never be handed a line to nothing.
        const known =
          contextNodes.some((n) => n.id === e.from_id) && contextNodes.some((n) => n.id === e.to_id);
        if (!known) {
          throw new Error(`edge ${e.id} references a node that is not recorded: ${e.from_id} -> ${e.to_id}`);
        }
        const at = contextEdges.findIndex((x) => x.from_id === e.from_id && x.to_id === e.to_id && x.kind === e.kind);
        if (at >= 0) {
          contextEdges[at] = {
            ...contextEdges[at],
            weight: Math.min((contextEdges[at].weight as number) + (e.weight as number), MAX_WEIGHT),
            ts: e.ts,
            meta_json: e.meta_json ?? null,
          };
        } else {
          contextEdges.push({ ...e });
        }
      }
      return null;
    }
    case "context_graph": {
      // Newest first, and only edges whose both endpoints survive the node limit — so the
      // caller never has to reconcile an edge against a node it was not given.
      const limit = (args.limit as number) ?? 400;
      const nodes = [...contextNodes].sort((a, b) => (b.ts as number) - (a.ts as number)).slice(0, limit);
      const keep = new Set(nodes.map((n) => n.id));
      const edges = [...contextEdges]
        .filter((e) => keep.has(e.from_id) && keep.has(e.to_id))
        .sort((a, b) => (b.ts as number) - (a.ts as number))
        .slice(0, limit * 8);
      return { nodes, edges };
    }
    case "context_clear":
      contextNodes.length = 0;
      contextEdges.length = 0;
      return null;

    // ---- history: sessions and timelines ----
    // A mirror of context.rs `sessions`/`timeline`, not a stand-in for them. The ordering rule
    // matters here too: one agent run is recorded in one batch, so timestamps tie and the
    // sequence number in the node id is what puts the turns in the right order.
    case "history_sessions": {
      const limit = (args.limit as number) ?? 100;
      const groups = new Map<string, Row[]>();
      for (const n of contextNodes) {
        const sid = n.session_id;
        if (sid === null || sid === undefined) continue;
        const k = String(sid);
        const arr = groups.get(k) ?? [];
        arr.push(n);
        groups.set(k, arr);
      }
      const rows = [...groups.entries()].map(([session_id, ns]) => {
        const ts = ns.map((n) => Number(n.ts ?? 0));
        return {
          session_id,
          started_ts: Math.min(...ts),
          ended_ts: Math.max(...ts),
          turns: ns.filter((n) => n.kind === "message").length,
          tool_calls: ns.filter((n) => n.kind === "skill").length,
          preview: "",
          model: null as string | null,
        };
      });
      rows.sort((a, b) => b.ended_ts - a.ended_ts);
      const page = rows.slice(0, limit);

      const firstUser = new Map<string, string>();
      const anyMessage = new Map<string, string>();
      const models = new Map<string, string>();
      for (const n of [...contextNodes].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))) {
        const sid = n.session_id;
        if (sid === null || sid === undefined || n.kind !== "message") continue;
        const k = String(sid);
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(String(n.meta_json ?? "{}")) as Record<string, unknown>;
        } catch {
          meta = {};
        }
        if (typeof meta.model === "string" && !models.has(k)) models.set(k, meta.model);
        const label = String(n.label ?? "");
        if (!anyMessage.has(k)) anyMessage.set(k, label);
        if (meta.role === "user" && !firstUser.has(k)) firstUser.set(k, label);
      }
      for (const r of page) {
        const raw = firstUser.get(r.session_id) ?? anyMessage.get(r.session_id) ?? "";
        r.preview = flattenPreview(raw);
        r.model = models.get(r.session_id) ?? null;
      }
      return page;
    }
    case "history_timeline": {
      const sessionId = String(args.session_id ?? "");
      const nodes = contextNodes
        .filter((n) => String(n.session_id ?? "") === sessionId)
        .sort((a, b) => {
          const ka = seqKey(String(a.id ?? ""), Number(a.ts ?? 0));
          const kb = seqKey(String(b.id ?? ""), Number(b.ts ?? 0));
          return ka[0] - kb[0] || ka[1] - kb[1];
        });
      const byId = new Map(nodes.map((n) => [String(n.id), n]));
      const edges = contextEdges.filter((e) => byId.has(String(e.from_id)));
      const toolsOf = new Map<string, string[]>();
      const resultsOf = new Map<string, string[]>();
      const recalled = new Map<string, number>();
      for (const e of edges) {
        const from = String(e.from_id);
        const to = String(e.to_id);
        if (e.kind === "used") {
          const arr = toolsOf.get(from) ?? [];
          arr.push(to);
          toolsOf.set(from, arr);
        } else if (e.kind === "produced") {
          const target = byId.get(to);
          if (target) {
            const arr = resultsOf.get(from) ?? [];
            arr.push(String(target.label ?? ""));
            resultsOf.set(from, arr);
          }
        } else if (e.kind === "recalled") {
          recalled.set(from, (recalled.get(from) ?? 0) + 1);
        }
      }
      const entries: Row[] = [];
      for (const n of nodes) {
        if (n.kind !== "message") continue;
        const id = String(n.id);
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(String(n.meta_json ?? "{}")) as Record<string, unknown>;
        } catch {
          meta = {};
        }
        entries.push({
          kind: meta.role === "user" ? "user" : "assistant",
          ts: Number(n.ts ?? 0),
          text: String(n.label ?? ""),
          detail: null,
          model: typeof meta.model === "string" ? meta.model : null,
          memories: recalled.get(id) ?? 0,
        });
        const calls = (toolsOf.get(id) ?? []).sort(
          (x, y) =>
            seqKey(x, Number(byId.get(x)?.ts ?? 0))[0] - seqKey(y, Number(byId.get(y)?.ts ?? 0))[0],
        );
        for (const call of calls) {
          const target = byId.get(call);
          const detail = (resultsOf.get(call) ?? [])
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .join("\n");
          entries.push({
            kind: "tool",
            ts: Number(target?.ts ?? n.ts ?? 0),
            text: String(target?.label ?? call),
            detail: detail === "" ? null : detail,
            model: null,
            memories: 0,
          });
        }
      }
      return { session_id: sessionId, entries };
    }

    // ---- P5: skills ----
    case "skills_list":
      seedSkillsOnce();
      return [...skills].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    case "skills_catalog":
      return BUILTIN_SKILLS.map((b) => ({
        id: `builtin-${b.slug}`, slug: b.slug, name: b.name, description: b.description,
        version: "1.0.0", source: "builtin", body: b.body, enabled: true, installed_at: 0,
      }));
    case "skills_install": {
      // A skill with no instructions cannot be followed, so it is refused rather than stored.
      if (typeof args.body !== "string" || args.body.trim() === "") {
        throw new Error("a skill needs instructions");
      }
      const slug = (args.slug as string) || slugifySkillName(String(args.name ?? ""));
      const row: Row = {
        id: `user-${slug}`, slug, name: args.name, description: args.description ?? "",
        version: "1.0.0",
        source: BUILTIN_SKILLS.some((b) => b.slug === slug) ? "builtin" : "user",
        body: args.body, enabled: true, installed_at: Date.now(),
      };
      const at = skills.findIndex((s) => s.slug === slug);
      if (at >= 0) skills[at] = { ...skills[at], ...row };
      else skills.push(row);
      return skills.find((s) => s.slug === slug);
    }
    case "skills_uninstall": {
      const at = skills.findIndex((s) => s.slug === args.slug);
      if (at >= 0) skills.splice(at, 1);
      return null;
    }
    case "skills_set_enabled": {
      const row = skills.find((s) => s.slug === args.slug);
      if (row) row.enabled = Boolean(args.enabled);
      return null;
    }
    case "skills_parse": {
      const text = String(args.text ?? "");
      let name = "";
      let description = "";
      let body = text;
      if (text.startsWith("---")) {
        const end = text.indexOf("\n---", 3);
        if (end >= 0) {
          const front = text.slice(3, end);
          body = text.slice(end + 4).replace(/^\n+/, "");
          for (const line of front.split("\n")) {
            const at = line.indexOf(":");
            if (at < 0) continue;
            const k = line.slice(0, at).trim();
            const v = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
            if (k === "name") name = v;
            else if (k === "description") description = v;
          }
        }
      }
      return { name, description, body };
    }
    case "skills_slugify":
      return slugifySkillName(String(args.name ?? ""));

    // ---- Tool sandbox (Assistant agent mode) ----
    case "tools_policy":
      return TOOLS_POLICY;
    case "tools_default_root":
      return DEFAULT_WORKSPACE_ROOT;
    case "tools_check_root": {
      // Mirrors tools.rs::validate_root closely enough for the UI: absolute, not the filesystem
      // root, not a system directory. The shim has no real filesystem, so it judges the string —
      // a spec that needs a root to be REJECTED must therefore pick one of these, not just any
      // missing path.
      const r = String(args.root ?? "").trim();
      if (!r.startsWith("/")) throw new Error("workspace root must be an absolute path");
      if (r === "/") throw new Error("workspace root cannot be the filesystem root");
      for (const bad of ["/System", "/usr", "/bin", "/sbin", "/etc", "/private"]) {
        if (r === bad) throw new Error(`workspace root cannot be a system directory (${bad})`);
      }
      return null;
    }
    case "tool_run": {
      // The Rust host collapses (name, args, root) into a single `req` object — match that shape
      // so the host-side allowlist, path confinement and timeout run the same code paths in test.
      const req = args.req as { name: string; arguments: Record<string, unknown>; root: string } | undefined;
      if (!req) throw new Error("tool_run: missing req");
      const { name, arguments: toolArgs } = req;
      const ok = (output: string): { ok: boolean; output: string } => ({ ok: true, output });
      const fail = (error: string): { ok: boolean; output: string; error: string } => ({ ok: false, output: "", error });

      if (name === "list_dir") {
        const p = String(toolArgs["path"] ?? ".");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const prefix = p === "." || p === "" ? "" : p + "/";
        const entries = [...virtualFs.keys()].filter((k) => k.startsWith(prefix));
        // Non-recursive keeps its historical shape (bare names) — specs assert on it.
        if (toolArgs["recursive"] !== true) {
          return ok(entries.map((k) => k.slice(prefix.length)).join("\n") || "");
        }
        const dirs = [...virtualDirs]
          .filter((d) => d.startsWith(prefix))
          .map((d) => d.slice(prefix.length))
          .filter((d) => d.length > 0);
        const listed = [
          ...new Set([...dirs.map((d) => `dir  ${d}`), ...entries.map((k) => `file ${k.slice(prefix.length)}`)]),
        ];
        return ok(listed.join("\n") || "");
      }
      if (name === "read_file") {
        const p = String(toolArgs["path"] ?? "");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const c = virtualFs.get(p);
        if (c === undefined) return fail("no such file");
        const offset = Number(toolArgs["offset"] ?? 0);
        const limit = toolArgs["limit"] === undefined ? undefined : Number(toolArgs["limit"]);
        if (!offset && limit === undefined) return ok(c);
        const lines = c.split("\n");
        const from = Math.max(0, Math.min(offset - 1, lines.length));
        const to = limit === undefined ? lines.length : Math.min(from + limit, lines.length);
        return ok(`[lines ${from + 1}-${to} of ${lines.length}]\n${lines.slice(from, to).join("\n")}`);
      }
      if (name === "search_files") {
        const pattern = String(toolArgs["pattern"] ?? "");
        if (!pattern) return fail('"pattern" is empty');
        const p = String(toolArgs["path"] ?? ".");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const cs = toolArgs["case_sensitive"] === true;
        const needle = cs ? pattern : pattern.toLowerCase();
        const prefix = p === "." || p === "" ? "" : p + "/";
        const hits: string[] = [];
        for (const [k, v] of [...virtualFs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (!k.startsWith(prefix)) continue;
          v.split("\n").forEach((line, i) => {
            const hay = cs ? line : line.toLowerCase();
            if (hay.includes(needle)) hits.push(`${k}:${i + 1}: ${line.trimEnd()}`);
          });
        }
        return ok(hits.length > 0 ? hits.join("\n") : `no matches for "${pattern}"`);
      }
      if (name === "file_info") {
        const p = String(toolArgs["path"] ?? "");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const c = virtualFs.get(p);
        if (c !== undefined) {
          return ok(`path: ${p}\nexists: yes\nkind: file\nsize: ${c.length} bytes\nmodified: 0 (unix seconds)`);
        }
        if (virtualDirs.has(p)) {
          return ok(`path: ${p}\nexists: yes\nkind: directory\nsize: 0 bytes\nmodified: 0 (unix seconds)`);
        }
        return ok(`${p}: does not exist`);
      }
      if (name === "write_file") {
        const p = String(toolArgs["path"] ?? "");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        virtualFs.set(p, String(toolArgs["content"] ?? ""));
        return ok("");
      }
      if (name === "edit_file") {
        const p = String(toolArgs["path"] ?? "");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const c = virtualFs.get(p);
        if (c === undefined) return fail("cannot read: no such file");
        const oldText = String(toolArgs["old"] ?? "");
        const newText = String(toolArgs["new"] ?? "");
        if (!oldText) return fail('"old" must not be empty — there is nothing to match');
        const count = c.split(oldText).length - 1;
        if (count === 0) {
          return fail(
            `the text to replace was not found in ${p} — read the file and quote it exactly, including indentation`,
          );
        }
        const all = toolArgs["replace_all"] === true;
        if (count > 1 && !all) {
          return fail(
            `"old" occurs ${count} times in ${p}. A replacement has to be unambiguous — quote more surrounding lines, or pass replace_all:true to change every one`,
          );
        }
        const updated = all ? c.split(oldText).join(newText) : c.replace(oldText, newText);
        virtualFs.set(p, updated);
        return ok(
          `edited ${p}: replaced ${count} occurrence${count === 1 ? "" : "s"} (${c.length} → ${updated.length} bytes)`,
        );
      }
      if (name === "mkdir") {
        const p = String(toolArgs["path"] ?? "");
        if (!isConfinedPath(p)) return fail("path escapes the workspace");
        const parts = p.split("/").filter((s) => s.length > 0);
        for (let i = 1; i <= parts.length; i++) virtualDirs.add(parts.slice(0, i).join("/"));
        return ok(`created directory ${p}`);
      }
      if (name === "run_command") {
        const program = String(toolArgs["program"] ?? "");
        const cmdArgs = Array.isArray(toolArgs["args"]) ? toolArgs["args"].map(String) : [];
        if (!TOOLS_POLICY.programs.includes(program)) return fail(`program '${program}' is not in the allowlist`);
        if (program === "ls") {
          const target = cmdArgs[0] ?? ".";
          if (!isConfinedPath(target)) return fail("path escapes the workspace");
          const prefix = target === "." || target === "" ? "" : target + "/";
          return ok([...virtualFs.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).join("\n"));
        }
        if (program === "cat") {
          const target = cmdArgs[0] ?? "";
          if (!isConfinedPath(target)) return fail("path escapes the workspace");
          const c = virtualFs.get(target);
          if (c === undefined) return fail("no such file");
          return ok(c);
        }
        if (program === "echo") return ok(cmdArgs.join(" "));
        return ok("");
      }
      return fail(`unknown tool '${name}'`);
    }

    // ---- P6: agent orchestrator ----
    case "agent_runs_list": {
      const limit = (args.limit as number) ?? 50;
      return [...agentRuns].sort((a, b) => (b.started_at as number) - (a.started_at as number)).slice(0, limit);
    }
    case "agent_run_start": {
      if (!RUN_STATUSES.includes("running")) throw new Error("running is not a valid status");
      agentRuns.push({
        id: args.id, session_id: args.session_id ?? null, model: args.model,
        status: "running", prompt: args.prompt ?? null, iterations: 0, tool_calls: 0,
        started_at: Date.now(), ended_at: null, error: null,
      });
      return null;
    }
    case "agent_step_append": {
      const runId = args.run_id as string;
      if (!agentRuns.some((r) => r.id === runId)) throw new Error(`unknown run ${runId}`);
      if (!STEP_KINDS.includes(args.kind as string)) throw new Error(`unknown step kind '${args.kind}'`);
      const seq = agentSteps.filter((s) => s.run_id === runId).length;
      agentSteps.push({
        run_id: runId, seq, kind: args.kind, label: args.label ?? null,
        detail: args.detail ?? null, ok: args.ok ?? null, ts: Date.now(),
      });
      if (args.kind === "tool_call") {
        const run = agentRuns.find((r) => r.id === runId)!;
        run.tool_calls = (run.tool_calls as number) + 1;
      }
      return null;
    }
    case "agent_run_finish": {
      const runId = args.run_id as string;
      if (!RUN_STATUSES.includes(args.status as string)) throw new Error(`unknown status '${args.status}'`);
      const run = agentRuns.find((r) => r.id === runId);
      if (run) {
        run.status = args.status;
        run.iterations = args.iterations ?? 0;
        run.error = args.error ?? null;
        run.ended_at = Date.now();
      }
      return null;
    }
    case "agent_run_steps": {
      const runId = args.run_id as string;
      return agentSteps.filter((s) => s.run_id === runId).sort((a, b) => (a.seq as number) - (b.seq as number));
    }

    // ---- P7: memory ----
    // Ranking here is word-overlap, NOT BM25 — the real ranking is SQLite FTS5 and is pinned by
    // the Rust tests in memory.rs. The shim only has to be good enough for the screen to render
    // and for the actions to wire up; a test that depended on exact scores would be testing the
    // emulation, not the app.
    case "memory_capture": {
      const layer = String(args.layer ?? "");
      if (!MEMORY_LAYERS.includes(layer)) throw new Error(`unknown memory layer '${layer}'`);
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("memory text is empty");
      const now = Date.now();
      const seen = memories.find((m) => m.layer === layer && m.text === text);
      if (seen) {
        seen.updated_at = now;
        seen.session_id = (args.session_id as string | null) ?? seen.session_id;
        seen.subject = (args.subject as string | null) ?? seen.subject;
        if (args.pinned) seen.pinned = 1;
        return { ...seen };
      }
      const row: Row = {
        id: `m-${layer}-${memories.length + 1}-${now}`, layer, text,
        session_id: args.session_id ?? null, subject: args.subject ?? null,
        created_at: now, updated_at: now, pinned: args.pinned ? 1 : 0,
      };
      memories.push(row);
      return { ...row };
    }
    case "memory_capture_batch": {
      const items = (args.items as Row[] | undefined) ?? [];
      for (const it of items) {
        if (!MEMORY_LAYERS.includes(String(it.layer))) {
          throw new Error(`unknown memory layer '${it.layer}'`);
        }
      }
      let n = 0;
      for (const it of items) {
        const text = String(it.text ?? "").trim();
        if (!text) continue;
        const now = Date.now();
        const seen = memories.find((m) => m.layer === it.layer && m.text === text);
        if (seen) {
          seen.updated_at = now;
        } else {
          memories.push({
            id: `m-${it.layer}-${memories.length + 1}-${now}`, layer: it.layer, text,
            session_id: it.session_id ?? null, subject: it.subject ?? null,
            created_at: now, updated_at: now, pinned: it.pinned ? 1 : 0,
          });
        }
        n += 1;
      }
      return n;
    }
    case "memory_recall": {
      const limit = (args.limit as number) ?? 8;
      const layers = (args.layers as string[] | null | undefined) ?? null;
      if (layers) {
        for (const l of layers) {
          if (!MEMORY_LAYERS.includes(l)) throw new Error(`unknown memory layer '${l}'`);
        }
      }
      const words = String(args.query ?? "")
        .split(/[^A-Za-z0-9]+/)
        .filter((w) => w.length > 0);
      if (words.length === 0) return [];
      const scored = memories
        .filter((m) => !layers || layers.includes(String(m.layer)))
        .map((m) => {
          const hay = String(m.text).toLowerCase();
          let hits = 0;
          for (const w of words) if (hay.includes(w.toLowerCase())) hits += 1;
          return { m, score: hits === 0 ? null : -(hits / words.length) };
        })
        .filter((x) => x.score !== null) as { m: Row; score: number }[];
      // Mirrors memory.rs's ordering policy: relevance band first, then recency, then
      // L3 > L2 > L1 > L0. The *score* is word overlap rather than BM25 (see the note above), but
      // the ordering policy is the host's, because that is what specs observe.
      const rank: Record<string, number> = { L3: 0, L2: 1, L1: 2, L0: 3 };
      const REL_BAND = 0.15;
      const HALF_LIFE_MS = 30 * 86_400_000;
      const bestRel = scored.reduce((mx, x) => Math.max(mx, -x.score), 0);
      // Band 0 is "within REL_BAND of the best match"; each step up is one band worse.
      const bandOf = (x: { score: number }) =>
        bestRel <= 0 ? 0 : Math.floor((bestRel + x.score) / bestRel / REL_BAND);
      // L3 is exempt: a core fact is core because the user wrote it down, not because it is recent.
      const recencyOf = (x: { m: Row }) =>
        String(x.m.layer) === "L3"
          ? 1000
          : Math.round(
              Math.pow(0.5, Math.max(0, Date.now() - Number(x.m.updated_at)) / HALF_LIFE_MS) * 1000,
            );
      scored.sort((a, b) =>
        bandOf(a) - bandOf(b) ||
        recencyOf(b) - recencyOf(a) ||
        (rank[String(a.m.layer)] ?? 9) - (rank[String(b.m.layer)] ?? 9));
      return scored.slice(0, limit).map((x) => ({ ...x.m, score: x.score }));
    }
    case "memory_list": {
      const limit = (args.limit as number) ?? 200;
      const layer = (args.layer as string | null | undefined) ?? null;
      if (layer && !MEMORY_LAYERS.includes(layer)) throw new Error(`unknown memory layer '${layer}'`);
      return memories
        .filter((m) => !layer || m.layer === layer)
        .sort((a, b) =>
          (b.pinned as number) - (a.pinned as number) || (b.updated_at as number) - (a.updated_at as number))
        .slice(0, limit);
    }
    case "memory_forget": {
      const at = memories.findIndex((m) => m.id === args.id);
      if (at < 0) return false;
      memories.splice(at, 1);
      return true;
    }
    case "memory_set_pinned": {
      const row = memories.find((m) => m.id === args.id);
      if (!row) return false;
      row.pinned = args.pinned ? 1 : 0;
      row.updated_at = Date.now();
      return true;
    }
    case "memory_update": {
      const row = memories.find((m) => m.id === args.id);
      if (!row) return false;
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("memory text is empty");
      row.text = text;
      row.updated_at = Date.now();
      return true;
    }
    case "memory_session_atoms": {
      const sessionId = String(args.session_id ?? "");
      const layer = String(args.layer ?? "");
      if (!MEMORY_LAYERS.includes(layer)) throw new Error(`unknown memory layer '${layer}'`);
      const limit = (args.limit as number) ?? 200;
      return memories
        .filter((m) => m.session_id === sessionId && m.layer === layer)
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit);
    }
    case "memory_clear":
      memories.length = 0;
      return null;
    case "memory_stats": {
      const s = { l0: 0, l1: 0, l2: 0, l3: 0, total: memories.length, bytes: 0 };
      for (const m of memories) {
        s.bytes += String(m.text).length;
        if (m.layer === "L0") s.l0 += 1;
        else if (m.layer === "L1") s.l1 += 1;
        else if (m.layer === "L2") s.l2 += 1;
        else if (m.layer === "L3") s.l3 += 1;
      }
      return s;
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
  recordEgress({ url: req.url, body: req.body ?? null });
  return { status: res.status, headers: resHeaders, body };
}

/**
 * Outgoing-egress log for the harness. The shim is the only thing that talks to the mock, so
 * capturing here is equivalent to capturing on the network — and lets a spec assert on what
 * the app actually sent, including the system messages the Assistant injects for memory.
 *
 * Dev-only: bounded so a long run can't grow this without limit.
 */
const EGRESS_LOG_LIMIT = 50;
const egressLog: { url: string; body: string | null }[] = [];
function recordEgress(entry: { url: string; body: string | null }): void {
  egressLog.push(entry);
  if (egressLog.length > EGRESS_LOG_LIMIT) egressLog.splice(0, egressLog.length - EGRESS_LOG_LIMIT);
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
  recordEgress({ url: req.url, body: req.body ?? null });
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

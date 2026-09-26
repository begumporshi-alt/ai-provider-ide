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
 *     request (it owns the secrets map and substitutes the `{{secret}}` sentinel), exactly
 *     as `egress.rs` is the only such place in production, and as `e2e/host-http.ts` is in
 *     the live Node tests. Nothing else in the page ever sees a raw key.
 *
 * This file is excluded from the app build and the shipped binary. Do not import it from
 * anything under `src/` — it exists solely for `web-test/index.html`.
 */
import { seedByName, type SeedInput } from "./seeds";

// ---------------------------------------------------------------------------
// Store: the tables the Rust host owns (SQLite + secrets), in memory.
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
/**
 * The drift history. Mirrors `drift_events`.
 *
 * `id` and `detectedAt` are here because the reader orders on them (`detected_at DESC, id DESC`), and a
 * fixture without them could not pin that ordering — nor the tie-break, which is the rule most likely to
 * be lost. `id` is the insertion index, so it is monotonic the way the host's rowid is.
 *
 * Named rather than inlined because `Snapshot` carries the same shape: while this was written out twice,
 * the persisted-session type kept the old one and `restore` quietly stopped compiling.
 */
type DriftRow = {
  id: number;
  providerId: string;
  detectedAt: number;
  triggerJson: string;
  resolved: string | null;
  resolvedAt: number | null;
};
const drift: DriftRow[] = [];
const audits: Row[] = [];
const sessions: Row[] = [];
/** secretRef (== key label) -> raw secret. Stands in for the host's secrets file. Never leaves this module. */
const secrets = new Map<string, string>();
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
 * Gateway status is host-owned — the Rust side owns the listener, so there is nothing in this page
 * to derive it from. The shim models it as plain settable state and specs drive it through
 * `__webTest.gatewayStatus`. Until this existed, `gateway_status` was not in the table at all, so
 * the command threw, `status` stayed null and the Gateway screen rendered in its "Stopped" branch
 * whatever the host would have said — which made the screen's own copy untestable.
 */
const gatewayStatus = {
  running: false,
  port: 8787,
  hasKey: false,
  endpointUrl: "http://127.0.0.1:8787/v1",
};

const serviceStatus = {
  plistPresent: false,
  loaded: false,
  pid: null as number | null,
};

/**
 * The commands the login-item card issued, in the order the screen issued them.
 *
 * `gateway_disable` is in here alongside the four `service_*` verbs because it is the *first half*
 * of Start: the agent and the app's listener bind the same port, so Start has to release the port
 * before it asks launchd for the job. An order between two commands cannot be asserted from two
 * separate spies, and asserting it is the whole point — a Start that bootstrapped first and freed
 * the port second would leave exactly the throttled job the button exists to clear.
 */
const serviceCallLog: string[] = [];

/** D51: the UI's own credential for the admin HTTP surface. A spec sets this to the secret
 *  it wants `ui_session_key` to return; absent means the credential has not been configured. */
let uiSessionKey: string | undefined = undefined;

/**
 * The capture queue is host-owned exactly like gateway status: the UI reads it and cannot derive
 * it. Settable here so a spec can arrange the one branch it could never otherwise produce — rows
 * waiting while the hourly distillation budget is spent (§10(2)) — and so `budget_left` can be
 * dropped to stand in for an older host that never reported it.
 */
const queueStatus = {
  queued: 0,
  processing: 0,
  done: 0,
  failed: 0,
  outstanding: 0,
  budget_left: 60 as number | undefined,
};

// ---- host state with no UI input, modelled so the screens that read it can actually load ----
//
// Every one of these backs a command the app calls. A command the shim does not know about throws,
// and screens that load several at once (`Promise.all(...).catch(() => undefined)`) turn that single
// throw into a section that renders as though it had loaded with no data — no test fails, and the
// screen quietly lies. Keep this list in step with the audit in REFERENCE.md.

/** R4: per-app gateway keys. Mirrors persist.rs — revoke marks, delete removes, revoking twice
 * reports rather than silently succeeding, and a budget is set per key (0017). Rows carry
 * `capMicros` (null = uncapped) and `monthMicros`, matching `AppKeyView` in gateway_cmds.rs. */
const appKeys: Row[] = [];
/** R4 spend cap in micro-USD. `capped` is "at or over the cap", not "a cap is set" — that is what
 * gateway_cmds.rs computes, and the UI colours the number off it. */
const spendStatus = { monthMicros: 0, capMicros: 0, capped: false };
/**
 * The memory layer's master switch. Stateful since 26o, and that is a correction rather than a
 * feature: `gateway_memory_enabled` used to `return false` unconditionally and
 * `gateway_set_memory_enabled` used to return its own argument without storing it, so the pair
 * could not model a toggle at all — a POST followed by a GET disagreed with itself, and no spec
 * could have caught a route that failed to write. The default is `false`, which is what the
 * unconditional stub returned, so specs that only read it are unaffected.
 */
let memoryEnabled = false;
/**
 * What `gateway_log_tail` answers. The host owns `{app_data_dir}/gateway.log`, so a spec cannot
 * produce the branches that matter — an empty log, a line with no timestamp, a capped line —
 * without arranging them here.
 */
let logLines: { tsMs: number | null; text: string }[] = [];
/**
 * Commands that should fail on their next call, mapped to the message to reject with.
 *
 * Without this, a UI `catch` branch is unreachable from a spec: every shim case either answers or
 * throws only because the command is unknown, so "the read failed" and "the read answered with
 * nothing" render identically — which is exactly the distinction several cards exist to make (the
 * audit-trail card says so in as many words). One-shot, and cleared on use, so a spec arranges the
 * precise call it means to fail and a retry is a different call from the one arranged.
 */
const failNext = new Map<string, string>();
/**
 * How long a `failNext` waits before rejecting, in ms. Absent means immediate.
 *
 * An immediate failure is consumed and rejected within a microtask, so it always lands *before* a
 * later read resolves — which makes it useless for testing supersession: the newer read's success
 * clears the older one's error whichever way the guard is written, and the guard is never exercised.
 * A deferred failure is what puts the older rejection *last*, where only the guard can suppress it.
 */
const failDelay = new Map<string, number>();
/** Mirrors the Rust defaults (GatewayCore::new): tools on, gateway-side mutation off (audit H1b). */
const toolsState = { enabled: true, mutationEnabled: false };
/**
 * What `gateway_tool_run` answers. Fails by default: the harness has no tool sandbox, and a run
 * that reported success would let a spec conclude a file had been written when nothing was.
 */
const toolRunResult = { ok: false, output: "", error: "web-test shim: no tool sandbox" };
/** §3.4 context windows published by the webview. `router_model_context_replace` upserts by
 * `model_key` — a refresh covers one provider and must not drop another's rows. */
const modelContexts: Row[] = [];
/** §6.4 per-principal memory policy. `enabled: null` is "inherit", which *removes* the row. */
const principalPolicies: Row[] = [];
/**
 * Commands the app called that this shim does not implement. Always empty in a correct tree — see
 * the `default:` case for why a rejection alone is not enough to notice one.
 */
const unknownCommands: string[] = [];
/** The client the router publishes models into (workbuddy.rs). */
const workbuddy = {
  published: [] as string[],
  path: "",
  endpoint: "http://127.0.0.1:8787/v1",
  clientPresent: false,
};

const NODE_KINDS = ["artifact", "memory", "skill", "message"];
const EDGE_KINDS = [
  "produced", "used", "recalled", "follows", "references",
  "routes_to", "served_by", "aliases", "backed_by",
];
const RUN_STATUSES = ["running", "ok", "error", "stopped"];
/** memory.rs accepts exactly these four layers. */
const MEMORY_LAYERS = ["L0", "L1", "L2", "L3"];

/**
 * Every memory starts capture-only. Mirrors the Rust host, where `scope_global = 0` and the
 * project/agent columns are NULL until something explicitly binds it.
 */
const DEFAULT_SCOPE = { user: "", project: null, agent: null, global: false };
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
  drift: DriftRow[];
  audits: Row[];
  sessions: Row[];
  secrets: [string, string][];
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
    secrets: [...secrets.entries()],
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
  secrets.clear();
  for (const [ref, secret] of s.secrets) secrets.set(ref, secret);
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
    if (k.secret) secrets.set(k.secretRef, k.secret);
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
  /**
   * Set what `capture_queue_status` reports — same reason as `gatewayStatus`: the drain and its
   * budget live in the host, so the capped branch can only be arranged here.
   */
  queueStatus: (next: Partial<typeof queueStatus>): void => {
    Object.assign(queueStatus, next);
  },
  /** Month-to-date spend, so a spec can put the cap in force without faking a month of traffic. */
  spendStatus: (next: Partial<typeof spendStatus>): void => {
    Object.assign(spendStatus, next);
  },
  /**
   * Replace the per-app key list.
   *
   * Assigns rather than merges: the screen renders one row per key, and the states worth testing —
   * capped and at its limit, capped and under it, uncapped — all require a specific combination of
   * `capMicros` and `monthMicros` that no amount of clicking can produce, because a real month of
   * traffic is what sets the second one.
   */
  appKeys: (next: Row[]): void => {
    appKeys.length = 0;
    appKeys.push(...next);
  },
  /**
   * Replace what `gateway_log_tail` answers. Assigns rather than merges: the log is a sequence, and
   * merging lines would make "the tail of a three-line log" impossible to arrange.
   */
  logLines: (next: { tsMs: number | null; text: string }[]): void => {
    logLines = next;
  },
  /**
   * Make `cmd` reject on its next call — see `failNext`. The only way a spec can reach a UI `catch`
   * branch, and therefore the only way to tell "the read failed" from "the read answered empty".
   *
   * `afterMs` defers the rejection, so it can be made to land after a later call has resolved. Use it
   * to test that a superseded read cannot write; an immediate failure always loses that race.
   */
  failNext: (cmd: string, message: string, afterMs = 0): void => {
    failNext.set(cmd, message);
    if (afterMs > 0) failDelay.set(cmd, afterMs);
  },
  /** What a gateway tool run answers — see `toolRunResult` above. */
  toolRunResult: (next: Partial<typeof toolRunResult>): void => {
    Object.assign(toolRunResult, next);
  },
  /** Whether the client's config file is there (the Models screen greys itself out if not). */
  workbuddy: (next: Partial<typeof workbuddy>): void => {
    Object.assign(workbuddy, next);
  },
  /**
   * Commands the app called that the shim has no case for. A screen that swallows a rejected
   * `Promise.all` looks identical whether it loaded or not, so this is the only way a missing
   * case can fail a test rather than quietly emptying a screen.
   */
  unknownCommands: (): string[] => [...unknownCommands],
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
  /**
   * Set what `service_status` reports. The harness has no launchd, so the only way to reach the
   * "installed and running" branch is to arrange it here.
   */
  serviceStatus: (next: Partial<typeof serviceStatus>): void => {
    Object.assign(serviceStatus, next);
  },
  /** The service-card commands the screen has issued, oldest first. See `serviceCallLog`. */
  serviceCalls: (): string[] => [...serviceCallLog],
  /** Clear the log, so a spec asserts the calls *its own* click made, not the mount's. */
  resetServiceCalls: (): void => {
    serviceCallLog.length = 0;
  },
  /**
   * Set the credential `ui_session_key` returns, and that `/admin/*` accepts.
   *
   * The shim mints one on first ask, so an ordinary spec sees a healthy host. Clearing it here is
   * how a spec reaches the refusal — the branch D51 exists because a caller with no credential
   * must not be answered, and a harness that always hands one over cannot see it.
   */
  uiSessionKey: (next: string | undefined): void => {
    uiSessionKey = next;
  },
  /**
   * Model "the gateway is not listening" — the state a fresh install boots into, because the
   * listener is only auto-restored once it has been enabled at least once.
   *
   * Every `/admin/*` fetch then falls through to the network stack and fails, which is what the app
   * must survive. Toggling it after boot cannot test the boot path: set the init-time global with
   * `addInitScript` for that. See `gateway-off.spec.ts`.
   */
  adminSurfaceAbsent: (absent: boolean): void => {
    adminSurfaceAbsent = absent;
  },
  /**
   * The `/admin/*` calls the page has made, oldest first — the HTTP counterpart of
   * `store.requests()`, so a spec can assert what the UI actually sent after the migration moved
   * the transport. Bounded, for the same reason the egress log is.
   */
  adminCalls: (method?: string, path?: string): { method: string; path: string; body: unknown }[] =>
    adminCalls.filter((c) => (method ? c.method === method : true) && (path ? c.path.startsWith(path) : true)),
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
  // A one-shot failure a spec arranged. Checked here rather than inside `dispatch` so it also covers
  // a command the shim has no case for, and so `persist()` is skipped — a rejected call must not
  // commit anything, the same as the Rust host.
  const failure = failNext.get(cmd);
  if (failure !== undefined) {
    failNext.delete(cmd);
    const afterMs = failDelay.get(cmd) ?? 0;
    failDelay.delete(cmd);
    // Deferred on purpose when asked: see `failDelay`. Awaited *before* the throw so the caller's
    // rejection lands after any read that resolved in the meantime.
    if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
    throw new Error(failure);
  }
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
      if (k) secrets.delete(k.secretRef);
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
      drift.push({
        id: drift.length + 1,
        providerId: args.provider_id as string,
        detectedAt: Date.now(),
        triggerJson: args.trigger_json as string,
        resolved: null,
        resolvedAt: null,
      });
      return null;
    case "drift_event_resolve": {
      // The host's statement is `WHERE provider_id=?1 AND resolution IS NULL`, so it resolves *every*
      // open event for that provider, not just the newest. Mirrored deliberately: a fixture that
      // resolved one row would let a spec pass against behaviour the host does not have.
      const d = drift.find((d) => d.providerId === args.provider_id && !d.resolved);
      if (d) {
        d.resolved = args.resolution as string;
        d.resolvedAt = Date.now();
      }
      return null;
    }
    /**
     * The recorded drift history, newest first. Mirrors the host's two bounds rather than just slicing:
     * default 50 and ceiling 500 are `drift_events_list`'s, the floor of one is `list_drift_events`'s.
     * Reversing insertion order is the same order the host's `detected_at DESC, id DESC` produces,
     * because `id` increases with insertion.
     */
    case "drift_events_list": {
      const asked = args.limit === undefined || args.limit === null ? 50 : Number(args.limit);
      const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 50, 1), 500);
      return [...drift]
        .sort((a, b) => b.detectedAt - a.detectedAt || b.id - a.id)
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          providerId: d.providerId,
          detectedAt: d.detectedAt,
          triggerJson: d.triggerJson,
          resolution: d.resolved,
          resolvedAt: d.resolvedAt,
        }));
    }
    case "generator_audit_record":
      // `tsMs` last, so it cannot be overridden by the payload — the host stamps `now_ms()` itself and
      // the write shape deliberately has no timestamp field. Without it the reader has no time to
      // render and the card would show placeholders for rows that really do have one.
      audits.push({ id: ++auditSeq, ...(args.e as Row), tsMs: Date.now() });
      return null;
    /**
     * The AI generation trail, newest first. Mirrors the host's two bounds rather than just slicing:
     * default 50 and ceiling 500 are `generator_audit_list`'s, the floor of one is
     * `list_generator_audit`'s. Reversing insertion order is the same order the host's
     * `ts DESC, id DESC` produces, because `id` increases with insertion.
     */
    case "generator_audit_list": {
      const asked = args.limit === undefined || args.limit === null ? 50 : Number(args.limit);
      const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 50, 1), 500);
      return [...audits].reverse().slice(0, limit);
    }
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

    // ---- secrets (the secret goes IN once and never comes OUT) ----
    case "vault_put":
      secrets.set(args.account as string, args.secret as string);
      return null;
    case "vault_delete":
      secrets.delete(args.account as string);
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

    // D51: the UI's own credential for the admin HTTP surface.
    case "ui_session_key":
      // Mint on first ask, the way `ui_session::ensure` does in the host. Before this the case
      // returned `undefined` unless a spec had set one, so the UI cached no credential and every
      // `/admin/*` call would have been a 401 — a second, quieter way for the migrated screens to
      // render empty. The harness models a healthy host; `__webTest.uiSessionKey` arranges the
      // refusal when a spec wants it.
      return mintUiSession();

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
        // Older rows predating the §6.4 migration arrived without `scope` or `superseded_at`; fill
        // them in on touch so the Memory screen's `ScopeSelect` doesn't read `.global` of undefined.
        if (!seen.scope) seen.scope = { ...DEFAULT_SCOPE };
        if (seen.superseded_at === undefined) seen.superseded_at = null;
        return { ...seen };
      }
      const row: Row = {
        id: `m-${layer}-${memories.length + 1}-${now}`, layer, text,
        session_id: args.session_id ?? null, subject: args.subject ?? null,
        created_at: now, updated_at: now, pinned: args.pinned ? 1 : 0,
        scope: { ...DEFAULT_SCOPE },
        superseded_at: null,
      };
      memories.push(row);
      return { ...row };
    }
    case "memory_capture_batch": {
      // `toRustArgs` renames only top-level keys, so the caller's spelling survives inside `items`
      // — and serde matches it against the Rust field names. `MemoryInput` has **no** `rename_all`
      // and declares `deny_unknown_fields`, so an item must carry `session_id`; a camelCase key is a
      // hard error in the real host rather than a silent null.
      //
      // The key check below exists because this shim is hand-written JS and would otherwise be more
      // forgiving than the host it stands in for. That leniency is precisely how the original bug
      // survived: the shim read the camel spelling and agreed silently with the very defect it
      // existed to catch. Mirroring `deny_unknown_fields` here is what lets the harness see it.
      const items = (args.items as Row[] | undefined) ?? [];
      const KNOWN_ITEM_KEYS = ["layer", "text", "session_id", "subject", "pinned"];
      for (const it of items) {
        const unknown = Object.keys(it).filter((k) => !KNOWN_ITEM_KEYS.includes(k));
        if (unknown.length > 0) {
          throw new Error(
            `memory_capture_batch: unknown item key(s) ${unknown.join(", ")} — MemoryInput is ` +
              `snake_case with deny_unknown_fields, so the real host would reject this payload`,
          );
        }
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
            scope: { ...DEFAULT_SCOPE },
            superseded_at: null,
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
    case "memory_assign_scope": {
      const row = memories.find((m) => m.id === args.id);
      if (!row) return false;
      const s = (args.scope ?? {}) as { kind?: string; project?: string | null; agent?: string | null };
      if (s.kind === "global") {
        row.scope = { user: row.scope?.user ?? "", project: null, agent: null, global: true };
      } else if (s.kind === "project") {
        row.scope = { user: row.scope?.user ?? "", project: s.project ?? null, agent: s.agent ?? null, global: false };
      } else {
        row.scope = { user: row.scope?.user ?? "", project: null, agent: null, global: false };
      }
      row.updated_at = Date.now();
      return true;
    }
    case "memory_supersede":
      // Shim never produces conflicts itself; mark the older row superseded so the UI can demo
      // the §6.4 conflict path. The Rust host refuses to supersede pinned/L3 rows; mirror that.
      {
        const old = memories.find((m) => m.id === args.old);
        if (!old) return false;
        if (old.pinned) throw new Error("this memory is pinned — unpin it first");
        if (old.layer === "L3") throw new Error("this is a core fact (L3) — replaced deliberately, never by a newer atom");
        old.superseded_at = Date.now();
        return true;
      }
    case "memory_unsupersede": {
      const row = memories.find((m) => m.id === args.id);
      if (!row) return false;
      row.superseded_at = null;
      return true;
    }
    case "memory_conflicts":
      // No contradictions in the shim.
      return [];
    // §6.4 — an upsert; `enabled: null` returns the principal to inheriting, which is a delete.
    case "memory_principal_list":
      return principalPolicies.map((r) => ({ ...r }));
    case "memory_principal_set": {
      const policy = args.policy as { principal?: string; enabled?: boolean | null } | undefined;
      const principal = String(policy?.principal ?? "");
      if (!principal) throw new Error("memory_principal_set needs a principal");
      const enabled = policy?.enabled ?? null;
      const i = principalPolicies.findIndex((r) => r.principal === principal);
      if (enabled === null) {
        if (i >= 0) principalPolicies.splice(i, 1);
      } else {
        const row = { principal, enabled, last_seen_at: null };
        if (i >= 0) principalPolicies[i] = row;
        else principalPolicies.push(row);
      }
      return true;
    }
    // Mirrors Rust exactly: the command is `router_model_context_count` (commands.rs). It was
    // listed here unprefixed, and because the Memory screen loads this inside a `Promise.all` that
    // swallows rejections, the throw silently nulled the whole section — the master switch, the
    // queue and the principal list all rendered as "no data" while looking like they had loaded.
    case "router_model_context_count":
      return modelContexts.length;
    case "router_model_context_replace": {
      const rows = (args.rows ?? []) as Row[];
      for (const r of rows) {
        const i = modelContexts.findIndex((m) => m.model_key === r.model_key);
        if (i >= 0) modelContexts[i] = { ...r };
        else modelContexts.push({ ...r });
      }
      return rows.length;
    }
    case "capture_queue_status":
      return { ...queueStatus };
    // The drain. Nothing is ever enqueued here — no gateway request path runs in the harness — so
    // the queue is honestly empty rather than pretending to have work it cannot distil.
    case "capture_claim":
      return [];
    case "capture_complete":
    case "capture_release":
      return false;
    case "capture_requeue_stale":
      return 0;
    case "capture_purge_finished":
      return 0;
    case "gateway_memory_enabled":
      return memoryEnabled;
    case "gateway_set_memory_enabled":
      memoryEnabled = Boolean(args.enabled);
      // Read back rather than echo the argument, matching `memory_enabled_set_h`: an echo would
      // agree with itself even if the store had not taken.
      return memoryEnabled;
    // Deliberately one populated row rather than an empty object: with `{}` a field-name mismatch
    // between the Rust DTO and the screen would pass the browser sweep unnoticed. The keys mirror
    // `injection_log::InjectionEvent` under `rename_all = "camelCase"`.
    case "gateway_injection_stats":
      return {
        total: 1,
        counts: { injected: 1 },
        recent: [
          {
            tsMs: 1758468000000,
            id: "gw-1",
            model: "agnes-3.0-flash",
            scope: "user=local;project=-;agent=-",
            injected: true,
            items: 3,
            context: 1,
            tokens: 96,
            reason: "injected",
          },
        ],
      };
    case "gateway_prune_memories":
      return { l0_expired: 0, l0_ring: 0, decayed: 0 };
    case "gateway_prune_live_context":
      return { turns_by_count: 0, turns_by_age: 0, sessions_reaped: 0 };

    // ---- the login-item service (Phase 6) ----
    //
    // The harness has no launchd, no uid and no `aiproviderd` to install, so these answer the
    // honest shape of "nothing is installed" rather than a plausible-looking one. `service_status`
    // in particular must not report `loaded: true`: a screen that believed it would show a
    // running service with no process behind it, and nothing here could contradict that.
    case "service_status":
      return { ...serviceStatus };
    case "service_install":
      serviceCallLog.push("service_install");
      throw new Error("service_install: the browser harness has no launchd to install into");
    case "service_uninstall":
      serviceCallLog.push("service_uninstall");
      throw new Error("service_uninstall: the browser harness has no launchd to remove from");
    /*
     * Recorded, then refused — refused for the same reason the two above are: the harness has no
     * launchd, and a shim that *pretended* to start a job would let a spec assert a lifecycle no
     * real machine performs, which is the class this file's own `service_status` note warns about.
     * What is testable here is the screen's wiring, and the log is where it is observable: that
     * Start calls `service_start`, that Stop calls `service_stop`, and that Start releases the port
     * first.
     */
    case "service_start":
      serviceCallLog.push("service_start");
      throw new Error("service_start: the browser harness has no launchd to start a job in");
    case "service_stop":
      serviceCallLog.push("service_stop");
      throw new Error("service_stop: the browser harness has no launchd to stop a job in");

    // ---- gateway listener and its keys (R4) ----
    case "gateway_enable": {
      const port = Number(args.port) || 8787;
      Object.assign(gatewayStatus, { running: true, port });
      // Logged for the same reason `gateway_disable` is: Start calls this as the handover's
      // *undo* when the service fails to take the port, and that recovery is worth asserting.
      serviceCallLog.push("gateway_enable");
      return port; // the command answers with the port it bound
    }
    case "gateway_disable":
      // Logged because Start calls this as the handover's first half — see `serviceCallLog`.
      serviceCallLog.push("gateway_disable");
      gatewayStatus.running = false;
      return null;
    case "gateway_key_generate":
      gatewayStatus.hasKey = true;
      return null;
    case "gateway_key_copy":
      return null; // clipboard side effect; the screen only reports success
    case "gateway_key_revoke":
      gatewayStatus.hasKey = false;
      return null;
    case "gateway_app_keys":
      return appKeys.map((k) => ({ ...k }));
    case "gateway_app_key_create": {
      const label = String(args.label ?? "untitled");
      // Only {id, label} come back: the secret is generated and copied host-side and never
      // enters the webview (R4). `capMicros`/`monthMicros` mirror `AppKeyView` in gateway_cmds.rs
      // — a key is born uncapped and has spent nothing.
      const row = {
        id: `ak-${appKeys.length + 1}`,
        label,
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
        capMicros: null,
        monthMicros: 0,
      };
      appKeys.push(row);
      return { id: row.id, label };
    }
    case "gateway_app_key_revoke": {
      const row = appKeys.find((k) => k.id === args.id);
      // Mirrors persist.rs: revoking a key that is missing or already revoked reports, rather
      // than silently succeeding.
      if (!row || row.revokedAt) throw new Error("gateway key not found or already revoked");
      row.revokedAt = Date.now();
      return null;
    }
    case "gateway_app_key_delete": {
      // A hard delete, unlike revoke: no error when the row is already gone.
      const i = appKeys.findIndex((k) => k.id === args.id);
      if (i >= 0) appKeys.splice(i, 1);
      return null;
    }
    case "gateway_app_key_cap_set": {
      const row = appKeys.find((k) => k.id === args.id);
      // Mirrors persist.rs: a cap on a key that does not exist reports rather than silently
      // succeeding — an acknowledged no-op reads to the operator as a budget in force.
      if (!row) throw new Error(`gateway key not found: ${String(args.id)}`);
      // `<= 0` clears, and is stored as `null` rather than `0`. One spelling of "no budget":
      // persist.rs normalizes at write time for the same reason.
      // `cap_micros`, not `capMicros`: `toRustArgs` renames top-level keys before `dispatch`, so a
      // camelCase read here is always `undefined` and the cap silently becomes 0.
      const micros = Number(args.cap_micros) || 0;
      row.capMicros = micros > 0 ? micros : null;
      return null;
    }
    case "gateway_spend_status":
      return { ...spendStatus };
    case "gateway_spend_cap_set": {
      // Negative is clamped to 0, and 0 means "no cap" — which is also why `capped` is false then.
      //
      // `cap_micros`, not `capMicros`. This case read the camel spelling until 2026-09-23, which
      // `toRustArgs` had already renamed — so `Number(undefined) || 0` was always `0` and setting a
      // global cap through the UI silently cleared it. Nothing caught it because the only spec that
      // exercises the cap seeds it through `__webTest.spendStatus` and never calls this command;
      // the same defect was found in the new per-app case below and traced back here.
      spendStatus.capMicros = Math.max(0, Number(args.cap_micros) || 0);
      spendStatus.capped = spendStatus.capMicros > 0 && spendStatus.monthMicros >= spendStatus.capMicros;
      return null;
    }

    // ---- gateway tools (audit H1b) ----
    case "get_tools_enabled":
      return toolsState.enabled;
    case "set_tools_enabled":
      toolsState.enabled = Boolean(args.enabled);
      return null;
    case "get_tools_mutation_enabled":
      return toolsState.mutationEnabled;
    case "set_tools_mutation_enabled":
      toolsState.mutationEnabled = Boolean(args.enabled);
      return null;
    case "gateway_tool_run":
      return { ...toolRunResult };
    /**
     * The tail of the tool audit log. Mirrors the host's two bounds rather than just slicing: a spec
     * that passes `limit: 0` and gets the host's floor-of-one here but nothing in the app would be
     * asserting the shim. Default 200 and ceiling 1000 are `gateway_log_tail`'s; the floor of one is
     * `parse_log_tail`'s.
     */
    case "gateway_log_tail": {
      const asked = args.limit === undefined || args.limit === null ? 200 : Number(args.limit);
      const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 200, 1), 1000);
      return logLines.slice(-limit);
    }
    // ---- workbuddy: the client the router publishes models into ----
    case "workbuddy_status":
      return {
        published: [...workbuddy.published],
        path: workbuddy.path,
        endpoint: workbuddy.endpoint,
        clientPresent: workbuddy.clientPresent,
      };
    case "workbuddy_set_models": {
      const models = (args.models ?? []) as string[];
      workbuddy.published = [...models];
      return {
        path: workbuddy.path,
        endpoint: workbuddy.endpoint,
        models: [...models],
        updated: models.length,
        removed: 0,
        note: null,
      };
    }
    case "crash_count":
      return 0;
    case "crash_list":
      return [];
    case "crash_read":
      return null;
    case "crash_clear":
      return Boolean(args?.id);
    case "crash_clear_all":
      return 0;
    case "gateway_project_key":
      // The shim has no workspace root; the Memory screen treats `null` as "no project scoping
      // today" and renders atoms un-scoped. Without this case the screen's main `Promise.all`
      // rejects, the `.catch` swallows it, and every row stays hidden — silently breaking the
      // memory browser tests. Mirrors `gateway_cmds::gateway_project_key` returning `None`.
      return null;
    case "memory_stats": {
      const s = {
        l0: 0, l1: 0, l2: 0, l3: 0, total: memories.length, bytes: 0,
        // The Rust host counts rows where `superseded_at IS NULL`; the shim never supersedes
        // anything, so every row is injectable.
        injectable: memories.length,
      };
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
      //
      // They are also *recorded*, because rejecting is not enough. Screens load several commands
      // in one `Promise.all(...).catch(() => undefined)`: the rejection is swallowed, every value
      // in the batch stays null, and the section renders as though it had loaded with nothing to
      // report. `router_model_context_count` was missing for the whole memory feature and no test
      // failed. `unknownCommands` turns that silence into an assertion.
      unknownCommands.push(cmd);
      throw new Error(`web-test shim: unknown command "${cmd}"`);
  }
}

// ---------------------------------------------------------------------------
// Admin HTTP surface — a second entry point over the SAME store.
//
// §10 decision 2 is pure HTTP: the UI reaches the gateway with `fetch()`, and
// `gateway-client.ts` supplies a `Bearer` credential the host minted
// (`core/ui_session.rs`). Until this section existed, every one of those calls
// left the page for a port nothing listens on, so the screens that migrated in
// 26i rendered as though the host had answered empty — the browser suite went
// red while `tsc` stayed clean, which is the same blindness 26j found in vitest
// and closed with `gateway-client.fake.ts`. A typecheck cannot see a transport.
//
// This is deliberately NOT a second implementation of the business logic. Each
// route is a thin adapter: parse path/query/body, call the same `dispatch` case
// the `invoke` path uses, reshape the reply into what `core/gateway_admin.rs`
// answers. One store, two entry points — the shape the Rust half already has,
// where routes delegate to `persist::*` / `memory::*` / `context::*` cores.
//
// Two things it cannot model, stated rather than left implied:
//   - **CORS.** The interceptor answers before the network stack runs, so the
//     browser never performs the preflight or the origin check that
//     `cors_headers` exists to satisfy. A CORS regression cannot redden this
//     harness.
//   - **Extractor timing.** 26g moved a query parse after `authorize` because a
//     typed axum extractor runs before the handler body and would answer a
//     caller it had not authenticated. Here the credential is checked before
//     anything is parsed, which is the same rule enforced by hand.
// ---------------------------------------------------------------------------

/** Stands in for the `ak-ui` secret `core/ui_session.rs` mints into the secrets. */
const UI_SESSION_SECRET = "ak-ui-web-test-secret";

/** Mint on first ask, the way `ui_session::ensure` does — see the `ui_session_key` case. */
function mintUiSession(): string {
  if (uiSessionKey === undefined) uiSessionKey = UI_SESSION_SECRET;
  return uiSessionKey;
}

/** An admin route refusing, carrying the status `core/gateway_admin.rs` would answer. */
class AdminRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function refuse(status: number, message: string, code?: string): never {
  throw new AdminRefusal(status, message, code);
}

/** `{ error: { … } }`, the body `err()` builds, so a refusal reads like the host's. */
function refusalBody(e: AdminRefusal): unknown {
  return { error: { message: e.message, type: "invalid_request", code: e.code ?? null } };
}

/** The last N admin calls, so a spec can assert what the UI actually sent. */
const adminCalls: { method: string; path: string; body: unknown }[] = [];
const ADMIN_CALL_LIMIT = 50;
function recordAdminCall(method: string, path: string, body: unknown): void {
  adminCalls.push({ method, path, body });
  if (adminCalls.length > ADMIN_CALL_LIMIT) adminCalls.splice(0, adminCalls.length - ADMIN_CALL_LIMIT);
}

/** Is this URL one the host's admin surface owns? Loopback only — see invariant 3. */
/**
 * Whether the harness pretends nothing is listening on the gateway port.
 *
 * Seeded from `globalThis.__webTestAdminSurfaceAbsent`, which a spec sets with `addInitScript`
 * before the page boots — the boot path runs at mount, so a flag set afterwards is too late to
 * reach it. `__webTest.adminSurfaceAbsent` toggles the same state for a spec that wants it mid-run.
 *
 * Until this existed the harness answered every `/admin/*` call unconditionally, so the suite could
 * not see a boot path that depends on a live listener. It could not: a regression that made the app
 * unbootable on a fresh install passed all 106 tests.
 */
let adminSurfaceAbsent: boolean = (globalThis as any).__webTestAdminSurfaceAbsent === true;

function isAdminTarget(url: URL): boolean {
  // "The gateway is not listening." Returning false here is not the same as refusing: the request
  // falls through to the real network stack, where nothing is bound, and fails the way a first
  // launch fails — `TypeError: Failed to fetch`.
  if (adminSurfaceAbsent) return false;
  if (!isLocal(url.hostname)) return false;
  return url.pathname === "/admin" || url.pathname.startsWith("/admin/");
}

/**
 * One settings row as an object.
 *
 * Absent **and** unparseable both collapse to `{}`, for the reason `read_settings_object` gives:
 * they are different faults but the caller's recovery is identical, and a corrupt row must not
 * take a screen down.
 */
function settingsObject(key: string): Record<string, unknown> {
  const raw = settings.get(key);
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `persist::MemoryInput` is snake_case with `deny_unknown_fields`, so a
 * misspelled key is a hard error rather than a silent `None` — the rule that
 * let `session_id` go missing for months and disabled the per-session ring cap.
 * The `invoke` path checks this inside `memory_capture_batch`; the HTTP route
 * carries the same struct for a single capture, so it is checked here too.
 */
const MEMORY_INPUT_KEYS = ["layer", "text", "session_id", "subject", "pinned"];
function assertMemoryInput(it: unknown, where: string): void {
  if (!it || typeof it !== "object") refuse(400, `${where} expects a memory object`, "not_an_object");
  const unknown = Object.keys(it as Row).filter((k) => !MEMORY_INPUT_KEYS.includes(k));
  if (unknown.length > 0) {
    refuse(400, `${where}: unknown key(s) ${unknown.join(", ")} — MemoryInput is snake_case with deny_unknown_fields`, "unknown_field");
  }
}

/** `?limit=N`, defaulting the way each handler in `gateway_admin.rs` does. */
function limitOf(q: URLSearchParams, fallback: number): number {
  const raw = q.get("limit");
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The admin router. `segs` is the path split on `/` with empties dropped, so
 * `/admin/memory/L1/pin` arrives as `["admin","memory","L1","pin"]`.
 */
async function routeAdmin(method: string, segs: string[], q: URLSearchParams, body: unknown): Promise<unknown> {
  const at = (i: number): string => (i < segs.length ? decodeURIComponent(segs[i]) : "");

  switch (at(1)) {
    // ── gateway settings ───────────────────────────────────────────────────
    case "settings": {
      // The keyed form reaches every row in the table; the unkeyed one owns `gateway`. The keyed
      // checks come first because the unkeyed branches do not test `segs.length`, so a keyed path
      // would otherwise be answered as the `gateway` row — the ordering is load-bearing, as it is
      // in `routeMemory`.
      if (method === "GET" && segs.length === 3) return settingsObject(segs[2]);
      if (method === "POST" && segs.length === 3) {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          refuse(400, "POST /admin/settings/{key} expects a JSON object", "not_an_object");
        }
        const key = segs[2];
        const merged = { ...settingsObject(key), ...(body as Record<string, unknown>) };
        settings.set(key, JSON.stringify(merged));
        persistSettings();
        return merged;
      }
      if (method === "GET") return settingsObject("gateway");
      if (method === "POST") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          refuse(400, "POST /admin/settings expects a JSON object", "not_an_object");
        }
        const merged = { ...settingsObject("gateway"), ...(body as Record<string, unknown>) };
        settings.set("gateway", JSON.stringify(merged));
        persistSettings();
        return merged;
      }
      break;
    }

    // ── per-app gateway keys (R4) ──────────────────────────────────────────
    case "keys": {
      if (method === "GET" && segs.length === 2) return appKeys.map((k) => ({ ...k }));
      if (method === "POST" && segs.length === 2) {
        const label = String((body as Row | undefined)?.label ?? "").trim();
        if (!label) refuse(400, "POST /admin/keys requires a non-empty `label`", "missing_label");
        const id = `ak-${appKeys.length + 1}`;
        const row = {
          id, label, createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
          capMicros: null, monthMicros: 0,
        };
        appKeys.push(row);
        // The secret crosses the wire exactly once, as it does in `AppKeyCreated`. The
        // harness has no secrets, so it is generated here and not retained.
        return { id, label, secret: `sk-aip-${id}-${Math.random().toString(16).slice(2, 10)}` };
      }
      if (method === "DELETE" && segs.length === 3) {
        const row = appKeys.find((k) => k.id === at(2));
        if (!row || row.revokedAt) throw new Error("gateway key not found or already revoked");
        row.revokedAt = Date.now();
        return { ok: true };
      }
      break;
    }

    case "spend": {
      // The sub-path is checked first. The bare `GET` below used to answer any `/admin/spend/*`
      // path, so `/admin/spend/cap` would have been answered as the status rather than falling
      // through to a 404 — the same ordering hazard `routeMemory` documents.
      if (method === "POST" && segs.length === 3 && at(2) === "cap") {
        await dispatch("gateway_spend_cap_set", { cap_micros: (body as Row)?.capMicros });
        return { ok: true };
      }
      if (method === "GET" && segs.length === 2) return { ...spendStatus };
      break;
    }

    // ── config CRUD ────────────────────────────────────────────────────────
    case "providers": {
      if (method === "GET" && segs.length === 2) return dispatch("providers_list", {});
      if (method === "POST" && segs.length === 2) {
        await dispatch("provider_upsert", { p: body as Row });
        return { ok: true };
      }
      if (method === "DELETE" && segs.length === 3) {
        await dispatch("provider_delete", { id: at(2) });
        return { ok: true };
      }
      break;
    }
    case "api-keys": {
      if (method === "GET" && segs.length === 2) return dispatch("api_keys_list", {});
      if (method === "POST" && segs.length === 2) {
        await dispatch("api_key_upsert", { k: body as Row });
        return { ok: true };
      }
      if (method === "DELETE" && segs.length === 3) {
        await dispatch("api_key_delete", { id: at(2) });
        return { ok: true };
      }
      break;
    }
    case "manifests": {
      if (method === "GET" && segs.length === 2) return dispatch("manifests_active", {});
      if (method === "POST" && segs.length === 2) {
        await dispatch("manifest_upsert_active", { m: body as Row });
        return { ok: true };
      }
      if (method === "POST" && segs.length === 3 && at(2) === "stage") {
        // `manifest_stage_h` takes `Json<ManifestRow>`, so the body *is* the row. The IPC
        // command's `{ m }` wrapper is `toRustArgs`'s doing, not the struct's shape — the pair
        // disagrees here the same way `POST /admin/aliases` does.
        const version = await dispatch("manifest_stage", { m: body as Row });
        return { version };
      }
      if (method === "GET" && segs.length === 4 && at(3) === "history") {
        return dispatch("manifests_history", { provider_id: at(2) });
      }
      if (method === "POST" && segs.length === 4 && at(3) === "activate") {
        const previous = await dispatch("manifest_activate", { provider_id: at(2), version: (body as Row)?.version });
        return { previousVersion: previous ?? null };
      }
      break;
    }
    case "models-cache": {
      if (method === "GET" && segs.length === 2) return dispatch("models_cache_list", {});
      if (method === "POST" && segs.length === 2) {
        const b = (body ?? {}) as Row;
        await dispatch("models_cache_replace", { provider_id: b.providerId, rows: (b.rows ?? []) as Row[] });
        return { ok: true };
      }
      break;
    }
    case "aliases": {
      if (method === "GET" && segs.length === 2) return dispatch("aliases_list", {});
      if (method === "POST" && segs.length === 2) {
        // `aliases_replace_h` takes `Json<Vec<AliasRow>>` — a bare array, which is what
        // `admin_aliases_replace_*` posts and what `aliases_replace_rows` consumes.
        // `persistAliases` in store.ts sends `{ rows }`, the IPC command's shape; the pair
        // disagrees and this is the first thing that walks it.
        if (!Array.isArray(body)) {
          refuse(422, "POST /admin/aliases expects a JSON array of alias rows", "not_an_array");
        }
        await dispatch("aliases_replace", { rows: body as Row[] });
        return { ok: true };
      }
      break;
    }
    case "ledger": {
      if (method === "GET" && segs.length === 2) return dispatch("ledger_recent", { limit: limitOf(q, 200) });
      if (method === "POST" && segs.length === 2) {
        // `ledger_append_h` takes `Json<LedgerRow>` — the body is the row, and the IPC command's
        // `{ e }` wrapper is `toRustArgs`'s. Same disagreement as `manifest_stage`.
        await dispatch("ledger_append", { e: body as Row });
        return { ok: true };
      }
      break;
    }

    // ── memory (P7) ────────────────────────────────────────────────────────
    case "memory":
      return routeMemory(method, segs, q, body);

    // ── context graph (P4) ─────────────────────────────────────────────────
    case "context": {
      if (method === "GET" && segs.length === 2) return dispatch("context_graph", { limit: limitOf(q, 200) });
      if (method === "POST" && segs.length === 2) {
        const b = (body ?? {}) as Row;
        await dispatch("context_record", { nodes: (b.nodes ?? []) as Row[], edges: (b.edges ?? []) as Row[] });
        return { ok: true };
      }
      if (method === "DELETE" && segs.length === 2) {
        await dispatch("context_clear", {});
        return { ok: true };
      }
      // Live-context retention. Delegates to `gateway_prune_live_context`, which is the *other*
      // pruning command: `POST /admin/memory/prune` bounds `memories` and this bounds
      // `live_context`. They are separate because the policies are unrelated and one stats struct
      // over both would hide which rule removed what.
      if (method === "POST" && segs.length === 3 && at(2) === "prune") {
        return dispatch("gateway_prune_live_context", {});
      }
      break;
    }

    // ── gateway tool toggles ───────────────────────────────────────────────
    case "tools":
      return routeTools(method, segs, body);
  }

  refuse(404, `no admin route for ${method} /${segs.join("/")}`, "unknown_route");
}

async function routeMemory(method: string, segs: string[], q: URLSearchParams, body: unknown): Promise<unknown> {
  const at = (i: number): string => (i < segs.length ? decodeURIComponent(segs[i]) : "");

  // Static segments first, exactly as `gateway.rs` declares them before `/admin/memory/{id}`:
  // the ordering is load-bearing, not cosmetic — "stats" must not be captured as an id.
  switch (at(2)) {
    case "":
      if (method === "GET") {
        return dispatch("memory_list", { layer: q.get("layer"), limit: limitOf(q, 200) });
      }
      if (method === "POST") {
        assertMemoryInput(body, "POST /admin/memory");
        return dispatch("memory_capture", body as Record<string, unknown>);
      }
      if (method === "DELETE") {
        await dispatch("memory_clear", {});
        return { ok: true };
      }
      break;
    // The master switch, which is not a memory row. A static segment, so it precedes the id
    // handling for the reason the note at the top of this switch gives.
    case "enabled": {
      if (method === "GET") return { enabled: memoryEnabled };
      if (method === "POST") {
        memoryEnabled = Boolean((body as Row)?.enabled);
        return { enabled: memoryEnabled };
      }
      break;
    }
    case "batch": {
      if (method === "POST") {
        const items = Array.isArray(body) ? (body as unknown[]) : [];
        for (const it of items) assertMemoryInput(it, "POST /admin/memory/batch");
        const n = await dispatch("memory_capture_batch", { items: items as Row[] });
        return { captured: n };
      }
      break;
    }
    case "recall": {
      if (method === "POST") {
        const b = (body ?? {}) as Row;
        return dispatch("memory_recall", {
          query: b.query ?? "", limit: b.limit ?? 8, layers: b.layers ?? null,
        });
      }
      break;
    }
    case "stats": {
      if (method === "GET") return dispatch("memory_stats", {});
      break;
    }
    case "conflicts": {
      if (method === "GET") return dispatch("memory_conflicts", {});
      break;
    }
    case "prune": {
      // The UI reaches pruning over IPC (`gateway_prune_memories`), so this route has no
      // caller yet. It delegates to the same shim case rather than inventing a summary.
      if (method === "POST") return dispatch("gateway_prune_memories", {});
      break;
    }
    case "supersede": {
      if (method === "POST") {
        const b = (body ?? {}) as Row;
        return { ok: await dispatch("memory_supersede", { old: b.old, new: b.new }) };
      }
      break;
    }
    case "principals": {
      if (method === "GET") return dispatch("memory_principal_list", {});
      if (method === "POST") {
        const b = (body ?? {}) as Row;
        return { ok: await dispatch("memory_principal_set", { policy: { principal: b.principal, enabled: b.enabled ?? null } }) };
      }
      break;
    }
    case "session": {
      if (method === "GET" && segs.length === 4) {
        const layer = q.get("layer");
        if (layer === null) refuse(400, "GET /admin/memory/session/{session_id} needs a `layer`", "missing_layer");
        return dispatch("memory_session_atoms", { session_id: at(3), layer, limit: limitOf(q, 200) });
      }
      break;
    }
    default: {
      // `/admin/memory/{id}` and its three sub-routes.
      const id = at(2);
      if (segs.length === 3) {
        if (method === "DELETE") return { ok: await dispatch("memory_forget", { id }) };
        if (method === "PUT") return { ok: await dispatch("memory_update", { id, text: (body as Row)?.text }) };
      }
      if (segs.length === 4) {
        if (at(3) === "pin" && method === "POST") {
          return { ok: await dispatch("memory_set_pinned", { id, pinned: Boolean((body as Row)?.pinned) }) };
        }
        if (at(3) === "scope" && method === "POST") {
          const b = (body ?? {}) as Row;
          const kind = String(b.kind ?? "").trim().toLowerCase();
          if (!["project", "global", "unscoped"].includes(kind)) {
            refuse(400, `unknown scope kind '${b.kind}'`, "unknown_scope_kind");
          }
          return { ok: await dispatch("memory_assign_scope", { id, scope: { kind, project: b.project ?? null, agent: b.agent ?? null } }) };
        }
        if (at(3) === "unsupersede" && method === "POST") {
          return { ok: await dispatch("memory_unsupersede", { id }) };
        }
      }
      break;
    }
  }

  refuse(404, `no admin route for ${method} /${segs.join("/")}`, "unknown_route");
}

/**
 * The tool toggles. `GET` reports **both** authorities, because 26h measured that
 * "are gateway tools on" has two: the in-memory flag the running gateway reads and
 * `gatewayToolsEnabled` in the `router` row a headless service boots from. A route
 * that picked one would be a toggle that lies in the other process.
 */
async function routeTools(method: string, segs: string[], body: unknown): Promise<unknown> {
  const persisted = settingsObject("router");
  const status = () => ({
    enabled: toolsState.enabled,
    mutationEnabled: toolsState.mutationEnabled,
    // `RouterSettings::default()` is `true`, and a row that lacks the key keeps it — so an
    // absent row is `true`, not `null` (router.rs:321).
    persistedEnabled: typeof persisted.gatewayToolsEnabled === "boolean" ? persisted.gatewayToolsEnabled : true,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
  });

  if (segs.length === 2) {
    if (method === "GET") return status();
    if (method === "POST") {
      const patch = (body ?? {}) as Row;
      if (typeof patch.enabled === "boolean") {
        toolsState.enabled = patch.enabled;
        const row = { ...settingsObject("router"), gatewayToolsEnabled: patch.enabled };
        settings.set("router", JSON.stringify(row));
        persistSettings();
      }
      if (typeof patch.mutationEnabled === "boolean") {
        toolsState.mutationEnabled = patch.mutationEnabled;
      }
      return status();
    }
  }
  if (segs.length === 3 && at2(segs) === "workspace-root" && method === "PUT") {
    const root = String((body as Row)?.root ?? "");
    if (!root.startsWith("/") || root.split("/").includes("..")) {
      refuse(400, `that workspace root was refused: ${root || "(empty)"}`, "bad_workspace_root");
    }
    return { workspaceRoot: root };
  }
  refuse(404, `no admin route for ${method} /${segs.join("/")}`, "unknown_route");
}
function at2(segs: string[]): string {
  return segs.length > 2 ? decodeURIComponent(segs[2]) : "";
}

/** Parse the body `fetchAdmin` sends: JSON, or absent for GET/DELETE. */
function adminBody(init?: RequestInit): unknown {
  const raw = init?.body;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    refuse(400, "the admin request body is not JSON", "invalid_json");
  }
}

/** The `Authorization` header, however the caller capitalised it. */
function bearerOf(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  const read = (k: string): string | null => {
    if (h instanceof Headers) return h.get(k);
    if (Array.isArray(h)) return (h.find(([n]) => n.toLowerCase() === k)?.[1] as string) ?? null;
    const rec = h as Record<string, string>;
    for (const [n, v] of Object.entries(rec)) if (n.toLowerCase() === k) return v;
    return null;
  };
  const auth = read("authorization");
  if (!auth) return null;
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

/**
 * Serve one `/admin/*` request, or `null` when the URL is not the admin surface.
 *
 * The credential is checked **before** anything is parsed — the rule 26g moved a
 * query parse to satisfy, so nothing on this surface answers before it knows who
 * is asking.
 */
async function serveAdmin(method: string, url: URL, init?: RequestInit): Promise<Response> {
  const path = `${url.pathname}${url.search}`;
  const body = adminBody(init);
  recordAdminCall(method, path, body);

  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

  if (bearerOf(init) !== mintUiSession()) {
    return json(401, { error: { message: "unauthorized", type: "invalid_request", code: "invalid_api_key" } });
  }

  // A one-shot failure a spec arranged, keyed `METHOD path` — the HTTP counterpart of
  // `failNext` on a command name, so "this read failed" stays arrangeable now that the
  // read is a route rather than an `invoke`.
  const failKey = `${method} ${url.pathname}`;
  const failure = failNext.get(failKey);
  if (failure !== undefined) {
    failNext.delete(failKey);
    const afterMs = failDelay.get(failKey) ?? 0;
    failDelay.delete(failKey);
    if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
    return json(500, { error: { message: failure, type: "invalid_request", code: "shim_fail_next" } });
  }

  const segs = url.pathname.split("/").filter((s) => s.length > 0);
  try {
    const payload = await routeAdmin(method, segs, url.searchParams, body);
    persist(); // commit before the caller sees the reply, as the Rust host does
    return json(200, payload);
  } catch (e) {
    if (e instanceof AdminRefusal) return json(e.status, refusalBody(e));
    // A store-level rejection (`memory text is empty`, `gateway key not found`) is a 400:
    // the caller named an act the host refuses, which is not a server fault.
    return json(400, { error: { message: String((e as Error).message ?? e), type: "invalid_request", code: null } });
  }
}

/** Answer an admin request if it is one, else `null` so the real network can have it. */
async function tryServeAdmin(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
  if (typeof input !== "string" && !(input instanceof URL)) return null; // a `Request` we do not model
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.href, location.href);
  } catch {
    return null;
  }
  if (!isAdminTarget(url)) return null;
  return serveAdmin(init?.method ?? "GET", url, init);
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
  if (!k) throw new Error(`secret ${secretRef} not found in secrets (re-enter the key)`);
  const p = providers.get(k.providerId);
  if (!p) throw new Error(`secret ${secretRef} has no provider (re-enter the key)`);
  let expectedHost: string;
  try {
    expectedHost = new URL(p.baseUrl).hostname;
  } catch {
    throw new Error(`provider ${p.slug} has an invalid baseUrl`);
  }
  const secret = secrets.get(secretRef);
  if (secret === undefined) throw new Error(`secret ${secretRef} not found in secrets (re-enter the key)`);
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
// ...and so does the admin transport. Bound before the patch so an egress call can never
// re-enter the interceptor.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  (await tryServeAdmin(input, init)) ?? nativeFetch(input as RequestInfo, init)) as typeof fetch;
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

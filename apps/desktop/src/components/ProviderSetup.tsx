/**
 * Provider setup: the guided manual add, and the editor for a provider that already exists.
 *
 * Why this lives beside the Providers screen rather than inside it: the add flow and the edit flow
 * share the connection form and the model list verbatim, and a copy of either would drift — the
 * same failure `lib/providers/manual-manifest.ts` exists to prevent, where a hand-written manifest
 * and the template it meant to mirror disagreed in four ways at once.
 *
 * **The wizard creates the provider before it is finished.** That is deliberate and it is the whole
 * point of the feature: a model can only be tested by sending it a request, a request needs a key,
 * and a key needs a provider row. A wizard that saved nothing until the last step could not let the
 * operator test a model before committing to the provider — so the abort case is a visible
 * `draft` provider the operator can remove, rather than a form that cannot answer the question it
 * is asking.
 */
import { useEffect, useState } from "react";
import type { Modality } from "@aiprovider/adapter-spec";
import { PROVIDER_PROFILES, PROVIDER_PROFILE_LABELS, type AdapterManifest } from "@aiprovider/router-core";
import {
  adapters, addKey, addManualModel, addProvider, catalog, refreshCatalog, registry,
  removeManualModel, setProviderStatus, testModel, uniqueSlug, updateProvider,
} from "../store";
import { Button, Field, Modal, inputCls, inputStyle } from "./atoms";
import {
  authHeaderFor, buildManualManifest, headersToLines, parseHeaderLines, type ManualDialect,
} from "../lib/providers/manual-manifest";

// One entry per builtin profile. Display names come from `PROVIDER_PROFILE_LABELS` rather than a
// second copy here: the two lists drifted the moment a profile was added, and only one of them was
// the source of truth.
const KNOWN = Object.keys(PROVIDER_PROFILES);

type AuthChoice = "bearer" | "x-api-key" | "custom";

/** Everything the connection step collects. Shared by add and edit. */
interface ConnectionDraft {
  name: string;
  url: string;
  auth: AuthChoice;
  authHeader: string;
  authPrefix: string;
  dialect: string;
  /**
   * Custom request headers, one `Name: value` per line.
   *
   * A free-text field rather than a row editor because the content is a header block the operator
   * copies from a provider's documentation, and a pair of inputs per row would fight that.
   */
  headers: string;
}

function emptyDraft(): ConnectionDraft {
  return {
    name: "", url: "", auth: "bearer", authHeader: "Authorization",
    authPrefix: "Bearer", dialect: "openai-chat-v1", headers: "",
  };
}

/**
 * The manifest for a draft.
 *
 * Derived from the builtin template for the chosen dialect — never hand-assembled — so anything the
 * template gains (tool-call mapping, streaming reassembly, the Anthropic paths) a manual provider
 * gains too.
 */
function draftManifest(d: ConnectionDraft): AdapterManifest {
  return buildManualManifest({
    url: d.url.trim(),
    dialect: d.dialect as ManualDialect,
    authHeader: authHeaderFor(d.auth, d.authHeader, d.authPrefix),
    extraHeaders: parseHeaderLines(d.headers).headers,
  });
}

function draftError(d: ConnectionDraft): string | null {
  if (d.name.trim().length < 2) return "Give the provider a name.";
  if (!/^https?:\/\//.test(d.url.trim())) return "The base URL must start with http:// or https://.";
  if (d.auth === "custom" && !d.authHeader.trim()) return "A custom auth header needs a header name.";
  const parsed = parseHeaderLines(d.headers);
  if (parsed.problems.length) return `Custom headers: ${parsed.problems.join("; ")}.`;
  // **A custom header must not shadow the credential.** The interpreter merges the endpoint's
  // headers *over* the auth headers, so an operator entry named like the auth header would replace
  // the `{{secret}}` sentinel with a literal. Rust then refuses the request outright
  // (`EgressError::SentinelMissing`) — a correct refusal, but the operator would be looking for a
  // credential problem in a form that had just told them their key was fine. Refusing at input time
  // is where the cause is still visible.
  const authName = authHeaderFor(d.auth, d.authHeader, d.authPrefix).name.toLowerCase();
  const clash = Object.keys(parsed.headers).find((k) => k.toLowerCase() === authName);
  if (clash) return `"${clash}" is the auth header — remove it from custom headers.`;
  return null;
}

/** The connection form, shared by the add wizard and the editor. */
function ConnectionFields({
  d, setD, showName = true,
}: {
  d: ConnectionDraft;
  setD: (patch: Partial<ConnectionDraft>) => void;
  showName?: boolean;
}) {
  return (
    <div className="space-y-3">
      {showName && (
        <Field label="Name">
          <input
            className={inputCls} style={inputStyle} value={d.name}
            onChange={(e) => setD({ name: e.target.value })}
            placeholder="My Provider" autoFocus
          />
        </Field>
      )}
      <Field label="Base URL">
        <input
          className={`${inputCls} mono`} style={inputStyle} value={d.url}
          onChange={(e) => setD({ url: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
        <span className="mt-1 block text-[11px] leading-snug" style={{ color: "var(--text-faint)" }}>
          Include the API path. Most providers serve the API under <code>/v1</code> — use
          <code> https://host/v1</code>, not <code>https://host</code>. Endpoint paths such as
          <code> /models</code> are appended to this.
        </span>
      </Field>
      <Field label="Auth type">
        <select
          className={inputCls} style={inputStyle} value={d.auth}
          onChange={(e) => setD({ auth: e.target.value as AuthChoice })}
        >
          <option value="bearer">Bearer token (Authorization: Bearer …)</option>
          <option value="x-api-key">x-api-key header</option>
          <option value="custom">Custom header</option>
        </select>
      </Field>
      {d.auth === "custom" && (
        <>
          <Field label="Header name">
            <input
              className={inputCls} style={inputStyle} value={d.authHeader}
              onChange={(e) => setD({ authHeader: e.target.value })}
              placeholder="X-Custom-Auth"
            />
          </Field>
          <Field label="Prefix (optional)">
            <input
              className={inputCls} style={inputStyle} value={d.authPrefix}
              onChange={(e) => setD({ authPrefix: e.target.value })}
              placeholder="e.g. Token"
            />
          </Field>
        </>
      )}
      <Field label="Dialect">
        <select
          className={inputCls} style={inputStyle} value={d.dialect}
          onChange={(e) => setD({ dialect: e.target.value })}
        >
          <option value="openai-chat-v1">openai-chat-v1</option>
          <option value="anthropic-messages-v1">anthropic-messages-v1</option>
        </select>
      </Field>
      <Field label="Custom headers (optional)">
        <textarea
          className={`${inputCls} mono`} style={{ ...inputStyle, minHeight: "4.5rem" }}
          value={d.headers}
          onChange={(e) => setD({ headers: e.target.value })}
          placeholder={"user-agent: claude-cli/2.0.0 (external, cli)"}
          spellCheck={false}
        />
        <span className="mt-1 block text-[11px] leading-snug" style={{ color: "var(--text-faint)" }}>
          One <code>Name: value</code> per line, sent on <strong>every</strong> request to this
          provider — including the model list. Some gateways refuse a client they do not recognise
          with <code>401</code> before they look at the key; this is where you tell them who you are.
          Blank lines and <code>#</code> comments are ignored.
        </span>
      </Field>
    </div>
  );
}

// ---------- model list ----------

interface TestOutcome {
  ok: boolean;
  message: string;
  preview?: string;
}

/**
 * A provider's models: add one by hand, test any of them, remove the ones added by hand.
 *
 * Manual rows are listed first and badged, because the distinction is load-bearing — a discovered
 * row is replaced on every refresh, a manual one is kept, and the operator needs to be able to see
 * which of their entries will survive the next Refresh.
 */
function ModelsPanel({
  providerId, onCountChange,
}: {
  providerId: string;
  /**
   * Announces the row count to the wizard's footer.
   *
   * The parent cannot read it off `catalog` during render: the catalog is not observable, so a
   * parent that computed the count itself would render "Finish & enable" disabled forever after
   * the first model was added — a button whose enabled state was computed once and never again.
   */
  onCountChange?: (n: number) => void;
}) {
  // Local version counter: the catalog is a plain object the screen does not observe, so a mutation
  // has to announce itself. `useUi`'s tick is the wrong signal here — it is bumped by the *caller*
  // on close, not by an add or a test inside this panel.
  const [v, setV] = useState(0);
  void v;
  const bump = () => setV((x) => x + 1);

  // Announced after every mutation, never derived by the parent: see `onCountChange`.
  const announce = () =>
    onCountChange?.(catalog.all().filter((m) => m.providerId === providerId).length);

  const [nativeId, setNativeId] = useState("");
  const [modality, setModality] = useState<Modality>("text");
  const [ctxRaw, setCtxRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestOutcome>>({});

  const rows = catalog
    .all()
    .filter((m) => m.providerId === providerId)
    // Manual first: the operator's own entries are the ones whose fate differs on refresh.
    .sort((a, b) => {
      const am = a.origin === "manual" ? 0 : 1;
      const bm = b.origin === "manual" ? 0 : 1;
      return am - bm || a.nativeId.localeCompare(b.nativeId);
    });

  async function add() {
    const id = nativeId.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Parsed once, and only when the field is non-empty: `Number("")` is `0`, which would claim
      // a zero-token window rather than an unknown one.
      const raw = ctxRaw.trim();
      const window = raw === "" ? undefined : Number(raw);
      if (window !== undefined && (!Number.isFinite(window) || window <= 0)) {
        throw new Error("Context window must be a positive number of tokens, or left blank.");
      }
      await addManualModel({ providerId, nativeId: id, modality, contextWindow: window });
      setNativeId("");
      setCtxRaw("");
      bump();
      announce();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest(id: string) {
    setTests((t) => ({ ...t, [id]: { ok: false, message: "Testing…" } }));
    try {
      const r = await testModel(providerId, id);
      setTests((t) => ({ ...t, [id]: { ok: r.ok, message: r.message, preview: r.preview } }));
    } catch (e) {
      // A throw here is a precondition, not a verdict — no active key, no adapter. Reported as a
      // failure the operator can act on, never as a model that answered.
      setTests((t) => ({ ...t, [id]: { ok: false, message: (e as Error).message } }));
    }
  }

  async function fetchFromProvider() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const n = await refreshCatalog(providerId);
      setNotice(n === 0 ? "The provider listed no models." : `Fetched ${n} models from the provider.`);
      bump();
      announce();
    } catch (e) {
      setError(`Could not list this provider's models — ${(e as Error).message}. Add them by hand instead.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Models
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>{rows.length} known</span>
        <Button variant="ghost" ariaLabel="Fetch models from this provider" onClick={() => void fetchFromProvider()} disabled={busy}>
          {busy ? "Working…" : "Fetch from provider"}
        </Button>
      </div>

      {rows.length === 0 && (
        <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
          No models yet. If the provider lists them, fetch them; otherwise type the model id the
          provider expects — it is the exact string a request sends in <span className="mono">model</span>.
        </p>
      )}

      {rows.length > 0 && (
        <table className="w-full">
          <tbody>
            {rows.map((m) => {
              const t = tests[m.nativeId];
              return (
                <tr key={m.nativeId} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="mono text-[12px]">{m.nativeId}</span>
                      {m.origin === "manual" && (
                        <span
                          className="rounded px-1 text-[10px]"
                          style={{ background: "var(--surface-2)", color: "var(--text-faint)" }}
                          title="Added by hand — kept when the catalog is refreshed"
                        >
                          manual
                        </span>
                      )}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                      {m.modality}
                      {m.contextWindow ? ` · ${m.contextWindow.toLocaleString()} tokens` : " · window unknown"}
                    </div>
                    {t && (
                      <div
                        className="text-[11px]"
                        style={{ color: t.ok ? "var(--success)" : "var(--danger)" }}
                        role="status"
                      >
                        {t.ok ? "✓" : "✕"} {t.message}
                        {t.preview ? ` — “${t.preview}”` : ""}
                      </div>
                    )}
                  </td>
                  <td className="w-[130px] py-1.5 text-right">
                    <Button
                      ariaLabel={`Test model ${m.nativeId}`}
                      disabled={busy || t?.message === "Testing…"}
                      onClick={() => void runTest(m.nativeId)}
                    >
                      {t?.message === "Testing…" ? "Testing…" : "Test"}
                    </Button>
                    {m.origin === "manual" && (
                      <Button
                        variant="ghost"
                        ariaLabel={`Remove model ${m.nativeId}`}
                        disabled={busy}
                        onClick={async () => {
                          await removeManualModel(providerId, m.nativeId);
                          bump();
                          announce();
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="mt-2 flex items-end gap-2">
        <div className="flex-1">
          <Field label="Model id">
            <input
              className={`${inputCls} mono`} style={inputStyle} value={nativeId}
              onChange={(e) => setNativeId(e.target.value)}
              placeholder="gpt-4o-mini"
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            />
          </Field>
        </div>
        <div className="w-[92px]">
          <Field label="Type">
            <select
              className={inputCls} style={inputStyle} value={modality}
              onChange={(e) => setModality(e.target.value as Modality)}
            >
              <option value="text">text</option>
              <option value="image">image</option>
            </select>
          </Field>
        </div>
        <div className="w-[120px]">
          <Field label="Context">
            <input
              className={`${inputCls} mono`} style={inputStyle} value={ctxRaw}
              onChange={(e) => setCtxRaw(e.target.value)}
              placeholder="128000"
              inputMode="numeric"
            />
          </Field>
        </div>
        <Button variant="primary" disabled={busy || !nativeId.trim()} onClick={() => void add()}>
          Add
        </Button>
      </div>

      <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Test sends one short request to the model and reports what came back. Context window is
        optional — blank means unknown, and the router then plans against its conservative default.
      </p>

      {error && <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }} role="alert">{error}</p>}
      {notice && <p className="mt-2 text-[12px]" style={{ color: "var(--text-dim)" }}>{notice}</p>}
    </div>
  );
}

// ---------- add wizard ----------

type Step = "connection" | "key" | "models";

const STEP_LABEL: Record<Step, string> = {
  connection: "Connection", key: "API key", models: "Models",
};

export function AddProviderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"known" | "manual">("known");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [step, setStep] = useState<Step>("connection");
  const [draft, setDraft] = useState<ConnectionDraft>(emptyDraft());
  const [providerId, setProviderId] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState("key-01");
  const [keySecret, setKeySecret] = useState("");
  // Owned here, reported by `ModelsPanel`: counting during render would freeze at the value the
  // step had when it opened, and "Finish & enable" would never become reachable.
  const [modelCount, setModelCount] = useState(0);

  async function addKnown(s: string) {
    setBusy(true);
    try {
      const manifest = PROVIDER_PROFILES[s]!() as AdapterManifest;
      await addProvider({
        slug: s,
        name: PROVIDER_PROFILE_LABELS[s] ?? s,
        type: "builtin",
        baseUrl: manifest.provider.baseUrl,
        manifest,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createProvider() {
    const problem = draftError(draft);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const p = await addProvider({
        slug: uniqueSlug(draft.name.trim()),
        name: draft.name.trim(),
        type: "manifest",
        baseUrl: draft.url.trim(),
        manifest: draftManifest(draft),
      });
      setProviderId(p.id);
      setStep("key");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (!providerId || !keySecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addKey(providerId, keyLabel.trim() || "key-01", keySecret.trim());
      setStep("models");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish(enable: boolean) {
    if (providerId && enable) {
      await setProviderStatus(providerId, "enabled").catch(() => undefined);
    }
    onDone();
  }

  if (mode === "known") {
    return (
      <Modal title="Add Provider" onClose={onClose}>
        <div className="mb-3 flex gap-1 rounded border p-1" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          {(["known", "manual"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              className="flex-1 rounded px-3 py-1 text-[12px] font-medium transition-colors"
              style={mode === m ? { background: "var(--accent)", color: "var(--bg)" } : {}}
            >
              {m === "known" ? "Quick add" : "Manual"}
            </button>
          ))}
        </div>
        <div className="mb-3 grid gap-2">
          {KNOWN.map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => addKnown(s)}
              className="flex items-center justify-between rounded border px-3 py-2 text-left hover:brightness-110 disabled:opacity-50"
              style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
            >
              <span className="text-[13px] font-medium">
                {PROVIDER_PROFILE_LABELS[s] ?? s}
              </span>
              <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                {PROVIDER_PROFILES[s]!().provider.baseUrl}
              </span>
            </button>
          ))}
        </div>
        {error && <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
        {busy && <p className="mt-2 text-[12px]" style={{ color: "var(--text-dim)" }}>Registering…</p>}
      </Modal>
    );
  }

  const steps: Step[] = ["connection", "key", "models"];
  const hasModels = modelCount > 0;

  return (
    <Modal
      title={providerId ? `Add Provider — ${registry.getProvider(providerId)?.name ?? ""}` : "Add Provider"}
      onClose={onClose}
      width={560}
    >
      <div className="mb-3 flex items-center gap-2">
        {steps.map((s, i) => {
          const active = s === step;
          const done = steps.indexOf(step) > i;
          return (
            <div key={s} className="flex items-center gap-2">
              <span
                className="flex items-center gap-1.5 text-[12px]"
                style={{ color: active ? "var(--text)" : done ? "var(--success)" : "var(--text-faint)" }}
              >
                <span
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[10px]"
                  style={{
                    background: active ? "var(--accent)" : "var(--surface-2)",
                    color: active ? "white" : undefined,
                  }}
                >
                  {done ? "✓" : i + 1}
                </span>
                {STEP_LABEL[s]}
              </span>
              {i < steps.length - 1 && <span style={{ color: "var(--text-faint)" }}>›</span>}
            </div>
          );
        })}
      </div>

      {step === "connection" && (
        <>
          <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
            Add any OpenAI- or Anthropic-compatible provider. The adapter manifest is generated
            automatically.
          </p>
          <ConnectionFields d={draft} setD={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void createProvider()}>
              {busy ? "Adding…" : "Continue"}
            </Button>
          </div>
        </>
      )}

      {step === "key" && (
        <>
          <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
            A key is needed before a model can be tested — the test sends a real request. It is
            stored in a local secrets file your user account can read, never in the database.
          </p>
          <Field label="Label">
            <input className={inputCls} style={inputStyle} value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} />
          </Field>
          <Field label="API key">
            <input
              className={`${inputCls} mono`} type="password" style={inputStyle} value={keySecret}
              onChange={(e) => setKeySecret(e.target.value)} placeholder="sk-…" autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setStep("models")}>Skip for now</Button>
            <Button variant="primary" disabled={busy || !keySecret.trim()} onClick={() => void saveKey()}>
              {busy ? "Storing…" : "Add key"}
            </Button>
          </div>
        </>
      )}

      {step === "models" && providerId && (
        <>
          <ModelsPanel providerId={providerId} onCountChange={setModelCount} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => void finish(false)}>Finish</Button>
            <Button
              variant="primary"
              disabled={!hasModels}
              onClick={() => void finish(true)}
            >
              Finish & enable
            </Button>
          </div>
          {!hasModels && (
            <p className="mt-1 text-right text-[11px]" style={{ color: "var(--text-faint)" }}>
              A provider with no model cannot serve a request.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }} role="alert">{error}</p>}
    </Modal>
  );
}

// ---------- editor ----------

/**
 * Edit a provider that already exists: its name, its connection, and its models.
 *
 * A changed connection is written as a new manifest version rather than an update in place, so the
 * previous wiring stays available to roll back to. The slug is not editable — it is the identity a
 * client sends in `provider/model` and the key of every catalog row.
 */
export function EditProviderModal({
  providerId, onClose, onDone,
}: { providerId: string; onClose: () => void; onDone: () => void }) {
  const p = registry.getProvider(providerId);
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({
    ...emptyDraft(),
    name: p?.name ?? "",
    url: p?.baseUrl ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  /**
   * Load the connection the provider *actually* has before offering to save it.
   *
   * The form's defaults are Bearer + openai-chat-v1, which is right for a new provider and wrong
   * for most existing ones. Saving without this load would silently rewrite an `x-api-key`
   * provider to send `Authorization: Bearer <secret>` — an edit presented as "Saved" that breaks
   * every request, and one the operator has no way to see, because the form shows the defaults as
   * if they were the current values.
   *
   * Save stays disabled until the load answers, so the form can never be saved as something it
   * has not yet read.
   */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError(null);
    adapters
      .forProvider(providerId)
      .then(({ adapter }) => {
        if (!alive) return;
        const m = adapter.manifest;
        const header = m.provider.auth.headers?.[0];
        const name = header?.name ?? "";
        const prefix = header?.prefix ?? "";
        const dialect =
          m.dialect === "anthropic-messages-v1" ? "anthropic-messages-v1" : "openai-chat-v1";
        setDraft((d) => ({
          ...d,
          auth:
            name.toLowerCase() === "x-api-key"
              ? "x-api-key"
              : name === "Authorization" && prefix === "Bearer"
                ? "bearer"
                : "custom",
          authHeader: name || "Authorization",
          authPrefix: prefix,
          dialect,
          // Without this an edit would write a manifest that had lost the operator's headers —
          // see `headersToLines`. `save()` rebuilds from the draft whenever anything differs, so an
          // empty box here is a deletion, not a no-op.
          headers: headersToLines(m, dialect),
        }));
        setLoaded(true);
      })
      .catch((e) => {
        if (!alive) return;
        // No adapter means no active manifest row. The name and URL still came from the registry,
        // so the form is usable for those; only the connection shape is unknown, and it says so
        // rather than offering defaults the operator would read as current.
        setLoadError(`This provider's adapter could not be read — ${String(e)}`);
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [providerId]);

  if (!p) return null;

  async function save() {
    const problem = draftError(draft);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = draftManifest(draft);
      // Only a changed connection earns a new manifest version. Saving the form without editing
      // anything must not append versions to the history the drift register and rollback read.
      const current = await adapters.forProvider(providerId).then((a) => a.adapter.manifest).catch(() => undefined);
      const changed = !current || JSON.stringify(current) !== JSON.stringify(next);
      await updateProvider({
        id: providerId,
        name: draft.name,
        baseUrl: draft.url,
        ...(changed ? { manifest: next } : {}),
      });
      setSaved(changed ? "Saved — the connection change was written as a new adapter version." : "Saved.");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit — ${p.name}`} onClose={onClose} width={560}>
      <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Slug <span className="mono">{p.slug}</span> — not editable, because it is what a client sends
        in <span className="mono">model</span> and the key of every catalog row.
      </p>

      {!loaded && <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>Reading the current connection…</p>}
      {loadError && <p className="mb-3 text-[12px]" style={{ color: "var(--warn)" }}>{loadError}</p>}

      <ConnectionFields d={draft} setD={(patch) => setDraft((d) => ({ ...d, ...patch }))} />

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? "Saving…" : "Save connection"}
        </Button>
      </div>

      <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <ModelsPanel providerId={providerId} />
      </div>

      {error && <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }} role="alert">{error}</p>}
      {saved && <p className="mt-2 text-[12px]" style={{ color: "var(--success)" }} role="status">{saved}</p>}
    </Modal>
  );
}

/**
 * Router Settings (UI_UX_PLAN.md §5): sectioned — Routing / Reliability / System AI — no
 * mega-form. System AI gets the explanatory treatment (what it powers, why it's locked
 * until the first provider, §2.9 bootstrap guard). Phase 6 adds Config & diagnostics
 * (export/import without secrets, scrubbed bug-report bundle).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProviderRecord } from "@aiprovider/router-core";
import {
  catalog, clearAllCrashes, clearCrash, exportConfig, getCrashCount,
  getDiagnosticsBundle, historyRetentionPreview, historyRetentionPrune, importConfig, listCrashes, readCrash,
  persistRouterSettings, registry, router, setProviderRotation,
} from "../store";
import type { CrashReport, HistoryRetentionCounts } from "../store";
import { selectableModels } from "../lib/models/selectable";
import { fetchMcpServers, refreshMcp, saveMcpServers } from "../lib/tools/mcp-client";
import type { McpServerConfig } from "../lib/tools/mcp";
import { fetchToolsPolicy, setToolsExtraPrograms } from "../lib/tools";
import type { ToolsPolicy } from "../lib/tools";
import { useUi } from "../ui-state";
import { Button, StatusDot } from "../components/atoms";
import { invoke } from "@tauri-apps/api/core";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function SettingsScreen() {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const providers = useMemo(() => registry.listProviders().filter((p) => p.status === "enabled"), [tick]);
  const ai = router.systemAiAvailable();
  const settings = router.settings;

  // ── Crash report banner state ──────────────────────────────────────────────
  const [crashCount, setCrashCount] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [crashes, setCrashes] = useState<CrashReport[]>([]);
  const [crashesLoading, setCrashesLoading] = useState<boolean>(true);
  const [crashing, setCrashing] = useState<boolean>(false);

  const loadCrashInfo = async (wantList: boolean) => {
    setCrashesLoading(true);
    try {
      const n = await getCrashCount();
      setCrashCount(n);
      if (n > 0 && wantList) {
        const ids = await listCrashes();
        const reports = (await Promise.all(ids.map((id) => readCrash(id))))
          .filter((r): r is CrashReport => r !== null);
        setCrashes(reports);
      }
    } finally {
      setCrashesLoading(false);
    }
  };

  // The reports themselves are only read once the panel is open, so opening it has to re-run the
  // load — keying the effect on `expanded` is what makes the list appear.
  useEffect(() => { void loadCrashInfo(expanded); }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClearAll = async () => {
    setCrashing(true);
    try {
      await clearAllCrashes();
      setCrashCount(0);
      setCrashes([]);
      setExpanded(false);
    } finally {
      setCrashing(false);
    }
  };

  const handleClearOne = async (id: string) => {
    await clearCrash(id);
    setCrashCount((n) => n - 1);
    setCrashes((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-[20px] font-semibold">Router Settings</h1>

      {crashCount > 0 && (
        <div
          className="mb-4 rounded border px-3 py-2.5"
          style={{ borderColor: "var(--danger, #e5484d)", background: "var(--surface-danger, rgba(229,72,77,0.06))" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: "var(--danger, #e5484d)" }}>
              <span style={{ fontSize: 14 }}>⚠</span>
              {crashCount === 1 ? "1 crash report found" : `${crashCount} crash reports found`}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: "var(--border)", color: "var(--text-faint)", background: "transparent" }}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Hide" : "Details"}
              </button>
              <button
                className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-50"
                style={{ borderColor: "var(--danger, #e5484d)", color: "var(--danger, #e5484d)", background: "transparent" }}
                disabled={crashing}
                onClick={handleClearAll}
              >
                {crashing ? "Clearing…" : "Clear all"}
              </button>
            </div>
          </div>
          {expanded && crashes.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-2">
              {crashes.map((r) => (
                <div
                  key={r.id}
                  className="rounded border p-2"
                  style={{ borderColor: "var(--border)", background: "var(--bg-elevated, var(--surface))" }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{r.id}</div>
                      <div className="mt-0.5 text-[12px] truncate" style={{ color: "var(--text)" }}>{r.message}</div>
                    </div>
                    <button
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50"
                      style={{ borderColor: "var(--border)", color: "var(--text-faint)", background: "transparent" }}
                      onClick={() => handleClearOne(r.id)}
                    >
                      ✕
                    </button>
                  </div>
                  <pre className="mt-1.5 max-h-24 overflow-auto text-[10px] mono" style={{ color: "var(--text-dim)" }}>
                    {r.backtrace}
                  </pre>
                </div>
              ))}
              <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                Reports are stored locally in the app data directory — no data is sent anywhere.
              </p>
            </div>
          )}
          {expanded && crashes.length === 0 && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
              {crashesLoading ? "Loading…" : "No crash reports to show."}
            </p>
          )}
        </div>
      )}

      <Section title="Routing">
        <p className="mb-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
          <strong style={{ color: "var(--text-dim)" }}>Provider failover</strong> and the{" "}
          <strong style={{ color: "var(--text-dim)" }}>per-provider in-flight cap</strong> moved to{" "}
          <strong style={{ color: "var(--text-dim)" }}>Control → Routing</strong>. They are
          operational switches — the ones you flip in response to something — so they belong next to
          the traffic they affect, not next to the preferences. What stays here is the preference:
          which model each modality defaults to.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {(["text", "image"] as const).map((mod) => (
            <label key={mod} className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Default {mod} model</span>
              <DefaultModelPicker modality={mod} />
            </label>
          ))}
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Image-reading model</span>
            <VisionHelperPicker />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Subagent step budget</span>
            <input
              className="mono w-full rounded border px-2 py-1 text-[12px]"
              style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
              type="number"
              min={1}
              placeholder="no limit"
              value={(router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.subagentIterations ?? ""}
              onChange={(e) => {
                const cast = router.settings as typeof router.settings & { defaults?: Record<string, string> };
                cast.defaults = { ...(cast.defaults ?? {}), subagentIterations: e.target.value };
                persistRouterSettings();
                bump();
              }}
            />
            <span className="mt-1 block text-[11px]" style={{ color: "var(--text-faint)" }}>
              Model round-trips one dispatch_agent sub-agent gets. Blank = no limit — real
              sub-agent work runs long (measured: median 24 tool calls, p90 55), so a low number
              here cuts legitimate work short. Only how many run at once is capped.
            </span>
          </label>
        </div>
      </Section>

      <Section title="Reliability" hint="Defaults: connect 10s · headers 20s · first byte 20s · idle stream 120s · plan 44s · 6 attempts (§3.6). Per-provider overrides live under Providers → Edit → Timeouts & retries.">
        <div className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>
          connect 10s · headers 20s · first byte 20s · idle 120s · plan 44s · attempts 6 · jittered backoff honoring Retry-After
        </div>
      </Section>

      <Section
        title="System AI"
        hint="The model that powers fingerprinting, adapter generation, and diagnostics — it runs against your configured providers, never a middleman. Every generation request excludes the provider being onboarded, so the router can never serve a request through an adapter that does not exist yet (§2.8)."
      >
        <div className="mb-2 flex items-center gap-2 text-[12px]">
          <StatusDot health={ai.available ? "healthy" : "unknown"} pulse={!ai.available} />
          <span style={{ color: "var(--text-dim)" }}>
            {ai.available ? "AI-assisted paths unlocked" : ai.reason ?? "Locked"}
          </span>
        </div>
        <div className="flex gap-2">
          <select
            className="rounded border px-2 py-1 text-[12px] disabled:opacity-50"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            disabled={!ai.available}
            value={settings.systemAi?.providerId ?? ""}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              settings.systemAi = p ? { providerId: p.id, model: settings.systemAi?.model ?? "" } : null;
              persistRouterSettings();
              bump();
            }}
          >
            <option value="">Auto (any healthy provider)</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select
            className="mono rounded border px-2 py-1 text-[12px] disabled:opacity-50"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            disabled={!ai.available || !settings.systemAi}
            value={settings.systemAi?.model ?? ""}
            onChange={(e) => {
              if (settings.systemAi) settings.systemAi = { ...settings.systemAi, model: e.target.value };
              persistRouterSettings();
              bump();
            }}
          >
            <option value="">model…</option>
            {settings.systemAi &&
              catalog.forModality("text").filter((m) => m.providerId === settings.systemAi!.providerId).map((m) => (
                <option key={m.nativeId} value={m.nativeId}>{m.nativeId}</option>
              ))}
          </select>
        </div>
      </Section>

      <Section title="Per-provider key rotation" hint="Strategy used to order keys within one provider when picking who serves a request.">
        <div className="flex flex-col gap-2">
          {registry.listProviders().map((p) => (
            <RotationRow key={p.id} provider={p} onChanged={bump} />
          ))}
          {registry.listProviders().length === 0 && (
            <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>No providers yet.</span>
          )}
        </div>
      </Section>

      <ToolSandboxSection />

      <McpSection />

      <HistoryRetentionSection />

      <ConfigDiagnosticsSection />
    </div>
  );
}

/**
 * The `run_command` sandbox's user-extensible program list (2026-10-13).
 *
 * What is editable here is only the *additions*. The baseline is the shipped posture, and the
 * never-allowed list is published rather than hidden — a user who cannot see the boundary adds past
 * it and reads the refusal as a bug. The section renders the policy the **host returned**, never
 * the list that was typed: the host trims, de-duplicates, sorts and may refuse, so echoing the
 * input would claim a program runs that does not.
 */
function ToolSandboxSection() {
  const [policy, setPolicy] = useState<ToolsPolicy | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const input = "rounded border px-2 py-1 text-[12px]";
  const inputStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" };

  useEffect(() => {
    void fetchToolsPolicy().then(setPolicy).catch(() => undefined);
  }, []);

  /** Write the whole list, then render what the host says is now true. */
  async function save(next: string[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPolicy(await setToolsExtraPrograms(next));
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const extras = policy?.extra_programs ?? [];

  return (
    <Section
      title="Agent tool sandbox"
      hint="Programs agent mode may start with run_command. The baseline is fixed; additions widen it on this machine only, and never past the refused list."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            aria-label="Additional program"
            className={`${input} mono w-56`}
            style={inputStyle}
            placeholder="cargo"
            value={draft}
            disabled={busy || !policy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim() && !busy) void save([...extras, draft]);
            }}
          />
          <button
            className={`${input} disabled:opacity-50`}
            style={inputStyle}
            disabled={busy || !policy || !draft.trim()}
            onClick={() => void save([...extras, draft])}
          >
            Add program
          </button>
        </div>

        {error && (
          <span className="text-[11px]" style={{ color: "var(--danger)" }} role="alert">
            {error}
          </span>
        )}

        {extras.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {extras.map((p) => (
              <li key={p} className="flex items-center gap-2 text-[12px]">
                <code className="mono">{p}</code>
                <button
                  aria-label={`Remove ${p}`}
                  className="text-[11px] disabled:opacity-50"
                  style={{ color: "var(--text-faint)" }}
                  disabled={busy}
                  onClick={() => void save(extras.filter((x) => x !== p))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            No additions — only the baseline programs start.
          </span>
        )}

        {policy && (
          <details>
            <summary className="cursor-pointer text-[11px]" style={{ color: "var(--text-dim)" }}>
              {policy.programs.length} baseline programs · {policy.never_allowed.length} refused
            </summary>
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
              Baseline: {policy.programs.join(", ")}
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
              Refused even when added: {policy.never_allowed.join(", ")}
            </p>
          </details>
        )}
      </div>
    </Section>
  );
}

/**
 * MCP servers (2026-10-06): the list the Assistant's tool registry is extended with. A server is
 * a command the app spawns and speaks JSON-RPC to; its tools join agent mode with the server's
 * own `readOnlyHint` deciding read vs mutate (absence fails closed to mutate, so every
 * third-party call asks first).
 */
function McpSection() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ id: "", command: "", args: "", env: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshed, setRefreshed] = useState<{ tools: number; servers: number; failures: string[] } | null>(null);

  useEffect(() => {
    void fetchMcpServers().then((s) => {
      setServers(s);
      setLoaded(true);
    });
  }, []);

  const persist = async (next: McpServerConfig[]) => {
    setBusy(true);
    setError(null);
    try {
      await saveMcpServers(next);
      setServers(next);
      setRefreshed(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await refreshMcp();
      const live = new Set(outcome.tools.map((t) => t.server));
      setRefreshed({ tools: outcome.tools.length, servers: live.size, failures: outcome.failures });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doAdd = async () => {
    const args = draft.args.trim() ? draft.args.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    for (const line of draft.env.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) {
        setError(`Env line "${t}" is not KEY=VALUE.`);
        return;
      }
      env[t.slice(0, eq)] = t.slice(eq + 1);
    }
    const next = [
      ...servers,
      { id: draft.id.trim(), command: draft.command.trim(), args, env, enabled: true },
    ];
    setBusy(true);
    setError(null);
    try {
      await saveMcpServers(next);
      setServers(next);
      setDraft({ id: "", command: "", args: "", env: "" });
      setShowAdd(false);
      setRefreshed(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded border px-2 py-0.5 text-[11px] disabled:opacity-50";
  const btnStyle = { borderColor: "var(--border)", color: "var(--text-dim)", background: "transparent" };
  const input = "rounded border px-2 py-1 text-[12px]";
  const inputStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" };

  return (
    <Section
      title="MCP servers"
      hint="Model Context Protocol servers whose tools join agent mode. Each server's own readOnlyHint decides whether a call is treated as read or as a mutation — a server that does not mark its tools asks before every call."
    >
      <div className="flex flex-col gap-2">
        {!loaded && <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>Loading…</span>}
        {loaded && servers.length === 0 && !showAdd && (
          <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>No servers configured.</span>
        )}
        {servers.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <span className="mono text-[12px]" style={{ color: "var(--text)" }}>{s.id}</span>
            <span className="mono min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
              {s.command} {s.args.join(" ")}
            </span>
            <button
              className={btn}
              style={{ ...btnStyle, color: s.enabled ? "var(--success)" : "var(--text-faint)" }}
              disabled={busy}
              onClick={() => persist(servers.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))}
            >
              {s.enabled ? "enabled" : "disabled"}
            </button>
            <button
              className={btn}
              style={btnStyle}
              disabled={busy}
              onClick={() => persist(servers.filter((_, j) => j !== i))}
            >
              remove
            </button>
          </div>
        ))}
      </div>

      {showAdd && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              className={`${input} w-32`}
              style={inputStyle}
              placeholder="id (github)"
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
            <input
              className={`${input} mono min-w-0 flex-1`}
              style={inputStyle}
              placeholder="command (npx, /usr/local/bin/server.py…)"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </div>
          <input
            className={`${input} mono`}
            style={inputStyle}
            placeholder="arguments, space separated (-y @modelcontextprotocol/server-github)"
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          />
          <textarea
            className={`${input} mono h-16`}
            style={inputStyle}
            placeholder={"environment, one KEY=VALUE per line (GITHUB_TOKEN=…)"}
            value={draft.env}
            onChange={(e) => setDraft({ ...draft, env: e.target.value })}
          />
          <div className="flex gap-2">
            <button
              className={btn}
              style={{ ...btnStyle, borderColor: "var(--accent, var(--border))", color: "var(--text)" }}
              disabled={busy || !draft.id.trim() || !draft.command.trim()}
              onClick={doAdd}
            >
              Save server
            </button>
            <button className={btn} style={btnStyle} disabled={busy} onClick={() => { setShowAdd(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={btn}
          style={{ ...btnStyle, borderColor: "var(--accent, var(--border))", color: "var(--text)" }}
          disabled={busy || showAdd}
          onClick={() => { setShowAdd(true); setError(null); }}
        >
          Add server
        </button>
        <button className={btn} style={btnStyle} disabled={busy || servers.length === 0} onClick={doRefresh}>
          {busy && refreshed === null ? "Working…" : "Connect & list tools"}
        </button>
      </div>

      {refreshed && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
          {refreshed.tools} tool{refreshed.tools === 1 ? "" : "s"} discovered from {refreshed.servers} server{refreshed.servers === 1 ? "" : "s"}
          {refreshed.failures.length > 0 ? ` — ${refreshed.failures.join("; ")}` : "."}
        </p>
      )}
      {error && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--danger, #e5484d)" }}>{error}</p>
      )}
    </Section>
  );
}

function ConfigDiagnosticsSection() {  const { bump } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  const doExport = async () => {
    setBusy("export");
    try {
      const json = await exportConfig();
      const ok = await copyText(json);
      setNote({
        ok,
        text: ok
          ? `Configuration copied to clipboard (${(json.length / 1024).toFixed(1)} KB). API keys are never included — only their references.`
          : "Copy failed — the export was generated but could not reach the clipboard.",
      });
    } catch (e) {
      setNote({ ok: false, text: `Export failed: ${(e as Error).message}` });
    } finally {
      setBusy(null);
      bump();
    }
  };

  const doImport = async () => {
    setBusy("import");
    try {
      const applied = await importConfig(importText);
      setNote({
        ok: true,
        text: `Imported ${applied.providers} provider(s) and ${applied.keys} key(s). Providers land as drafts and keys as invalid — re-enter each key and test before enabling.`,
      });
      setImportText("");
      setShowImport(false);
    } catch (e) {
      setNote({ ok: false, text: `Import rejected: ${(e as Error).message}` });
    } finally {
      setBusy(null);
      bump();
    }
  };

  const doDiagnostics = async () => {
    setBusy("diag");
    try {
      const bundle = await getDiagnosticsBundle();
      const ok = await copyText(bundle);
      setNote({
        ok,
        text: ok
          ? "Diagnostics bundle copied to clipboard — scrubbed (no request bodies, no headers, no secrets). Paste it into your bug report."
          : "Diagnostics bundle generated but the copy failed.",
      });
    } catch (e) {
      setNote({ ok: false, text: `Diagnostics failed: ${(e as Error).message}` });
    } finally {
      setBusy(null);
      bump();
    }
  };

  const btn = "rounded border px-3 py-1.5 text-[12px] disabled:opacity-50";
  const btnStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" };

  return (
    <Section
      title="Config & diagnostics"
      hint="Export moves your setup to another machine: providers, adapters, aliases and settings — never secret material. Import re-adds them as drafts; keys must be re-entered and tested before anything routes."
    >
      <div className="flex flex-wrap gap-2">
        <button className={btn} style={btnStyle} disabled={busy !== null} onClick={doExport}>
          {busy === "export" ? "Exporting…" : "Export config"}
        </button>
        <button
          className={btn}
          style={btnStyle}
          disabled={busy !== null}
          onClick={() => { setShowImport((v) => !v); setNote(null); }}
        >
          {showImport ? "Cancel import" : "Import config"}
        </button>
        <button className={btn} style={btnStyle} disabled={busy !== null} onClick={doDiagnostics}>
          {busy === "diag" ? "Collecting…" : "Copy diagnostics bundle"}
        </button>
      </div>

      {showImport && (
        <div className="mt-3">
          <textarea
            className="mono h-32 w-full rounded border p-2 text-[12px]"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            placeholder='Paste an exported config JSON here…'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className={`${btn} mt-2`}
            style={{ ...btnStyle, borderColor: "var(--accent, var(--border))" }}
            disabled={busy !== null || importText.trim().length === 0}
            onClick={doImport}
          >
            {busy === "import" ? "Importing…" : "Validate & import"}
          </button>
        </div>
      )}

      {note && (
        <p className="mt-3 text-[12px]" style={{ color: note.ok ? "var(--success)" : "var(--danger, #e5484d)" }}>
          {note.text}
        </p>
      )}
    </Section>
  );
}

function RotationRow({ provider, onChanged }: { provider: ProviderRecord; onChanged: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 text-[13px]">{provider.name}</span>
      <select
        className="rounded border px-2 py-1 text-[12px]"
        style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
        value={provider.rotationStrategy}
        onChange={async (e) => {
          await setProviderRotation(provider.id, e.target.value as ProviderRecord["rotationStrategy"]);
          onChanged();
        }}
      >
        {["round_robin", "lru", "priority", "cost_spread"].map((s) => (
          <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * The router-wide default model.
 *
 * Offers both id forms for the same reason the chat picker does — see
 * `lib/models/selectable.ts`. The default is what every unqualified request falls back to, so
 * pinning it to one provider here would make `failoverEnabled` inert for the whole app rather than
 * for one conversation.
 */
/**
 * The model that reads images for models that cannot see them (`lib/chat/vision.ts`).
 *
 * Listed by CAPABILITY, not modality: vision is not a modality here — the rows are text models that
 * happen to accept image input, which is why this is a separate picker rather than a third
 * `forModality` value. It offers every model that declares vision plus whatever id is already saved
 * (so a deliberate choice on a model that publishes nothing is not silently dropped by the UI).
 */
function VisionHelperPicker() {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const settings = router.settings as typeof router.settings & { defaults?: Record<string, string> };
  const value = settings.defaults?.vision ?? "";
  const options = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";
    return selectableModels(
      catalog.forModality("text").filter((m) => m.supportsVision === true),
      catalog.aliases,
      slugOf,
      isEnabled,
    );
  }, [tick]);
  return (
    <select
      className="mono w-full rounded border px-2 py-1 text-[12px]"
      style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
      value={value}
      onChange={(e) => {
        settings.defaults = { ...(settings.defaults ?? {}), vision: e.target.value };
        persistRouterSettings();
        bump();
      }}
      data-testid="vision-default"
    >
      {/* Short on purpose: the control shares its siblings' 254px width, and a native select clips
          a long option mid-word with no ellipsis (measured: "…that declar"). */}
      <option value="">auto — first with vision</option>
      {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function DefaultModelPicker({ modality }: { modality: "text" | "image" }) {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const settings = router.settings as typeof router.settings & { defaults?: Record<string, string> };
  const value = settings.defaults?.[modality] ?? "";
  const options = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";
    return selectableModels(catalog.forModality(modality), catalog.aliases, slugOf, isEnabled);
  }, [tick, modality]);
  return (
    <select
      className="mono w-full rounded border px-2 py-1 text-[12px]"
      style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
      value={value}
      onChange={(e) => {
        settings.defaults = { ...(settings.defaults ?? {}), [modality]: e.target.value };
        persistRouterSettings();
        bump();
      }}
    >
      <option value="">none</option>
      {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

/**
 * History retention — **manual and opt-in**, by design.
 *
 * The store had no retention for `session_messages` or the context graph, so both grew with every
 * conversation. Deleting a user's history on a timer is a policy the user has to see and choose,
 * not a background surprise: this section previews exactly what a prune would remove, requires a
 * second click to confirm, and defaults to "forever". Memories and the run ledger are not touched;
 * they have their own retention.
 */
function HistoryRetentionSection() {
  const [days, setDays] = useState(0);
  const [counts, setCounts] = useState<HistoryRetentionCounts | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pruned, setPruned] = useState<HistoryRetentionCounts | null>(null);

  useEffect(() => {
    void invoke<string | null>("settings_get", { key: "historyRetentionDays" })
      .then((raw) => {
        if (!raw) return;
        try {
          const n = Number(JSON.parse(raw));
          if (n === 90 || n === 180 || n === 365) setDays(n);
        } catch {
          // A malformed stored value reads as the safe default: forever.
        }
      })
      .catch(() => undefined);
  }, []);

  const choose = (n: number) => {
    setDays(n);
    setCounts(null);
    setConfirming(false);
    setPruned(null);
    setError(null);
    // Persisted on choice, so the next visit remembers the policy even before a prune.
    void invoke("settings_set", {
      key: "historyRetentionDays",
      valueJson: JSON.stringify(n),
    }).catch(() => undefined);
  };

  const preview = async () => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    setPruned(null);
    try {
      setCounts(await historyRetentionPreview(days));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prune = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const removed = await historyRetentionPrune(days);
      setPruned(removed);
      setCounts({ sessions: 0, messages: 0, nodes: 0, edges: 0 });
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="History retention"
      hint="Manual and opt-in. Pruning deletes sessions whose last activity is older than the chosen age — their transcript and context graph, not your memories or the run ledger. Nothing is deleted until you preview and confirm."
    >
      <div className="flex flex-col gap-3">
        <label
          className="flex flex-wrap items-center gap-2 text-[12px]"
          style={{ color: "var(--text-dim)" }}
        >
          Keep history for
          <select
            className="rounded border px-2 py-1 text-[12px]"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            value={days}
            disabled={busy}
            onChange={(e) => choose(Number(e.target.value))}
          >
            <option value={0}>forever (default)</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void preview()} disabled={busy || days === 0}>
            Preview what would go
          </Button>
          <Button
            variant="danger"
            onClick={() => void prune()}
            disabled={busy || days === 0 || !counts || counts.sessions === 0}
          >
            {confirming ? "Confirm prune" : "Prune now"}
          </Button>
        </div>

        {counts && (
          <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
            {counts.sessions} session{counts.sessions === 1 ? "" : "s"} ·{" "}
            {counts.messages} message{counts.messages === 1 ? "" : "s"} ·{" "}
            {counts.nodes} graph node{counts.nodes === 1 ? "" : "s"} ·{" "}
            {counts.edges} edge{counts.edges === 1 ? "" : "s"}
          </p>
        )}
        {confirming && (
          <p className="text-[12px]" style={{ color: "var(--warn)" }}>
            Click “Confirm prune” to delete these rows. This cannot be undone.
          </p>
        )}
        {pruned && (
          <p className="text-[12px]" style={{ color: "var(--success)" }}>
            Removed {pruned.sessions} session{pruned.sessions === 1 ? "" : "s"}, {pruned.messages}{" "}
            message{pruned.messages === 1 ? "" : "s"}, {pruned.nodes} graph node
            {pruned.nodes === 1 ? "" : "s"} and {pruned.edges} edge
            {pruned.edges === 1 ? "" : "s"}.
          </p>
        )}
        {error && <p className="text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
        {days === 0 && (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            Nothing is deleted while retention is set to forever.
          </p>
        )}
      </div>
    </Section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {hint && <p className="mb-3 mt-1 text-[12px]" style={{ color: "var(--text-dim)" }}>{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

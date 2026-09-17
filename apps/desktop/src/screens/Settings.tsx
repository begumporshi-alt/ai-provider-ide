/**
 * Router Settings (UI_UX_PLAN.md §5): sectioned — Routing / Reliability / System AI — no
 * mega-form. System AI gets the explanatory treatment (what it powers, why it's locked
 * until the first provider, §2.9 bootstrap guard). Phase 6 adds Config & diagnostics
 * (export/import without secrets, scrubbed bug-report bundle).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProviderRecord } from "@aiprovider/router";
import {
  catalog, clearAllCrashes, clearCrash, exportConfig, getCrashCount,
  getDiagnosticsBundle, importConfig, listCrashes, readCrash,
  persistRouterSettings, registry, router, setProviderRotation,
} from "../store";
import type { CrashReport } from "../store";
import { useUi } from "../ui-state";
import { StatusDot } from "../components/atoms";

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
  const [crashing, setCrashing] = useState<boolean>(false);

  const loadCrashInfo = async () => {
    const n = await getCrashCount();
    setCrashCount(n);
    if (n > 0 && expanded) {
      const ids = await listCrashes();
      const reports = (await Promise.all(ids.map((id) => readCrash(id))))
        .filter((r): r is CrashReport => r !== null);
      setCrashes(reports);
    }
  };

  useEffect(() => { void loadCrashInfo(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>Loading…</p>
          )}
        </div>
      )}

      <Section title="Routing">
        <Row label="Provider failover" hint="When every key of a provider fails, continue with the next provider that carries the model.">
          <Toggle checked={settings.failoverEnabled} onChange={(v) => { settings.failoverEnabled = v; persistRouterSettings(); bump(); }} />
        </Row>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {(["text", "image"] as const).map((mod) => (
            <label key={mod} className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Default {mod} model</span>
              <DefaultModelPicker modality={mod} />
            </label>
          ))}
        </div>
      </Section>

      <Section title="Reliability" hint="Timeouts: connect 10s · first byte 30s · idle stream 60s · max 6 attempts (§3.6). Editing budgets lands with the Phase 5 drift work — the defaults are live now.">
        <div className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>
          connect 10s · first-byte 30s · idle 60s · attempts 6 · jittered backoff honoring Retry-After
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

      <ConfigDiagnosticsSection />
    </div>
  );
}

function ConfigDiagnosticsSection() {
  const { bump } = useUi();
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
      hint="Export moves your setup to another machine: providers, adapters, aliases and settings — never keychain secrets. Import re-adds them as drafts; keys must be re-entered and tested before anything routes."
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

function DefaultModelPicker({ modality }: { modality: "text" | "image" }) {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const settings = router.settings as typeof router.settings & { defaults?: Record<string, string> };
  const value = settings.defaults?.[modality] ?? "";
  const options = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    return catalog.forModality(modality).map((m) => `${slugOf(m.providerId)}/${m.nativeId}`);
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
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
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

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>{hint}</div>
      </div>
      <div className="ml-auto">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-9 rounded-full border transition-colors"
      style={{ background: checked ? "var(--success)" : "var(--surface-2)", borderColor: checked ? "var(--success)" : "var(--border)" }}
    >
      <span
        className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all"
        style={{ left: checked ? "18px" : "2px" }}
      />
    </button>
  );
}

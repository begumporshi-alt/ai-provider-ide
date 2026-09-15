/**
 * Router Settings (UI_UX_PLAN.md §5): sectioned — Routing / Reliability / System AI — no
 * mega-form. System AI gets the explanatory treatment (what it powers, why it's locked
 * until the first provider, §2.9 bootstrap guard).
 */
import { useMemo, type ReactNode } from "react";
import type { ProviderRecord } from "@aiprovider/router";
import { catalog, persistRouterSettings, registry, router, setProviderRotation } from "../store";
import { useUi } from "../ui-state";
import { StatusDot } from "../components/atoms";

export function SettingsScreen() {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const providers = useMemo(() => registry.listProviders().filter((p) => p.status === "enabled"), [tick]);
  const ai = router.systemAiAvailable();
  const settings = router.settings;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-[20px] font-semibold">Router Settings</h1>

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
    </div>
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

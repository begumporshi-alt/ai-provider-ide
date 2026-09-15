/**
 * Activity — the request ledger first, analytics later (UI_UX_PLAN.md §4): dense table of
 * recent requests with source attribution (criterion 10), failures and fallback chains
 * visible (criterion 3). Session entries come from the live ledger; persisted rows load on
 * mount from the host.
 */
import { useEffect, useMemo, useState } from "react";
import { listLedger, loadRecentLedger, registry, type HostLedgerRow } from "../store";
import { useUi } from "../ui-state";
import { EmptyState } from "../components/atoms";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ActivityScreen() {
  const tick = useUi((s) => s.tick);
  const [persisted, setPersisted] = useState<HostLedgerRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    loadRecentLedger().then(setPersisted).catch(() => undefined);
  }, [tick]);

  const live = useMemo(() => listLedger(), [tick]);

  // Merge: live session entries (richer) take priority; persisted fills history.
  const rows = useMemo(() => {
    const fromLive = live.map((e) => ({
      ts: e.ts,
      modality: e.modality,
      source: e.source,
      provider: e.providerId ? registry.getProvider(e.providerId)?.name ?? e.providerId : "—",
      key: e.keyId ? registry.getKey(e.keyId)?.label ?? "—" : "—",
      model: e.model,
      requested: e.requestedModel,
      status: e.status,
      errorClass: e.errorClass ?? null,
      latencyMs: e.latencyMs ?? null,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      fallbacks: (e.fallbackChain ?? []).map((a) => `${registry.getProvider(a.candidate.provider.id)?.name ?? a.candidate.provider.slug} · ${a.candidate.key.label} → ${a.cls}`),
    }));
    const fromDisk = persisted
      .filter((p) => !live.some((l) => Math.abs(l.ts - p.ts) < 1000 && l.model === p.model))
      .map((p) => ({
        ts: p.ts,
        modality: p.modality as "text" | "image",
        source: p.source as "ui" | "gateway" | "generator",
        provider: p.providerId ? registry.getProvider(p.providerId)?.name ?? p.providerId : "—",
        key: p.keyId ? registry.getKey(p.keyId)?.label ?? "—" : "—",
        model: p.model,
        requested: p.requestedModel ?? p.model,
        status: p.status as "ok" | "error",
        errorClass: p.errorClass,
        latencyMs: p.latencyMs,
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
        fallbacks: (() => {
          try {
            const arr = JSON.parse(p.fallbackChainJson ?? "[]") as { provider: string; key: string; cls: string }[];
            return arr.map((a) => `${a.provider} · ${a.key} → ${a.cls}`);
          } catch {
            return [];
          }
        })(),
      }));
    return [...fromLive, ...fromDisk].sort((a, b) => b.ts - a.ts).slice(0, 300);
  }, [live, persisted]);

  const failures = rows.filter((r) => r.status !== "ok").length;
  const withFallback = rows.filter((r) => r.fallbacks.length > 0).length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Activity</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {rows.length} requests · {failures} failed · {withFallback} with fallback
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No requests yet. Try a model in the Playground — every routed request lands here, including which key served it." />
      ) : (
        <table className="w-full">
          <thead>
            <tr className="h-[30px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="w-20 font-medium">Time</th>
              <th className="font-medium">Model</th>
              <th className="w-32 font-medium">Provider</th>
              <th className="w-20 font-medium">Key</th>
              <th className="w-16 font-medium">Source</th>
              <th className="w-20 font-medium">Latency</th>
              <th className="w-24 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <>
                <tr key={i} className="h-[36px] cursor-pointer border-t hover:brightness-110" style={{ borderColor: "var(--border)" }} onClick={() => setOpen(open === i ? null : i)}>
                  <td className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>{fmtTime(r.ts)}</td>
                  <td className="mono text-[12px]">{r.model}</td>
                  <td className="text-[12px]">{r.provider}</td>
                  <td className="text-[12px]" style={{ color: "var(--text-dim)" }}>{r.key}</td>
                  <td><SourceChip source={r.source} /></td>
                  <td className="mono text-[12px]">{r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</td>
                  <td>
                    <span className="text-[12px]" style={{ color: r.status === "ok" ? (r.fallbacks.length ? "var(--warn)" : "var(--success)") : "var(--danger)" }}>
                      {r.status === "ok" ? (r.fallbacks.length ? `↻ ${r.fallbacks.length} fallback` : "✓ ok") : `✕ ${r.errorClass ?? "failed"}`}
                    </span>
                  </td>
                </tr>
                {open === i && (
                  <tr key={`${i}-detail`} className="border-t" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                    <td colSpan={7} className="px-3 py-2">
                      <div className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
                        <div>requested: {r.requested} → served: {r.model} ({r.modality})</div>
                        <div>tokens in/out: {r.tokensIn}/{r.tokensOut}{r.source === "generator" ? " · System AI request (§2.8 exclusion path)" : ""}</div>
                        {r.fallbacks.length > 0 && (
                          <div className="mt-1">
                            <div className="mb-0.5" style={{ color: "var(--warn)" }}>routing chain:</div>
                            {r.fallbacks.map((f, j) => <div key={j}>attempt {j + 1}: {f}</div>)}
                            <div>final: {r.provider} · {r.key} → ✓</div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Sources: <b>ui</b> = Playground · <b>gateway</b> = external apps via the Local Gateway (Phase 2b) · <b>generator</b> = System AI (Phase 4). Raw entries kept 90 days; monthly rollups kept indefinitely (§4).
      </p>
    </div>
  );
}

function SourceChip({ source }: { source: string }) {
  const color = source === "ui" ? "var(--text-dim)" : source === "gateway" ? "var(--info)" : "var(--ai)";
  return <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color }}>{source}</span>;
}

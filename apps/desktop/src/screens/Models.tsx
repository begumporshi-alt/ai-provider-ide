/**
 * Model Browser — IDE explorer, not marketplace (UI_UX_PLAN.md §2): Text/Image tabs, search,
 * provider filter, dense table. Defaults per modality live in router settings.
 */
import { useEffect, useMemo, useState } from "react";
import type { Modality } from "@aiprovider/adapter-spec";
import {
  catalog, registry, router, persistRouterSettings, refreshCatalog,
  workbuddyStatus, workbuddySetModels,
} from "../store";
import { useUi } from "../ui-state";
import { Button, EmptyState, StatusDot } from "../components/atoms";

export function ModelsScreen() {
  const tick = useUi((s) => s.tick);
  const { bump } = useUi();
  const [tab, setTab] = useState<Modality>("text");
  const [q, setQ] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  // Which models the gateway publishes into the connected client (WorkBuddy). Owned by the
  // host, because that is where the client's config file is written.
  const [published, setPublished] = useState<string[]>([]);
  const [clientPresent, setClientPresent] = useState(false);

  useEffect(() => {
    workbuddyStatus()
      .then((s) => {
        setPublished(s.published);
        setClientPresent(s.clientPresent);
      })
      .catch(() => undefined);
  }, [tick]);

  const togglePublish = async (nativeId: string) => {
    const next = published.includes(nativeId)
      ? published.filter((m) => m !== nativeId)
      : [...published, nativeId];
    const res = await workbuddySetModels(next).catch(() => null);
    // Trust the host's answer rather than the local guess — it dedupes and is the thing that
    // actually wrote the file.
    setPublished(res ? res.models : next);
    bump();
  };

  const rows = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    return catalog
      .forModality(tab)
      .filter((m) => providerFilter === "all" || m.providerId === providerFilter)
      .filter((m) => !q || m.nativeId.toLowerCase().includes(q.toLowerCase()) || slugOf(m.providerId).includes(q.toLowerCase()))
      .map((m) => ({ ...m, slug: slugOf(m.providerId) }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.nativeId.localeCompare(b.nativeId));
  }, [tick, tab, q, providerFilter]);

  const defaults = router.settings as typeof router.settings & { defaults?: Partial<Record<Modality, string>> };
  const defaultFor = defaults.defaults?.[tab] ?? "";
  const providers = useMemo(() => registry.listProviders(), [tick]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Model Browser</h1>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models…"
            className="w-48 rounded border px-2 py-1 text-[12px] outline-none"
            style={{ background: "var(--bg)", borderColor: "var(--border)" }}
          />
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="rounded border px-2 py-1 text-[12px]"
            style={{ background: "var(--bg)", borderColor: "var(--border)" }}
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-2 flex gap-1 border-b" style={{ borderColor: "var(--border)" }}>
        {(["text", "image"] as Modality[]).map((m) => (
          <button
            key={m}
            onClick={() => setTab(m)}
            className="px-3 py-1.5 text-[13px]"
            style={{
              color: tab === m ? "var(--text)" : "var(--text-dim)",
              borderBottom: tab === m ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {m === "text" ? "Text Models" : "Image Models"}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={providers.length ? "No models discovered yet — press Refresh on a provider, or add a key and test it." : "No models yet — connect a provider to populate your catalog."}
        />
      ) : (
        <table className="w-full">
          <thead>
            <tr className="h-[30px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="font-medium">Model</th>
              <th className="w-40 font-medium">Provider</th>
              <th className="w-24 font-medium">Default</th>
              <th className="w-20 font-medium">Client</th>
              <th className="w-24" />
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={`${m.providerId}:${m.nativeId}`} className="h-[38px] border-t" style={{ borderColor: "var(--border)" }}>
                <td className="mono text-[12px]">{m.slug}/{m.nativeId}</td>
                <td className="text-[12px]" style={{ color: "var(--text-dim)" }}>{registry.getProvider(m.providerId)?.name}</td>
                <td>
                  {defaultFor === `${m.slug}/${m.nativeId}` && (
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>default</span>
                  )}
                </td>
                <td>
                  {published.includes(m.nativeId) && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
                      title={clientPresent ? "Published to the connected client" : "Client config not found yet"}
                    >
                      exposed
                    </span>
                  )}
                </td>
                <td className="text-right">
                  <Button onClick={() => void togglePublish(m.nativeId)}>
                    {published.includes(m.nativeId) ? "Unexpose" : "Expose"}
                  </Button>
                </td>
                <td className="text-right">
                  <Button
                    onClick={() => {
                      defaults.defaults = { ...(defaults.defaults ?? {}), [tab]: `${m.slug}/${m.nativeId}` };
                      persistRouterSettings();
                      bump();
                    }}
                  >
                    Set default
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4 flex items-center gap-2">
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {rows.length} {tab} models
        </span>
        <div className="ml-auto flex gap-2">
          {providers.filter((p) => p.status === "enabled").map((p) => (
            <Button key={p.id} onClick={async () => { await refreshCatalog(p.id).catch(() => undefined); bump(); }}>
              Refresh {p.name}
            </Button>
          ))}
        </div>
      </div>
      {providers.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
          <StatusDot health="healthy" /> Aliases: identical native IDs across providers resolve by bare name with provider failover (§3.4).
        </p>
      )}
      <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
        {clientPresent
          ? `Exposed models are published to the connected client (${published.length} published). Capabilities and token limits come from the catalog, so they stay correct without hand-editing.`
          : "Expose a model to publish it to a connected client. Its config will be created the first time the gateway starts with something published."}
      </p>
    </div>
  );
}

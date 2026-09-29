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
import { bareEntry, hasFailoverCarrier } from "../lib/models/selectable";
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
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    workbuddyStatus()
      .then((s) => {
        setPublished(s.published);
        setClientPresent(s.clientPresent);
      })
      .catch(() => undefined);
  }, [tick]);

  /**
   * Expose/unexpose one model, adopting **only** the host's answer.
   *
   * This used to be `workbuddySetModels(next).catch(() => null)` followed by
   * `setPublished(res ? res.models : next)`. On failure that fell back to the local guess, so the
   * toggle rendered as applied while the client's config file had not been written — a swallowed
   * write presented as success, invisible to every reader. The host dedupes and is the thing that
   * actually writes the file, so its answer is the only authority; a failure is surfaced instead of
   * being rendered as a change.
   */
  const togglePublish = async (nativeId: string) => {
    const next = published.includes(nativeId)
      ? published.filter((m) => m !== nativeId)
      : [...published, nativeId];
    try {
      const res = await workbuddySetModels(next);
      setPublished(res.models);
      setPublishError(null);
    } catch (e) {
      setPublishError(
        `Could not update the client's model list — nothing was written. ${String(e)}`,
      );
    }
    bump();
  };

  /**
   * The catalog rows for this modality, **before** the search box and the provider filter.
   *
   * The failover question is a property of the whole catalog, so it must not be answered from
   * `rows`: filtering to one provider would hide the second carrier and the marker would vanish
   * with it, which is exactly the fact the operator is looking for.
   */
  const modalityRows = useMemo(() => {
    void tick;
    return catalog.forModality(tab);
  }, [tick, tab]);

  const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";

  /**
   * The router-chosen option for a native id, or `null` when a qualified id is the only form.
   *
   * Read by the marker, the badge and the Default button, so all three agree on one id — and it is
   * the same function the chat and settings pickers use, rather than a restatement of its rule.
   * `catalog.aliases` matters: an alias can narrow a bare id to one provider, so the marker's word
   * and the button's id must come from one answer.
   */
  const bareFor = (nativeId: string) =>
    bareEntry(modalityRows, catalog.aliases, nativeId, isEnabled, (pid) => registry.getProvider(pid)?.slug ?? pid);

  const rows = useMemo(() => {
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    return modalityRows
      .filter((m) => providerFilter === "all" || m.providerId === providerFilter)
      .filter((m) => !q || m.nativeId.toLowerCase().includes(q.toLowerCase()) || slugOf(m.providerId).includes(q.toLowerCase()))
      .map((m) => ({ ...m, slug: slugOf(m.providerId) }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.nativeId.localeCompare(b.nativeId))
      // Resolved once per row rather than repeatedly in the JSX, so the marker, the badge and the
      // button cannot read three different answers inside one render.
      .map((m) => ({
        ...m,
        bare: bareFor(m.nativeId),
        failover: hasFailoverCarrier(modalityRows, catalog.aliases, m.nativeId, isEnabled),
      }));
    // `tick` is a real input here, not decoration: `bareFor` reads `catalog.aliases` and provider
    // status, and neither is captured by the identity of `modalityRows`.
  }, [modalityRows, q, providerFilter, tick]);

  /**
   * The id a row's Default button writes, and the id the "default" badge matches.
   *
   * **One function, read twice.** The badge and the button must name the same string, or the badge
   * can never light up for a row whose button writes the bare form — two spellings of one id is how
   * they drift. And it must be an id the pickers actually offer, or Settings would render the
   * stored default as an unlisted fallback option: hence `bareEntry` rather than a second rule.
   */
  const defaultIdFor = (m: { slug: string; nativeId: string; bare: { id: string } | null }) =>
    m.bare?.id ?? `${m.slug}/${m.nativeId}`;

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
                <td className="mono text-[12px]">
                  {m.slug}/{m.nativeId}
                  {m.bare && (
                    <span
                      className="ml-2 rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
                      title={
                        m.failover
                          ? "Another enabled provider also serves this model, so its default is the bare id and the router can fail over to it."
                          : `The router routes this model to one provider (${m.bare.label}), so its default is the bare id rather than a pinned provider.`
                      }
                    >
                      {m.failover ? "failover" : "routed"}
                    </span>
                  )}
                </td>
                <td className="text-[12px]" style={{ color: "var(--text-dim)" }}>{registry.getProvider(m.providerId)?.name}</td>
                <td>
                  {defaultFor === defaultIdFor(m) && (
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
                      defaults.defaults = { ...(defaults.defaults ?? {}), [tab]: defaultIdFor(m) };
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
      {publishError && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }} role="alert">
          {publishError}
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

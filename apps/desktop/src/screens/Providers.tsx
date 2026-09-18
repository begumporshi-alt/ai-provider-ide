/**
 * Providers screen (home). Mirrors the sketch: provider cards, key rows underneath, full key
 * lifecycle (add / test / enable-disable / remove) and a first-run hero. Acceptance
 * criterion 1: "add all three drawn providers, each with 3 keys, see them as cards."
 *
 * Honest interim add-flow (UI_UX_PLAN): the 3 known providers + a custom form with a
 * "the auto-wizard arrives in Phase 3" note — never fake the wizard.
 */
import { useEffect, useMemo, useState } from "react";
import { PROVIDER_PROFILES, type AdapterManifest } from "@aiprovider/router-core";
import {
  addKey, addProvider, approveRepair, buildRepairPlan, deleteKey, deleteProvider, listManifestHistory,
  pendingRepairs, registry, rollbackManifest, setKeyStatus, setProviderStatus, testKey, refreshCatalog,
} from "../store";
import type { HostManifestRow } from "../store";
import { useUi } from "../ui-state";
import {
  Button, Field, KeyFingerprint, Modal, StatusBadge, StatusDot, healthOf, inputCls, inputStyle,
} from "../components/atoms";

const KNOWN = Object.keys(PROVIDER_PROFILES); // openrouter | opencode | b.ai

export function ProvidersScreen() {
  const { bump } = useUi();
  const tick = useUi((s) => s.tick);
  const providers = useMemo(() => registry.listProviders(), [tick]);
  const keyCount = providers.reduce((n, p) => n + registry.keysOf(p.id).length, 0);
  const [adding, setAdding] = useState(false);
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "provider" | "key"; id: string; name: string } | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold">AI Providers</h1>
          {providers.length > 0 && (
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
              {providers.length} provider{providers.length === 1 ? "" : "s"} · {keyCount} keys
            </p>
          )}
        </div>
        {providers.length > 0 && <Button variant="primary" onClick={() => setAdding(true)}>+ Add Provider</Button>}
      </div>

      {providers.length === 0 ? (
        <FirstRunHero onAdd={() => setAdding(true)} />
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((p) => {
            const keys = registry.keysOf(p.id);
            const health = healthOf(p);
            return (
              <section
                key={p.id}
                className="rounded-md border p-3"
                style={{ background: "var(--surface)", borderColor: "var(--border)" }}
              >
                <header className="mb-2 flex items-center gap-2">
                  <StatusDot health={health} />
                  <span className="text-[14px] font-semibold">{p.name}</span>
                  <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{p.baseUrl}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                      <input
                        type="checkbox"
                        checked={p.status === "enabled"}
                        onChange={async (e) => {
                          await setProviderStatus(p.id, e.target.checked ? "enabled" : "disabled");
                          if (e.target.checked) refreshCatalog(p.id).catch(() => undefined);
                          bump();
                        }}
                      />
                      Enabled
                    </label>
                    {p.status === "repairing" && (
                      <Button variant="primary" onClick={() => setRepairing(p.id)}>
                        {pendingRepairs.has(p.id) ? "Review repair…" : "Repair…"}
                      </Button>
                    )}
                    {p.status !== "repairing" && p.status !== "draft" && (
                      <Button variant="ghost" onClick={() => void buildRepairPlan({
                        providerId: p.id, providerSlug: p.slug,
                        errors: 0, models: [], windowMs: 0, detectedAt: Date.now(),
                      }).then(() => { setRepairing(p.id); bump(); })}>
                        Check health
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setConfirmDelete({ kind: "provider", id: p.id, name: p.name })}>
                      Remove
                    </Button>
                  </div>
                </header>
                {p.status === "repairing" && (
                  <p className="mb-2 text-[12px]" style={{ color: "var(--warn)" }}>
                    Drift suspected — requests still route here, but failover is covering. {pendingRepairs.has(p.id) ? "A repair plan is ready to review." : "Building a repair plan…"}
                  </p>
                )}
                <table className="w-full">
                  <tbody>
                    {keys.map((k) => {
                      const kh = healthOf(k);
                      return (
                        <tr key={k.id} className="h-[38px] border-t" style={{ borderColor: "var(--border)" }}>
                          <td className="w-6"><StatusDot health={kh} /></td>
                          <td className="text-[13px]">{k.label}</td>
                          <td className="w-[120px]"><KeyFingerprint hint={k.secretHint} /></td>
                          <td className="w-[110px]"><StatusBadge health={kh} /></td>
                          <td className="w-[140px] text-right">
                            <Button
                              onClick={async () => {
                                setTesting(k.id);
                                try {
                                  const r = await testKey(k.id);
                                  setNotice(`${k.label}: ${r.ok ? "valid" : r.rateLimited ? "rate-limited" : `invalid${r.status ? ` (HTTP ${r.status})` : ""} — ${r.message ?? "unknown error"}`}`);
                                  if (r.ok) await refreshCatalog(p.id).catch(() => undefined);
                                } catch (e) {
                                  setNotice(`${k.label}: ${(e as Error).message}`);
                                }
                                setTesting(null);
                                bump();
                              }}
                              disabled={testing === k.id}
                            >
                              {testing === k.id ? "Testing…" : "Test"}
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={async () => {
                                await setKeyStatus(k.id, k.status === "disabled" ? "active" : "disabled");
                                bump();
                              }}
                            >
                              {k.status === "disabled" ? "Enable" : "Disable"}
                            </Button>
                            <Button variant="ghost" onClick={() => setConfirmDelete({ kind: "key", id: k.id, name: k.label })}>
                              ✕
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="mt-2">
                  <Button variant="ghost" onClick={() => setAddingKeyFor(p.id)}>+ Add key</Button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <NoticeBar />
      {repairing && <RepairModal providerId={repairing} onClose={() => { setRepairing(null); bump(); }} />}
      {adding && <AddProviderModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); bump(); }} />}
      {addingKeyFor && (
        <AddKeyModal
          providerName={registry.getProvider(addingKeyFor)?.name ?? ""}
          onClose={() => setAddingKeyFor(null)}
          onDone={() => { setAddingKeyFor(null); bump(); }}
          onSubmit={async (label, secret) => {
            await addKey(addingKeyFor, label, secret);
            refreshCatalog(addingKeyFor).catch(() => undefined);
          }}
        />
      )}
      {confirmDelete && (
        <Modal title={confirmDelete.kind === "provider" ? `Remove ${confirmDelete.name}?` : `Remove ${confirmDelete.name}?`} onClose={() => setConfirmDelete(null)}>
          <p className="mb-4 text-[13px]" style={{ color: "var(--text-dim)" }}>
            {confirmDelete.kind === "provider"
              ? "Removes the provider, its keys (including their keychain entries), manifests, and catalog rows. Activity history is preserved."
              : "The keychain entry is deleted in the same operation."}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (confirmDelete.kind === "provider") await deleteProvider(confirmDelete.id);
                else await deleteKey(confirmDelete.id);
                setConfirmDelete(null);
                bump();
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
      <TryInPlayground />
    </div>
  );
}

function FirstRunHero({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-md border p-8 text-center" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <h2 className="text-[18px] font-semibold">Connect your first provider</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px]" style={{ color: "var(--text-dim)" }}>
        OpenRouter, OpenCode Zen and b.ai live in about two minutes. Keys are stored in your OS
        keychain — this app never writes them to disk, and nothing leaves your machine except
        requests to the providers you configure.
      </p>
      <div className="mt-5 flex justify-center">
        <Button variant="primary" onClick={onAdd}>Add Provider</Button>
      </div>
    </div>
  );
}

function AddProviderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addKnown(s: string) {
    setBusy(true);
    try {
      const manifest = PROVIDER_PROFILES[s]!() as AdapterManifest;
      await addProvider({
        slug: s,
        name: { openrouter: "OpenRouter", opencode: "OpenCode Zen", "b.ai": "b.ai" }[s] ?? s,
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

  return (
    <Modal title="Add Provider" onClose={onClose}>
      <>
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
                  {{ openrouter: "OpenRouter", opencode: "OpenCode Zen", "b.ai": "b.ai" }[s]}
                </span>
                <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                  {PROVIDER_PROFILES[s]!().provider.baseUrl}
                </span>
              </button>
            ))}
          </div>
          <button
            className="flex w-full items-center justify-between rounded border px-3 py-2 text-left hover:brightness-110"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
            onClick={() => {
              onClose();
              useUi.getState().go("onboarding");
            }}
          >
            <span className="text-[13px] font-medium">Any other provider — guided setup</span>
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>probe → identify → test → enable</span>
          </button>
      </>
      {error && <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
      {busy && <p className="mt-2 text-[12px]" style={{ color: "var(--text-dim)" }}>Registering…</p>}
    </Modal>
  );
}

function AddKeyModal({
  providerName, onClose, onDone, onSubmit,
}: {
  providerName: string; onClose: () => void; onDone: () => void;
  onSubmit: (label: string, secret: string) => Promise<void>;
}) {
  const [label, setLabel] = useState("key-01");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Add key — ${providerName}`} onClose={onClose}>
      <Field label="Label">
        <input className={inputCls} style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="API key (stored in your OS keychain)">
        <input className={`${inputCls} mono`} type="password" style={inputStyle} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="sk-…" autoFocus />
      </Field>
      {error && <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy || !secret.trim() || !label.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSubmit(label.trim(), secret.trim());
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Storing…" : "Add key"}
        </Button>
      </div>
    </Modal>
  );
}

function TryInPlayground() {
  const { go } = useUi();
  const providers = registry.listProviders().filter((p) => p.status === "enabled");
  if (!providers.length) return null;
  return (
    <div className="mt-4 text-[12px]" style={{ color: "var(--text-dim)" }}>
      Router live. <button className="underline decoration-dotted" onClick={() => go("playground")}>Try a model</button>
    </div>
  );
}

/* tiny notice channel without a toast system (EventToast is later phases) */
let noticeListener: ((s: string) => void) | null = null;
function setNotice(s: string) {
  noticeListener?.(s);
}
function NoticeBar() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    noticeListener = (s) => {
      setMsg(s);
      window.setTimeout(() => setMsg((cur) => (cur === s ? null : cur)), 5000);
    };
    return () => {
      noticeListener = null;
    };
  }, []);
  if (!msg) return null;
  return (
    <div className="fixed bottom-4 right-4 rounded border px-3 py-2 text-[12px] shadow-lg" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
      {msg}
    </div>
  );
}


function RepairModal({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const tick = useUi((s) => s.tick);
  void tick;
  const entry = pendingRepairs.get(providerId);
  const provider = registry.getProvider(providerId);
  const [history, setHistory] = useState<HostManifestRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    listManifestHistory(providerId).then(setHistory).catch(() => setHistory([]));
  }, [providerId]);
  if (!provider) return null;
  const plan = entry?.plan;
  const checks = plan?.candidate?.contract?.checks ?? [];
  return (
    <Modal title={`Repair — ${provider.name}`} onClose={onClose}>
      {entry?.error && <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>{entry.error}</p>}
      {!entry && <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>No drift event recorded.</p>}
      {entry && (
        <>
          <div className="mb-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Evidence</div>
            <ul className="list-disc pl-5 text-[12px]" style={{ color: "var(--text-dim)" }}>
              {plan
                ? plan.evidence.map((e, i) => <li key={i}>{e}</li>)
                : [`${entry.evidence.errors} drift-class errors across ${entry.evidence.models.length} models in the last 15 min`]}
            </ul>
          </div>
          {checks.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Contract checks (proposed adapter)</div>
              {checks.map((c, i) => (
                <div key={i} className="text-[12px]">
                  <span style={{ color: c.pass ? "var(--success)" : "var(--danger)" }}>{c.pass ? "✓" : "✕"}</span> {c.name}
                  {c.detail && <span style={{ color: "var(--text-faint)" }}> — {c.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {plan?.status === "planned" && (
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={async () => {
                setBusy(true);
                const r = await approveRepair(providerId).catch((e) => { setMsg(String((e as Error).message)); return undefined; });
                setBusy(false);
                if (r) { setMsg(`Repaired — adapter v${r.version}${r.previous ? ` (previous v${r.previous} kept for rollback)` : ""}`); window.setTimeout(onClose, 1200); }
              }}>
                Approve & apply
              </Button>
              <Button variant="danger" onClick={async () => { setBusy(true); await setProviderStatus(providerId, "enabled"); setBusy(false); onClose(); }}>
                Keep current adapter
              </Button>
            </div>
          )}
          {plan && plan.status !== "planned" && (
            <p className="text-[12px]" style={{ color: "var(--warn)" }}>
              {plan.status === "no_ai_available"
                ? "Automated patch unavailable — add another healthy provider so the AI has a model to run on, or edit the adapter after the Phase-6 sandbox."
                : "No repair candidate passed the contract checks. Re-run checks later; requests keep routing via failover."}
            </p>
          )}
        </>
      )}
      {history && history.length > 1 && (
        <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <div className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Adapter history</div>
          {history.map((h) => (
            <div key={h.version} className="flex items-center gap-2 text-[12px]">
              <span className="mono">v{h.version}</span>
              <span style={{ color: "var(--text-dim)" }}>{h.origin}</span>
              {h.isActive ? <span className="rounded px-1 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--success)" }}>active</span> : (
                <button className="text-[11px] underline decoration-dotted" style={{ color: "var(--text-dim)" }} onClick={async () => {
                  await rollbackManifest(providerId, h.version);
                  setMsg(`Rolled back to v${h.version}`);
                }}>
                  roll back to this
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && <p className="mt-2 text-[12px]" style={{ color: "var(--success)" }}>{msg}</p>}
    </Modal>
  );
}
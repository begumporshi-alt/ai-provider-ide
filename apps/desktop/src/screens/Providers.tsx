/**
 * Providers screen (home). Mirrors the sketch: provider cards, key rows underneath, full key
 * lifecycle (add / test / enable-disable / remove) and a first-run hero. Acceptance
 * criterion 1: "add all three drawn providers, each with 3 keys, see them as cards."
 *
 * Honest interim add-flow (UI_UX_PLAN): the 3 known providers + a custom form with a
 * "the auto-wizard arrives in Phase 3" note — never fake the wizard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDER_PROFILES, type AdapterManifest } from "@aiprovider/router-core";
import {
  addKey, addProvider, approveRepair, buildRepairPlan, deleteKey, deleteProvider, driftEventsList,
  generatorAuditList, listManifestHistory, pendingRepairs, registry, rollbackManifest, setKeyStatus,
  setProviderStatus, testKey, refreshCatalog, uniqueSlug,
} from "../store";
import type { DriftEventEntry, GeneratorAuditEntry, HostManifestRow } from "../store";
import { useUi } from "../ui-state";
import {
  Button, Field, KeyFingerprint, Modal, StatusBadge, StatusDot, healthOf, inputCls, inputStyle,
} from "../components/atoms";
import { TrailWriteWarning } from "../components/TrailWriteWarning";
import { verdictNotice } from "../lib/keys/verdict";
import { clock, dayKey } from "../lib/memory/timeline";

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
            // In-memory and per session, so an absent entry does NOT mean "still building" — after a
            // restart nothing is building at all. See `buildRepairPlan`: it now registers the entry
            // before anything can fail, so an entry is the signal that this session started one.
            const repair = pendingRepairs.get(p.id);
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
                        {repair?.plan ? "Review repair…" : "Repair…"}
                      </Button>
                    )}
                    {/* Offered for `repairing` too — it is the only way out. `pendingRepairs` is
                        in-memory, so a provider still `repairing` after a restart has no entry and
                        no plan, and until now also had no button that could start one. */}
                    {p.status !== "draft" && (
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
                    Drift suspected — requests still route here, but failover is covering.{" "}
                    {repair?.plan
                      ? "A repair plan is ready to review."
                      : repair?.error
                        ? `The repair could not be built — ${repair.error}`
                        : repair
                          ? "Building a repair plan…"
                          : "No repair is running in this session — use Check health to rebuild one."}
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
                                  setNotice(verdictNotice(k.label, r));
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

      <GenerationAuditCard />

      <DriftHistoryCard />

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
      <TryInAssistant />
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
  const [mode, setMode] = useState<"known" | "manual">("known");

  // Manual mode fields
  const [manualName, setManualName] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualAuth, setManualAuth] = useState<"bearer" | "x-api-key" | "custom">("bearer");
  const [manualAuthHeader, setManualAuthHeader] = useState("Authorization");
  const [manualAuthPrefix, setManualAuthPrefix] = useState("Bearer");
  const [manualDialect, setManualDialect] = useState("openai-chat-v1");

  function buildManifest(): AdapterManifest {
    const authHeader = manualAuth === "x-api-key"
      ? { name: "x-api-key" }
      : manualAuth === "custom"
        ? { name: manualAuthHeader, prefix: manualAuthPrefix || undefined }
        : { name: "Authorization", prefix: "Bearer" };

    return {
      manifestVersion: 1,
      kind: "declarative",
      dialect: manualDialect,
      provider: { baseUrl: manualUrl.trim(), auth: { headers: [authHeader] } },
      endpoints: {
        listModels: { method: "GET", path: "/models", map: { models: "$.data[*].id", raw: "$.data[*]" } },
        generateText: {
          method: "POST",
          path: "/chat/completions",
          requestTemplate: {
            model: "{{model}}",
            messages: "{{messages}}",
            stream: "{{stream}}",
            max_tokens: "{{maxTokens?}}",
            temperature: "{{temperature?}}",
            tools: "{{tools?}}",
            tool_choice: "{{toolChoice?}}",
            response_format: "{{responseFormat?}}",
          },
          responseMap: { text: "$.choices[0].message.content", usage: "$.usage" },
          stream: {
            protocol: "sse",
            chunkMap: { delta: "$.choices[0].delta.content" },
            errorMap: { "$.error": "PASS_THROUGH" },
            finish: "$.choices[0].finish_reason",
            requestUsage: true,
          },
        },
      },
      capabilities: { text: true, image: false },
      provenance: { origin: "user-edited", generatorModel: null, createdAt: new Date().toISOString() },
    };
  }

  const manualValid =
    mode === "manual" &&
    manualName.trim().length > 1 &&
    /^https?:\/\//.test(manualUrl.trim()) &&
    (manualAuth !== "custom" || (manualAuthHeader.trim().length > 0));

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

  async function addManual() {
    if (!manualValid) return;
    setBusy(true);
    setError(null);
    try {
      const manifest = buildManifest();
      const slug = uniqueSlug(manualName.trim());
      await addProvider({
        slug,
        name: manualName.trim(),
        type: "manifest",
        baseUrl: manualUrl.trim(),
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
      <div className="mb-3 flex gap-1 rounded border p-1" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        {(["known", "manual"] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setError(null); }}
            className={`flex-1 rounded px-3 py-1 text-[12px] font-medium transition-colors ${
              mode === m ? "text-white" : "text-inherit"
            }`}
            style={mode === m ? { background: "var(--accent)", color: "white" } : {}}
          >
            {m === "known" ? "Quick add" : "Manual"}
          </button>
        ))}
      </div>

      {mode === "known" ? (
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
      ) : (
        <div className="mb-3 space-y-3">
          <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
            Add any OpenAI- or Anthropic-compatible provider. The adapter manifest is generated automatically.
          </p>
          <Field label="Name">
            <input className={inputCls} style={inputStyle} value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="My Provider" autoFocus />
          </Field>
          <Field label="Base URL">
            <input className={`${inputCls} mono`} style={inputStyle} value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="https://api.example.com" />
          </Field>
          <Field label="Auth type">
            <select className={inputCls} style={inputStyle} value={manualAuth} onChange={(e) => setManualAuth(e.target.value as any)}>
              <option value="bearer">Bearer token (Authorization: Bearer …)</option>
              <option value="x-api-key">x-api-key header</option>
              <option value="custom">Custom header</option>
            </select>
          </Field>
          {manualAuth === "custom" && (
            <>
              <Field label="Header name">
                <input className={inputCls} style={inputStyle} value={manualAuthHeader} onChange={(e) => setManualAuthHeader(e.target.value)} placeholder="X-Custom-Auth" />
              </Field>
              <Field label="Prefix (optional)">
                <input className={inputCls} style={inputStyle} value={manualAuthPrefix} onChange={(e) => setManualAuthPrefix(e.target.value)} placeholder="e.g. Token" />
              </Field>
            </>
          )}
          <Field label="Dialect">
            <select className={inputCls} style={inputStyle} value={manualDialect} onChange={(e) => setManualDialect(e.target.value)}>
              <option value="openai-chat-v1">openai-chat-v1</option>
              <option value="anthropic-messages-v1">anthropic-messages-v1</option>
            </select>
          </Field>
        </div>
      )}

      {mode === "manual" && (
        <div className="mt-3">
          <Button variant="primary" disabled={!manualValid || busy} onClick={addManual}>
            {busy ? "Adding…" : "Add provider"}
          </Button>
        </div>
      )}

      {mode === "known" && (
        <button
          className="mt-2 flex w-full items-center justify-between rounded border px-3 py-2 text-left hover:brightness-110"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
          onClick={() => {
            onClose();
            useUi.getState().go("onboarding");
          }}
        >
          <span className="text-[13px] font-medium">Any other provider — guided setup</span>
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>probe → identify → test → enable</span>
        </button>
      )}

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

function TryInAssistant() {
  const { go } = useUi();
  const providers = registry.listProviders().filter((p) => p.status === "enabled");
  if (!providers.length) return null;
  return (
    <div className="mt-4 text-[12px]" style={{ color: "var(--text-dim)" }}>
      Router live. <button className="underline decoration-dotted" onClick={() => go("assistant")}>Try a model</button>
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
                if (r) {
                  // The repair is live either way; what is in doubt is whether the trail records it.
                  // Said here because this is the only moment the operator can learn it — the drift
                  // card below shows the row as still Open, which is also exactly what *declining* a
                  // repair looks like, so on its own it cannot distinguish the two.
                  const closed = r.resolveRecorded ? "" : " · its drift event could not be closed";
                  setMsg(`Repaired — adapter v${r.version}${r.previous ? ` (previous v${r.previous} kept for rollback)` : ""}${closed}`);
                  window.setTimeout(onClose, 1200);
                }
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
/**
 * The AI generation audit — the trail of adapters the assistant wrote for us.
 *
 * Two producers write it: the onboarding wizard's candidate generation, and drift repair. Both are
 * adapter work, which is why the reader lives on this screen rather than Control → Tools — that tab is
 * about the gateway's tool registry, and an AI-authored adapter is not a tool. It is a page-level card
 * rather than a panel inside a provider because the rows carry **no provider id**: the schema has a
 * `session_id` column but `generator_audit_record`'s INSERT omits it, so there is nothing to filter on
 * and a per-provider panel would have to invent an attribution the host never recorded.
 *
 * Rendered whether or not any provider exists. Hiding a record because the thing it describes was
 * deleted is the failure this trail exists to prevent — the same "evidence nobody can consult" problem
 * the gateway log had.
 *
 * Read on mount, unlike Control's gateway-log reader, which waits for a disclosure. Control is built as
 * layer-1 summary plus layer-2 detail, so a card there can be layer 2; this screen is flat, so a card
 * here is layer 1 by construction, and layer 1 is what has to be visible without a click.
 */
function GenerationAuditCard() {
  const tick = useUi((s) => s.tick);
  const [rows, setRows] = useState<GeneratorAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * The newest read wins, and a superseded one writes nothing.
   *
   * Two reads can be in flight at once — the effect fires on mount and again on every `tick`, and a
   * Refresh click adds another. Without this, an older read that *rejects* after a newer one has
   * resolved leaves the error from the failed read sitting next to the rows from the successful one:
   * a state that never existed, where the card shows a failure notice above fresh data. It was found
   * by a browser spec failing on exactly that pair.
   *
   * Because only the newest read writes, `rows` and `error` always come from the same read — a read
   * either answers with data and clears the error, or clears the rows and sets one. That invariant is
   * what lets the empty branch below test `rows` alone.
   */
  const gen = useRef(0);
  const load = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    try {
      const next = await generatorAuditList(50);
      if (mine !== gen.current) return; // superseded — a newer read owns the state now
      setRows(next);
      setError(null);
    } catch (e) {
      if (mine !== gen.current) return;
      // Clear rather than keep the previous rows. A stale trail under a failure notice is a claim
      // about *now*, and this is the one card that must not claim a row is current when the read that
      // would have shown it is the read that failed.
      setRows(null);
      setError(String(e));
    } finally {
      // Only the read that still owns the state may clear the spinner; otherwise a superseded read
      // finishing first would report "not loading" while the newer one is still in flight.
      if (mine === gen.current) setLoading(false);
    }
  }, []);

  /**
   * Re-read on `tick` as well as on mount.
   *
   * This screen is where a row is *created* — approving a repair writes one and bumps the tick. A
   * mount-only read would leave the operator looking at a trail that does not contain the generation
   * they just approved, on the very screen they approved it from. Control's gateway-log card does not
   * need this: it sits behind a disclosure, so opening it is already the request.
   *
   * It is not a poll. `tick` moves on user actions alone (`ui-state.ts`), so this costs one indexed
   * read per action rather than one per interval.
   */
  useEffect(() => {
    void load();
  }, [load, tick]);

  return (
    <section
      className="mt-3 rounded-md border p-3"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          AI generation audit
        </span>
        {rows !== null && rows.length > 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            {rows.length} recorded · newest first
          </span>
        )}
        <Button variant="ghost" ariaLabel="Refresh generation audit" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </Button>
      </div>

      <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Every adapter the assistant wrote — for the wizard&apos;s candidate generation and for a drift
        repair. Token counts are <b>estimates</b> (characters ÷ 4), not tokenizer counts. The hash covers
        the redacted prompt, so the trail is not the leak it exists to catch.
      </p>

      <TrailWriteWarning trail="generator_audit" />

      {error !== null && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
        >
          Could not read the trail: {error}
        </div>
      )}

      {/* A loaded-but-empty trail is a fact about this machine, not a failure of the card, so it gets
          its own sentence. No `error === null` test is needed here: `load` lets only the newest read
          write, so an empty `rows` and a set `error` cannot coexist — see the invariant on `gen`. */}
      {rows !== null && rows.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          Nothing recorded yet. Rows appear when the assistant writes an adapter — so an empty trail
          means it has not, not that this failed to load.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="w-full" aria-label="AI generation audit">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="text-left font-normal">When</th>
              <th className="text-left font-normal">Model</th>
              <th className="text-right font-normal">Prompt ≈</th>
              <th className="text-right font-normal">Reply ≈</th>
              <th className="text-left font-normal">Redaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t text-[12px]" style={{ borderColor: "var(--border)" }}>
                <td className="mono whitespace-nowrap py-1" title={new Date(r.tsMs).toLocaleString()}>
                  {dayKey(r.tsMs)} {clock(r.tsMs)}
                </td>
                <td className="mono py-1">{r.modelUsed}</td>
                <td className="mono py-1 text-right">{r.promptTokens}</td>
                <td className="mono py-1 text-right">{r.completionTokens}</td>
                <td className="mono py-1" style={{ color: "var(--text-faint)" }}>
                  {/* Truncated: it is a 64-char digest, and this is a summary rather than a tool for
                      verifying it. The full value is in the database for anyone who needs to compare. */}
                  {r.redactionHash.slice(0, 12)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * A one-line summary of a recorded `DriftEvidence` blob.
 *
 * The blob is the host's own JSON, parsed defensively: a malformed or empty `trigger_json` must render as
 * "no detail recorded" rather than throwing inside a table cell. The row's *existence* is the evidence —
 * losing it to a parse error would hide the very event this card exists to surface.
 */
function driftTriggerSummary(triggerJson: string): string {
  try {
    const t = JSON.parse(triggerJson) as { errors?: unknown; models?: unknown; windowMs?: unknown };
    const errors = typeof t.errors === "number" ? t.errors : null;
    const models = Array.isArray(t.models) ? t.models.length : null;
    const mins = typeof t.windowMs === "number" ? Math.round(t.windowMs / 60_000) : null;
    if (errors === null && models === null && mins === null) return "no detail recorded";
    const parts: string[] = [];
    if (errors !== null) parts.push(`${errors} drift-class errors`);
    if (models !== null) parts.push(`across ${models} models`);
    if (mins !== null) parts.push(`in ${mins} min`);
    return parts.join(" ");
  } catch {
    return "no detail recorded";
  }
}

/**
 * The recorded drift history — every detection and every repair, read from `drift_events`.
 *
 * Why this exists: the table has been written since Phase 5 and read by exactly one thing, the clipboard
 * diagnostics bundle. So "when did this provider start drifting, and what closed it" had no answer inside
 * the app — the same gap `gateway.log` and `generator_audit` each had, and the last of the three.
 *
 * **Not the same thing as the `RepairModal` above it.** That reads the in-memory `pendingRepairs` map,
 * which is session-only and describes *pending* plans; this reads what was recorded. A provider repaired
 * in an earlier session has no entry there and a row here.
 *
 * Reads on mount and on `tick`, like the generation card beside it: approving a repair writes a
 * resolution and bumps the tick, and the row that just changed is the one the operator is looking for.
 */
function DriftHistoryCard() {
  const tick = useUi((s) => s.tick);
  const [rows, setRows] = useState<DriftEventEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The newest read wins — see the invariant on `GenerationAuditCard`'s counter above.
  const gen = useRef(0);
  const load = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    try {
      const next = await driftEventsList(50);
      if (mine !== gen.current) return;
      setRows(next);
      setError(null);
    } catch (e) {
      if (mine !== gen.current) return;
      setRows(null);
      setError(String(e));
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  return (
    <section
      className="mt-3 rounded-md border p-3"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Drift history
        </span>
        {rows !== null && rows.length > 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            {rows.length} recorded · newest first
          </span>
        )}
        <Button variant="ghost" ariaLabel="Refresh drift history" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </Button>
      </div>

      <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Every time a provider was detected drifting, and every repair that answered it. A row with no
        resolution is still open — the drift was recorded and nothing has closed it yet.
      </p>

      <TrailWriteWarning trail="drift" />

      {error !== null && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
        >
          Could not read the drift history: {error}
        </div>
      )}

      {/* A loaded-but-empty history is a fact about this install, not a failure of the card. No
          `error === null` test is needed: `load` lets only the newest read write, so an empty `rows` and
          a set `error` cannot coexist. */}
      {rows !== null && rows.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          No drift recorded yet. A row appears when a provider starts failing in a drift-class way — so an
          empty history means that has not happened, not that this failed to load.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="w-full" aria-label="Drift history">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="text-left font-normal">Detected</th>
              <th className="text-left font-normal">Provider</th>
              <th className="text-left font-normal">Trigger</th>
              <th className="text-left font-normal">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t text-[12px]" style={{ borderColor: "var(--border)" }}>
                <td className="mono whitespace-nowrap py-1" title={new Date(r.detectedAt).toLocaleString()}>
                  {dayKey(r.detectedAt)} {clock(r.detectedAt)}
                </td>
                {/* The name is resolved for display only; the recorded id is the identity, and it is
                    what is shown when the provider has since been deleted. */}
                <td className="mono py-1">{registry.getProvider(r.providerId)?.name ?? r.providerId}</td>
                <td className="py-1">{driftTriggerSummary(r.triggerJson)}</td>
                {/* The word carries the state; the colour only reinforces it. */}
                <td className="py-1" style={{ color: r.resolution ? "var(--success)" : "var(--danger)" }}>
                  {r.resolution ?? "Open"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * screen-onboarding (L4, §2.1): the Add-Provider wizard — deterministic path end-to-end
 * (Connect → Probe → Identify → Test → Review → Enable), always cancellable, resumable
 * after restart (§2.1 state persistence). The AI-assisted path shows as locked until the
 * first provider is live (§2.9 bootstrap guard) — Phase 4 wires it.
 *
 * Cancellation removes everything the wizard created (provider row + keychain entry).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  OnboardingOrchestrator,
  runContractSuite,
  type ContractReport,
  type OnboardingSessionData,
  type ProbeAttempt,
} from "@aiprovider/router";
import {
  adapters, addKey, createPendingProvider, deleteProvider, getHttpPort,
  refreshCatalog, registry, setProviderStatus, router,
} from "../store";
import { useUi } from "../ui-state";
import { Button, Field, StatusDot, inputCls, inputStyle } from "../components/atoms";

type Step = 0 | 1 | 2 | 3 | 4; // Connect → Probe → Identify → Test → Review

interface WizardRefs {
  providerId: string;
  keyLabel: string;
  secret: string;
}

export function OnboardingScreen() {
  const { go, bump } = useUi();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeLog, setProbeLog] = useState<ProbeAttempt[]>([]);
  const [evidence, setEvidence] = useState<string[]>([]);
  const [contract, setContract] = useState<ContractReport | null>(null);
  const [consentText, setConsentText] = useState(false);
  const [consentImage, setConsentImage] = useState(false);
  const [dialect, setDialect] = useState<string>("");
  const refs = useRef<WizardRefs | null>(null);
  const orchRef = useRef<OnboardingOrchestrator | null>(null);
  const [resumable, setResumable] = useState<OnboardingSessionData | null>(null);
  const [prefill, setPrefill] = useState<OnboardingSessionData["input"] | null>(null);

  // resume support (§2.1): offer the latest non-terminal session
  useEffect(() => {
    invoke<{ id: number; inputJson: string; detailJson: string | null; state: string } | null>("onboarding_latest_active")
      .then((row) => {
        if (!row) return;
        try {
          const input = JSON.parse(row.inputJson) as OnboardingSessionData["input"];
          const detail = row.detailJson ? JSON.parse(row.detailJson) : {};
          setResumable({ input, state: row.state as OnboardingSessionData["state"], ...detail, updatedAt: 0 });
        } catch {
          /* corrupt row — ignore */
        }
      })
      .catch(() => undefined);
  }, []);

  const sessionRowId = useRef<number | null>(null);
  const persistence = useMemo(
    () => ({
      save: async (d: OnboardingSessionData) => {
        // The providerId travels in detail (not input) so resume re-attaches the exact
        // provider row even when several providers share a baseUrl.
        await invoke<number>("onboarding_save", {
          row: {
            id: sessionRowId.current,
            inputJson: JSON.stringify(d.input),
            detailJson: JSON.stringify({
              providerId: refs.current?.providerId ?? null,
              probeReport: d.probeReport,
              fingerprint: d.fingerprint,
              manifest: d.manifest,
              contract: d.contract,
              failureReason: d.failureReason,
            }),
            state: d.state,
            outcome: d.state === "enabled" || d.state === "failed" ? d.state : null,
          },
        })
          .then((id) => {
            sessionRowId.current = id;
          })
          .catch(() => undefined);
      },
      loadLatest: async () => null,
    }),
    [],
  );

  const runFreeChecks = useCallback(async (providerId: string, keyLabel: string) => {
    const { interpreter } = await adapters.forProvider(providerId);
    const key = registry.keysOf(providerId).find((k) => k.label === keyLabel) ?? registry.keysOf(providerId)[0];
    if (!key) throw new Error("provider key row missing");
    const report = await runContractSuite(interpreter, {
      secretRef: key.secretRef,
      consent: { text: false, image: false },
    });
    setContract(report);
    return report;
  }, []);

  /** Restart the wizard from a saved session: re-attach provider/key rows (the key lives in
   *  the keychain — the secret itself is never re-needed) and jump to the saved step. */
  const resumeSession = useCallback(
    async (saved: OnboardingSessionData) => {
      setResumable(null);
      setError(null);
      const detail = saved as OnboardingSessionData & { providerId?: string | null };
      const byId = detail.providerId ? registry.getProvider(detail.providerId) : undefined;
      const byNameAndUrl = registry
        .listProviders()
        .filter((p) => p.baseUrl === saved.input.baseUrl && p.name === saved.input.name);
      const provider = byId ?? (byNameAndUrl.length === 1 ? byNameAndUrl[0] : undefined);
      if (!provider) {
        setError("The provider entry for this session could not be identified uniquely — start fresh.");
        return;
      }
      const key = registry.keysOf(provider.id)[0];
      refs.current = { providerId: provider.id, keyLabel: key?.label ?? "key-01", secret: "" };
      const orch = new OnboardingOrchestrator(getHttpPort(), persistence);
      await orch.resume(saved);
      orchRef.current = orch;
      setPrefill(saved.input);
      switch (saved.state) {
        case "pending_registration":
        case "human_confirmation":
          setContract(saved.contract ?? null);
          setDialect(saved.fingerprint?.dialect ?? "");
          setEvidence(saved.fingerprint?.evidence ?? []);
          setStep(4);
          break;
        case "template_instantiated":
        case "contract_testing":
        case "probing":
        case "fingerprinting":
          setDialect(saved.fingerprint?.dialect ?? "");
          setEvidence(saved.fingerprint?.evidence ?? []);
          setStep(3);
          setBusy(true);
          try {
            await runFreeChecks(provider.id, key?.label ?? "key-01");
          } catch (e) {
            setError(String((e as Error).message ?? e));
          }
          setBusy(false);
          break;
        default:
          setStep(0); // collect_input: prefill the form, the user re-enters the key
      }
    },
    [persistence],
  );

  const cancel = useCallback(
    async (silent = false) => {
      const r = refs.current;
      if (r) {
        await deleteProvider(r.providerId).catch(() => undefined);
        refs.current = null;
      }
      if (!silent) go("providers");
      bump();
    },
    [go, bump],
  );

  async function start(input: { name: string; baseUrl: string; apiKey: string; docsUrl?: string }) {
    setBusy(true);
    setError(null);
    setProbeLog([]);
    try {
      // provider row first (pending = host allowlisted for probes), then the key (vault).
      const providerId = await createPendingProvider(input.name, input.baseUrl);
      const key = await addKey(providerId, "key-01", input.apiKey);
      refs.current = { providerId, keyLabel: key.label, secret: input.apiKey };
      const orch = new OnboardingOrchestrator(getHttpPort(), persistence);
      orchRef.current = orch;
      setStep(1);
      await orch.start({ name: input.name, baseUrl: input.baseUrl, docsUrl: input.docsUrl });
      setProbeLog(orch.session.probeReport?.attempts ?? []);
      setStep(2);
      const fp = await orch.identify();
      setEvidence(fp.evidence);
      setDialect(fp.dialect);
      if (fp.dialect === "unknown" || !fp.template) {
        setError(orch.session.failureReason ?? "could not identify this API");
        setStep(2);
        setBusy(false);
        return;
      }
      // register the template manifest on the pending provider, then free contract checks
      adapters.register(providerId, fp.template);
      await invoke("manifest_upsert_active", {
        m: {
          id: crypto.randomUUID(), providerId, version: 1, origin: "builtin-template",
          bodyJson: JSON.stringify(fp.template), contractResultJson: null,
          createdAt: Date.now(), isActive: true,
        },
      });
      setStep(3);
      const { interpreter } = await adapters.forProvider(providerId);
      const freeReport = await runContractSuite(interpreter, {
        secretRef: key.secretRef,
        consent: { text: false, image: false },
      });
      setContract(freeReport);
      setBusy(false);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  async function runPaidChecks() {
    const r = refs.current;
    const orch = orchRef.current;
    if (!r || !orch) return;
    setBusy(true);
    setError(null);
    try {
      const { interpreter } = await adapters.forProvider(r.providerId);
      const report = await runContractSuite(interpreter, {
        secretRef: registry.keysOf(r.providerId).find((k) => k.label === r!.keyLabel)?.secretRef ?? "",
        consent: { text: consentText, image: consentImage },
      });
      setContract(report);
      await orch.setContract(report);
      setBusy(false);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  async function enableProvider() {
    const r = refs.current;
    const orch = orchRef.current;
    if (!r || !orch) return;
    setBusy(true);
    try {
      if (!contract?.freePassed) throw new Error("free contract checks did not pass — review the failures");
      // Sessions resumed from storage may predate their manifest detail (or the detail was
      // saved before registration); the provider's registered manifest is authoritative.
      if (!orch.session.manifest) {
        const { interpreter } = await adapters.forProvider(r.providerId);
        await orch.resume({ ...orch.session, manifest: interpreter.manifest });
      }
      await orch.setContract(contract);
      await orch.confirmRegistration();
      await setProviderStatus(r.providerId, "enabled");
      await refreshCatalog(r.providerId).catch(() => undefined);
      await orch.enable();
      setBusy(false);
      bump();
      go("providers");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  const aiReady = router.systemAiAvailable();

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Add Provider — guided setup</h1>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => void cancel()} disabled={busy && step < 4}>Cancel</Button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
        {["Connect", "Probe", "Identify", "Test", "Review"].map((label, i) => (
          <div key={label} className="flex items-center gap-1">
            <span
              className="rounded-full border px-2 py-0.5"
              style={{
                borderColor: i === step ? "var(--accent)" : "var(--border)",
                color: i === step ? "var(--text)" : "var(--text-faint)",
                background: i < step ? "var(--surface-2)" : "transparent",
              }}
            >
              {i < step ? "✓ " : ""}{label}
            </span>
            {i < 4 && <span style={{ color: "var(--text-faint)" }}>→</span>}
          </div>
        ))}
      </div>

      {resumable && step === 0 && !busy && (
        <div className="mb-4 rounded border p-3" style={{ borderColor: "var(--info)", background: "var(--surface)" }}>
          <p className="mb-2 text-[13px]">
            An unfinished setup for <b>{resumable.input.name}</b> ({resumable.input.baseUrl}) was saved — state:{" "}
            <span className="mono">{resumable.state}</span>. Its provider entry and key are already stored.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void resumeSession(resumable)}>Resume setup</Button>
            <Button variant="ghost" onClick={() => setResumable(null)}>Start fresh instead</Button>
          </div>
        </div>
      )}

      {step === 0 && (
        <ConnectForm
          initial={prefill ?? undefined}
          onStart={(v) => void start(v)}
          busy={busy}
        />
      )}

      {step === 1 && (
        <Section title="Checking how this API behaves…">
          <ul className="mono space-y-0.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
            {probeLog.map((a, i) => (
              <li key={i}>
                {a.status === null ? "✕" : a.status < 300 ? "✓" : a.status === 404 ? "–" : "•"} {a.method} {a.path} → {a.status ?? a.error}
              </li>
            ))}
            {busy && <li>probing…</li>}
          </ul>
        </Section>
      )}

      {step === 2 && (
        <Section title="Identification">
          {dialect && dialect !== "unknown" ? (
            <>
              <p className="mb-2 text-[13px]">
                <StatusDot health="healthy" /> This API speaks the <b className="mono">{dialect}</b> dialect — the
                built-in template fits. No AI involved.
              </p>
              <ul className="list-disc pl-5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                {evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </>
          ) : (
            <div>
              <p className="mb-2 text-[13px]" style={{ color: "var(--danger)" }}>{error}</p>
              <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                {aiReady.available
                  ? "AI-assisted adapter generation can attempt this one (Phase 4)."
                  : "AI-assisted adapter generation unlocks after your first provider is live (currently: " + (aiReady.reason ?? "locked") + ")."}
              </p>
            </div>
          )}
        </Section>
      )}

      {step === 3 && contract && (
        <Section title="Contract tests">
          <ul className="space-y-1 text-[13px]">
            {contract.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <span style={{ color: c.pass ? "var(--success)" : "var(--danger)" }}>{c.pass ? "✓" : "✕"}</span>
                <span>
                  {c.name}
                  {c.paid && <span className="ml-1 rounded px-1 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--warn)" }}>paid</span>}
                  {c.detail && <span className="block text-[11px]" style={{ color: "var(--text-faint)" }}>{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          {!contract.checks.some((c) => c.paid) && (
            <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                Optional: verify text/image with minimal paid requests (≈1 token / smallest image):
              </p>
              <label className="mb-1 block text-[12px]">
                <input type="checkbox" checked={consentText} onChange={(e) => setConsentText(e.target.checked)} /> allow one minimal text request
              </label>
              <label className="mb-2 block text-[12px]">
                <input type="checkbox" checked={consentImage} onChange={(e) => setConsentImage(e.target.checked)} /> allow one minimal image request
              </label>
              <Button disabled={(!consentText && !consentImage) || busy} onClick={() => void runPaidChecks()}>
                Run paid checks
              </Button>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              disabled={busy || !contract.freePassed}
              onClick={() => setStep(4)}
            >
              {contract.freePassed ? "Continue to review" : "Free checks must pass to continue"}
            </Button>
          </div>
        </Section>
      )}

      {step === 4 && (
        <Section title="Review & enable">
          <ul className="mb-3 list-disc pl-5 text-[13px]" style={{ color: "var(--text-dim)" }}>
            <li>dialect: <span className="mono">{dialect}</span></li>
            <li>base URL: <span className="mono">{orchRef.current?.session.input.baseUrl}</span></li>
            <li>key: {refs.current?.keyLabel} (stored in your OS keychain)</li>
            {contract && <li>tests: {contract.checks.filter((c) => c.pass).length}/{contract.checks.length} passed</li>}
          </ul>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void enableProvider()}>
              Approve & enable provider
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
              Discard
            </Button>
          </div>
        </Section>
      )}

      {error && step !== 2 && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>
      )}
    </div>
  );
}

function ConnectForm({
  initial, onStart, busy,
}: {
  initial?: { name: string; baseUrl: string; docsUrl?: string };
  onStart: (v: { name: string; baseUrl: string; apiKey: string; docsUrl?: string }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [docsUrl, setDocsUrl] = useState(initial?.docsUrl ?? "");
  const valid = name.trim().length > 1 && /^https?:\/\//.test(baseUrl) && apiKey.trim().length > 8;
  return (
    <Section title="Connect">
      <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
        Name, base URL and an API key. The key goes straight to your OS keychain; the IDE probes the API
        (free requests only) to figure out how it behaves.
      </p>
      <Field label="Name">
        <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" autoFocus />
      </Field>
      <Field label="Base URL">
        <input className={`${inputCls} mono`} style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </Field>
      <Field label="API key (stored in your OS keychain)">
        <input className={`${inputCls} mono`} style={inputStyle} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
      </Field>
      <Field label="Docs URL (optional)">
        <input className={`${inputCls} mono`} style={inputStyle} value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} placeholder="https://docs.example.com/api" />
      </Field>
      <Button variant="primary" disabled={!valid || busy} onClick={() => onStart({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), docsUrl: docsUrl.trim() || undefined })}>
        {busy ? "Working…" : "Start setup"}
      </Button>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

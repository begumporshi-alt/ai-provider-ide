/**
 * screen-onboarding (L4, §2.1): the Add-Provider wizard — deterministic path end-to-end
 * (Connect → Probe → Identify → Test → Review → Enable), always cancellable, resumable
 * after restart (§2.1 state persistence). The AI-assisted path shows as locked until the
 * first provider is live (§2.9 bootstrap guard) — Phase 4 wires it.
 *
 * Cancellation removes everything the wizard created (provider row + stored secret).
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchAdmin } from "../lib/gateway-client";
import {
  BUILTIN_TEMPLATES,
  OnboardingOrchestrator,
  generateCandidates,
  generateCodeCandidate,
  runContractSuite,
  type BuiltinTemplateId,
  type CandidateProgress,
  type ContractReport,
  type OnboardingSessionData,
  type ProbeAttempt,
  type RankedCandidate,
} from "@aiprovider/router-core";
import {
  adapters, addKey, createPendingProvider, deleteProvider, getHttpPort,
  recordGeneratorAudit, refreshCatalog, registry, setProviderStatus, router,
} from "../store";
import { useUi } from "../ui-state";
import { Button, Field, StatusDot, inputCls, inputStyle } from "../components/atoms";
import { CodeCandidateReview } from "../components/CodeCandidateReview";
import { parseHeaderLines, withRequestHeaders } from "../lib/providers/manual-manifest";

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
  const [aiProgress, setAiProgress] = useState<CandidateProgress[]>([]);
  const [candidates, setCandidates] = useState<RankedCandidate[] | null>(null);
  const [picked, setPicked] = useState<RankedCandidate | null>(null);
  const [feedback, setFeedback] = useState("");
  const [generating, setGenerating] = useState(false);
  // Tier-2 (§2.7): the last-resort sandboxed code adapter, reviewed separately from the
  // declarative A/B/C grid because it is executable, not inert data.
  const [codeCandidate, setCodeCandidate] = useState<RankedCandidate | null>(null);
  const [codeGenerating, setCodeGenerating] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeLogs, setCodeLogs] = useState<string[]>([]);
  const [codeApproved, setCodeApproved] = useState(false);
  const [offerCode, setOfferCode] = useState(false);
  const refs = useRef<WizardRefs | null>(null);
  const orchRef = useRef<OnboardingOrchestrator | null>(null);
  // The abort handle for the pipeline in flight. Cancel presses it, so a half-open host mid-probe
  // no longer locks the wizard for the full request-timeout chain.
  const abortRef = useRef<AbortController | null>(null);
  // The request headers the current run probes with (a client-gate answer rides here). The
  // dialect override at Review re-registers a template and must keep them — a manifest that
  // dropped the gate header would identify fine and then fail its first real request.
  const extraHeadersRef = useRef<Record<string, string> | undefined>(undefined);
  // Dialect override (Review step): "" keeps the detected answer.
  const [override, setOverride] = useState<BuiltinTemplateId | "">("");
  const [overriding, setOverriding] = useState(false);
  const [resumable, setResumable] = useState<(OnboardingSessionData & { rowId?: number }) | null>(null);
  const [prefill, setPrefill] = useState<OnboardingSessionData["input"] | null>(null);
  /**
   * The client-gate marker, when the probe met one — and the header text the operator is entering
   * to answer it. Held as one pair because neither means anything without the other: the marker
   * explains why we stopped, the field is the only way forward.
   */
  const [gate, setGate] = useState<string | null>(null);
  const [gateHeader, setGateHeader] = useState("");
  /**
   * The input of the run in flight, so a gate retry can repeat it.
   *
   * A ref rather than state: the retry reads it at click time and nothing renders from it, so
   * putting it in state would add a render that changes no pixels.
   */
  const lastInput = useRef<{ name: string; baseUrl: string; apiKey: string; docsUrl?: string } | null>(null);

  // A navigation handoff (e.g. the editor's "re-run setup against the new URL") prefills the
  // Connect form once and is consumed — a stale prefill must not haunt a later visit.
  useEffect(() => {
    const handed = useUi.getState().onboardingPrefill;
    if (handed) {
      setPrefill(handed);
      useUi.getState().setOnboardingPrefill(undefined);
    }
  }, []);

  // resume support (§2.1): offer the latest non-terminal session
  useEffect(() => {
    invoke<{ id: number; inputJson: string; detailJson: string | null; state: string } | null>("onboarding_latest_active")
      .then((row) => {
        if (!row) return;
        try {
          const input = JSON.parse(row.inputJson) as OnboardingSessionData["input"];
          const detail = row.detailJson ? JSON.parse(row.detailJson) : {};
          setResumable({ input, state: row.state as OnboardingSessionData["state"], ...detail, updatedAt: 0, rowId: row.id ?? undefined });
        } catch {
          /* corrupt row — ignore */
        }
      })
      .catch(() => undefined);
  }, []);

  const sessionRowId = useRef<number | null>(null);
  // Set when a session save fails (e.g. the pre-D78 state CHECK rejecting `failed`): the wizard
  // still works, but "resume after restart" quietly would not — an operator deserves to know
  // that before they close the window mid-setup.
  const [saveWarn, setSaveWarn] = useState(false);
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
          .catch((e) => {
            console.error("onboarding_save failed:", e);
            setSaveWarn(true);
          });
      },
      loadLatest: async () => null,
    }),
    [],
  );

  const runFreeChecks = useCallback(async (providerId: string, keyLabel: string) => {
    const { adapter } = await adapters.forProvider(providerId);
    const key = registry.keysOf(providerId).find((k) => k.label === keyLabel) ?? registry.keysOf(providerId)[0];
    if (!key) throw new Error("provider key row missing");
    const report = await runContractSuite(adapter, {
      secretRef: key.secretRef,
      consent: { text: false, image: false },
    });
    setContract(report);
    return report;
  }, []);

  /** Restart the wizard from a saved session: re-attach provider/key rows (the key lives in
   *  the secrets file — the secret itself is never re-needed) and jump to the saved step. */
  const resumeSession = useCallback(
    async (saved: OnboardingSessionData & { rowId?: number }) => {
      setResumable(null);
      setError(null);
      sessionRowId.current = saved.rowId ?? null;
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
      await orch.resume({ ...saved, providerId: undefined, ...({} as object) } as OnboardingSessionData);
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
          const unknownDialect = saved.fingerprint?.dialect === "unknown" || (!saved.fingerprint && saved.probeReport);
          if (unknownDialect && saved.probeReport) {
            // the deterministic path missed before the restart — continue into the AI path
            setStep(2);
            await runGenerator(orch, saved.input.baseUrl, provider.id, key!.secretRef);
            break;
          }
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
      abortRef.current?.abort();
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

  /** Phase 4: the AI path. Best-of-N candidates, each gated schema -> lint -> free checks. */
  function systemLabel(): string {
    return (router.settings.systemAi
      ? `${registry.getProvider(router.settings.systemAi.providerId)?.slug}/${router.settings.systemAi.model}`
      : "auto") + " (system)";
  }

  async function runGenerator(orch: OnboardingOrchestrator, baseUrl: string, providerId: string, secretRef: string, note?: string) {
    setGenerating(true);
    setAiProgress([]);
    setCandidates(null);
    setPicked(null);
    setError(null);
    setOfferCode(false);
    setCodeCandidate(null);
    setCodeError(null);
    setCodeLogs([]);
    setCodeApproved(false);
    try {
      const ranked = await generateCandidates({
        ai: router,
        systemLabel: systemLabel(),
        report: orch.session.probeReport!,
        baseUrl,
        secretRef,
        excludeProviderIds: [providerId],
        docsUrl: orch.session.input.docsUrl,
        http: getHttpPort(),
        feedback: note,
        onProgress: (p) => setAiProgress((prev) => [...prev.filter((x) => x.id !== p.id), p]),
        audit: async (e) => {
          // Through `store.ts`, not a local `invoke`: the wizard and drift repair write the same
          // trail, and this call site kept its own copy with `.catch(() => undefined)` — so the
          // wizard's audit failures were the last ones still silent.
          await recordGeneratorAudit(e);
        },
      });
      setCandidates(ranked);
      if (!ranked.some((c) => c.manifest && c.freePasses > 0)) {
        setError("No candidate passed the free contract checks — review the details below and regenerate with feedback, or try the Tier-2 code adapter.");
        // §2.7: Tier 2 is the last resort, offered only when the declarative grammar cannot
        // express this provider. It is an explicit human action, never an automatic fallback.
        setOfferCode(true);
      } else {
        setOfferCode(false);
      }
    } catch (e) {
      setError(`Generation failed: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  /** Tier-2 (§2.7): the last resort, reached only when no declarative candidate was usable.
   *  Deliberately a separate, explicit action — never automatic — because the output is
   *  executable code. The gate (schema → lint → compile → free contract checks) runs before
   *  the human sees anything; the panel below shows its evidence. */
  async function runCodeGenerator(note?: string) {
    const orch = orchRef.current;
    const r = refs.current;
    if (!orch || !r) return;
    setCodeGenerating(true);
    setCodeError(null);
    setCodeCandidate(null);
    setCodeLogs([]);
    setCodeApproved(false);
    try {
      const candidate = await generateCodeCandidate({
        ai: router,
        systemLabel: systemLabel(),
        report: orch.session.probeReport!,
        baseUrl: orch.session.input.baseUrl,
        secretRef: registry.keysOf(r.providerId)[0]?.secretRef ?? "",
        excludeProviderIds: [r.providerId],
        http: getHttpPort(),
        feedback: note,
        onLog: (line) => setCodeLogs((prev) => [...prev.slice(-199), line]),
      });
      setCodeCandidate(candidate);
      if (!candidate.manifest || candidate.freePasses === 0) {
        setCodeError(
          candidate.rejectedReason
            ? `The code adapter did not pass the gate: ${candidate.rejectedReason}`
            : "The code adapter did not pass the free contract checks — review the evidence and regenerate with feedback.",
        );
      }
    } catch (e) {
      setCodeError(`Tier-2 generation failed: ${(e as Error).message}`);
    } finally {
      setCodeGenerating(false);
    }
  }

  async function pickCandidate(c: RankedCandidate) {
    const orch = orchRef.current;
    const r = refs.current;
    if (!orch || !r || !c.manifest) return;
    setBusy(true);
    setError(null);
    try {
      adapters.register(r.providerId, c.manifest);
      await fetchAdmin("POST", "/admin/manifests", {
        id: crypto.randomUUID(), providerId: r.providerId, version: 1, origin: "ai-generated",
        bodyJson: JSON.stringify(c.manifest),
        contractResultJson: JSON.stringify(c.contract),
        createdAt: Date.now(), isActive: true,
      });
      await orch.adoptGeneratedManifest(c.manifest);
      setPicked(c);
      setDialect(`ai-generated (${c.manifest.dialect})`);
      if (c.manifest.kind === "code") setCodeApproved(true);
      setStep(3);
      await runFreeChecks(r.providerId, r.keyLabel);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function start(
    input: { name: string; baseUrl: string; apiKey: string; docsUrl?: string },
    /**
     * Headers to probe with, and to carry into the manifest setup registers.
     *
     * Supplied on a retry after a client gate, or on resume when one was already entered. The probe
     * runs before any manifest exists, so this is the only channel by which a header can reach it.
     */
    extraHeaders?: Record<string, string>,
  ) {
    setBusy(true);
    setError(null);
    setProbeLog([]);
    setGate(null);
    lastInput.current = input;
    const ac = new AbortController();
    abortRef.current = ac;
    extraHeadersRef.current = extraHeaders;
    setOverride("");
    try {
      // provider row first (pending = host allowlisted for probes), then the key (vault).
      // refs is filled immediately after the row exists — not after the key — so a failure in
      // between still rolls the row back (the catch below owns cleanup for this whole window).
      const providerId = await createPendingProvider(input.name, input.baseUrl);
      refs.current = { providerId, keyLabel: "key-01", secret: input.apiKey };
      const key = await addKey(providerId, "key-01", input.apiKey);
      refs.current = { providerId, keyLabel: key.label, secret: input.apiKey };
      const orch = new OnboardingOrchestrator(getHttpPort(), persistence);
      orchRef.current = orch;
      setStep(1);
      await orch.start(
        { name: input.name, baseUrl: input.baseUrl, docsUrl: input.docsUrl, extraHeaders },
        // stream each attempt as it lands: the log now fills during the probe, not after it
        { onAttempt: (a) => setProbeLog((prev) => [...prev, a]), signal: ac.signal },
      );
      setProbeLog(orch.session.probeReport?.attempts ?? []);
      setStep(2);
      const fp = await orch.identify();
      setEvidence(fp.evidence);
      setDialect(fp.dialect);
      if (fp.dialect === "unknown" || !fp.template) {
        setStep(2);
        setBusy(false);
        // **A client gate is a configuration answer, not a "we cannot support this" answer.**
        // Handing it to the generator would spend calls on a request whose refusal is already
        // explained, and the generator cannot know which client this gateway will accept — that is
        // the operator's knowledge. So we stop and offer the one thing that can move it: the
        // header field. Measured 2026-09-29: `agentrouter.org` gates on `User-Agent` and reads the
        // key only once the client is accepted.
        if (fp.clientGate) {
          setGate(fp.clientGate);
          // Seeded only when empty, so a second gate does not wipe what the operator just typed —
          // a retry that fails should leave their text where they left it.
          setGateHeader((h) => h || "user-agent: ");
          setError(orch.session.failureReason ?? "the gateway refused this client");
          return;
        }
        if (!router.systemAiAvailable().available) {
          setError(orch.session.failureReason ?? "could not identify this API");
        } else {
          // deterministic path missed; hand off to the AI generator (Phase 4)
          await runGenerator(orch, input.baseUrl, providerId, key.secretRef);
        }
        return;
      }
      // register the template manifest on the pending provider, then free contract checks
      // The operator's headers ride along, so the provider is not merely *identified* with them and
      // then left unable to make a request without them.
      const template = withRequestHeaders(fp.template, extraHeaders ?? {});
      adapters.register(providerId, template);
      await fetchAdmin("POST", "/admin/manifests", {
        id: crypto.randomUUID(), providerId, version: 1, origin: "builtin-template",
        bodyJson: JSON.stringify(template), contractResultJson: null,
        createdAt: Date.now(), isActive: true,
      });
      setStep(3);
      const { adapter } = await adapters.forProvider(providerId);
      const freeReport = await runContractSuite(adapter, {
        secretRef: key.secretRef,
        consent: { text: false, image: false },
      });
      setContract(freeReport);
      setBusy(false);
    } catch (e) {
      if (ac.signal.aborted) {
        // A user abort: cancel() already deleted the rows and navigated home — this handler must
        // not paint an error over that, nor roll back rows it no longer owns.
        return;
      }
      // **Any other failure rolls the attempt back.** The provider row and stored key were created
      // for this run alone (pending, never enabled); leaving them behind stranded an orphan the
      // operator never asked for. Same contract as createPendingProvider's own rollback and the
      // gate-retry path. The wizard resets to Connect with the input prefilled so a retry is one
      // key entry away.
      const r = refs.current;
      if (r) await deleteProvider(r.providerId).catch(() => undefined);
      refs.current = null;
      orchRef.current = null;
      setContract(null);
      setDialect("");
      setEvidence([]);
      setPrefill({ name: input.name, baseUrl: input.baseUrl, docsUrl: input.docsUrl });
      setStep(0);
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  /**
   * Answer a client gate: probe again with the operator's headers.
   *
   * **The failed provider row is removed first.** `start()` always creates a fresh pending provider,
   * so retrying without this would leave the abandoned attempt behind on every press — a row the
   * operator never asked for, with no key and no manifest, cluttering the list they are about to
   * look at. `createPendingProvider` has the same rollback for its own failure path, for the same
   * reason.
   */
  async function retryWithGateHeader() {
    const input = lastInput.current;
    if (!input) return;
    const { headers, problems } = parseHeaderLines(gateHeader);
    if (problems.length) {
      setError(`Custom headers: ${problems.join("; ")}.`);
      return;
    }
    if (Object.keys(headers).length === 0) {
      setError("Enter at least one header, for example: user-agent: claude-cli/2.0.0 (external, cli)");
      return;
    }
    const failed = refs.current?.providerId;
    if (failed) await deleteProvider(failed).catch(() => undefined);
    setGate(null);
    await start(input, headers);
  }

  async function runPaidChecks() {
    const r = refs.current;
    const orch = orchRef.current;
    if (!r || !orch) return;
    setBusy(true);
    setError(null);
    try {
      const { adapter } = await adapters.forProvider(r.providerId);
      const report = await runContractSuite(adapter, {
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

  /**
   * The operator overrides the detected dialect at Review: re-register the chosen built-in
   * template and walk back to the contract step for real checks against it.
   *
   * Auto setup can meet a host that serves both dialects and answers the wrong one first —
   * `identify()` itself documents such a host — so "the wizard decided, live with it" is not an
   * acceptable end state. The gate headers ride along, or the re-registered manifest would pass
   * identification and fail its first real request.
   */
  async function applyDialectOverride(templateId: BuiltinTemplateId) {
    const r = refs.current;
    const orch = orchRef.current;
    const factory = BUILTIN_TEMPLATES[templateId];
    if (!r || !orch || !factory) return;
    setOverriding(true);
    setError(null);
    try {
      const template = withRequestHeaders(
        factory(orch.session.input.baseUrl),
        extraHeadersRef.current ?? {},
      );
      adapters.register(r.providerId, template);
      await fetchAdmin("POST", "/admin/manifests", {
        id: crypto.randomUUID(), providerId: r.providerId, version: 1, origin: "builtin-template",
        bodyJson: JSON.stringify(template), contractResultJson: null,
        createdAt: Date.now(), isActive: true,
      });
      await orch.resume({
        ...orch.session,
        manifest: template,
        fingerprint: {
          dialect: templateId,
          template,
          evidence: [
            ...(orch.session.fingerprint?.evidence ?? []),
            `overridden by operator: forced the ${templateId} template`,
          ],
        },
      });
      setDialect(templateId);
      setOverride("");
      setContract(null);
      setStep(3);
      await runFreeChecks(r.providerId, r.keyLabel);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setOverriding(false);
    }
  }

  async function enableProvider() {    const r = refs.current;
    const orch = orchRef.current;
    if (!r || !orch) return;
    setBusy(true);
    try {
      if (!contract?.freePassed) throw new Error("free contract checks did not pass — review the failures");
      // Sessions resumed from storage may predate their manifest detail (or the detail was
      // saved before registration); the provider's registered manifest is authoritative.
      if (!orch.session.manifest) {
        const { adapter } = await adapters.forProvider(r.providerId);
        await orch.resume({ ...orch.session, manifest: adapter.manifest });
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

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Add Provider — guided setup</h1>
        <div className="ml-auto flex gap-2">
          {/* Always enabled: aborting is the only way out of a slow probe, and cancel() deletes
              everything the attempt created either way. */}
          <Button onClick={() => void cancel()}>Cancel</Button>
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

      {saveWarn && step > 0 && (
        <p className="mb-3 text-[12px]" style={{ color: "var(--warn)" }} role="status">
          Note: this session could not be saved, so it will not be offered for resume if you close
          the app. Setup itself continues to work.
        </p>
      )}

      {resumable && step === 0 && !busy && (
        <div className="mb-4 rounded border p-3" style={{ borderColor: "var(--info)", background: "var(--surface)" }}>
          <p className="mb-2 text-[13px]">
            An unfinished setup for <b>{resumable.input.name}</b> ({resumable.input.baseUrl}) — {STATE_COPY[resumable.state] ?? resumable.state}. Its
            provider entry and key are already stored.
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
            <p className="mb-2 text-[13px]">
              <StatusDot health="healthy" /> This API speaks the <b className="mono">{dialect}</b> dialect — the
              built-in template fits. No AI involved.
            </p>
          ) : (
            <>
              <ul className="mb-3 list-disc pl-5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                {evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
              <p className="mb-2 text-[13px]" style={{ color: "var(--warn)" }}>
                No known dialect matched — switching to AI-assisted generation.
              </p>
              <AiPath
                generating={generating}
                aiProgress={aiProgress}
                candidates={candidates}
                picked={picked}
                error={error}
                feedback={feedback}
                setFeedback={setFeedback}
                onPick={(c) => void pickCandidate(c)}
                onRegenerate={() => void runGenerator(
                  orchRef.current!,
                  orchRef.current!.session.input.baseUrl,
                  refs.current!.providerId,
                  registry.keysOf(refs.current!.providerId)[0]!.secretRef,
                  feedback.trim() || undefined,
                )}
              />
              {offerCode && !codeCandidate && !codeGenerating && (
                <div className="mt-3 rounded border p-3" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
                  <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                    No declarative manifest could express this API. The last resort is a
                    <b> sandboxed code adapter</b>: the AI writes a small JS module that runs
                    inside a QuickJS-WASM sandbox — no filesystem, no network of its own, no
                    access to your key. You review its source and the gate evidence before it
                    is registered.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => void runCodeGenerator()}
                  >
                    Generate a sandboxed code adapter
                  </Button>
                </div>
              )}
              {(codeGenerating || codeCandidate) && (
                <div className="mt-3">
                  <CodeCandidateReview
                    candidate={codeCandidate}
                    generating={codeGenerating}
                    logs={codeLogs}
                    busy={busy}
                    approved={codeApproved}
                    error={codeError}
                    onApprove={(c) => void pickCandidate(c)}
                    onReject={() => {
                      setCodeCandidate(null);
                      setCodeError(null);
                      setCodeLogs([]);
                    }}
                    onRegenerate={(note) => void runCodeGenerator(note)}
                  />
                </div>
              )}
            </>
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
            <li>key: {refs.current?.keyLabel} (stored in a local secrets file)</li>
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
          {/* The one override auto setup offers, and deliberately the only place it is needed:
              detection ran, the operator has seen its answer, and "looks wrong" is now an informed
              judgement rather than a guess. Re-checks against the chosen template before enabling. */}
          <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
              Detected the wrong dialect? Some hosts serve both and answer the wrong one first. Pick
              the other built-in and the free checks run again against it before anything enables.
            </p>
            <div className="flex items-center gap-2">
              <select
                className={inputCls}
                style={inputStyle}
                value={override}
                onChange={(e) => setOverride(e.target.value as BuiltinTemplateId | "")}
                aria-label="Override dialect"
              >
                <option value="">keep detected: {dialect}</option>
                <option value="openai-compat">OpenAI-compatible (openai-chat-v1)</option>
                <option value="anthropic-compat">Anthropic-compatible (anthropic-messages-v1)</option>
                <option value="gemini-compat">Gemini-native (gemini-generate-v1)</option>
              </select>
              <Button
                disabled={!override || overriding || busy}
                onClick={() => void applyDialectOverride(override as BuiltinTemplateId)}
              >
                {overriding ? "Re-testing…" : "Re-test with this dialect"}
              </Button>
            </div>
          </div>
        </Section>
      )}

      {/*
        The client-gate panel. Rendered outside the step machine on purpose: the wizard's ordinary
        error line is suppressed at step 2, and step 2 is exactly where a gate lands. A message that
        the step machine can hide is a message the operator will not see.
      */}
      {gate && (
        <div className="mt-3">
          <Section title="This gateway refused our client">
            <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>
            <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
              The gateway answered <code>{gate}</code> without looking at your key, so nothing is
              wrong with the key itself. Name a client it serves and auto setup will probe again —
              the header is kept on the provider, so it is used for every later request too.
            </p>
            <Field label="Request headers">
              <textarea
                className={`${inputCls} mono`} style={{ ...inputStyle, minHeight: "4.5rem" }}
                value={gateHeader}
                onChange={(e) => setGateHeader(e.target.value)}
                placeholder={"user-agent: claude-cli/2.0.0 (external, cli)"}
                spellCheck={false}
              />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void retryWithGateHeader()}>
                Retry with these headers
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                Discard
              </Button>
            </div>
          </Section>
        </div>
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
    // A form, so Enter submits — the manual wizard's model input already did, and half the
    // keyboard surface submitting while the other half ignores it is how forms teach guessing.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onStart({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), docsUrl: docsUrl.trim() || undefined });
      }}
    >
      <Section title="Connect">
        <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
          Name, base URL and an API key. The key goes straight to a local secrets file; the IDE probes the API
          (free requests only) to figure out how it behaves.
        </p>
        <Field label="Name">
          <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" autoFocus />
        </Field>
        <Field label="Base URL">
          <input className={`${inputCls} mono`} style={inputStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        </Field>
        <Field label="API key (stored in a local secrets file)">
          <input className={`${inputCls} mono`} style={inputStyle} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </Field>
        <Field label="Docs URL (optional)">
          <input className={`${inputCls} mono`} style={inputStyle} value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} placeholder="https://docs.example.com/api" />
        </Field>
        <Button variant="primary" type="submit" disabled={!valid || busy}>
          {busy ? "Working…" : "Start setup"}
        </Button>
      </Section>
    </form>
  );
}

function AiPath({
  generating, aiProgress, candidates, picked, error, feedback, setFeedback, onPick, onRegenerate,
}: {
  generating: boolean;
  aiProgress: CandidateProgress[];
  candidates: RankedCandidate[] | null;
  picked: RankedCandidate | null;
  error: string | null;
  feedback: string;
  setFeedback: (v: string) => void;
  onPick: (c: RankedCandidate) => void;
  onRegenerate: () => void;
}) {
  const stageOf = (id: string) => aiProgress.find((p) => p.id === id)?.stage ?? (generating ? "parsing" : undefined);
  const milestones = [
    { label: "Understand the API", done: true },
    { label: "Generate candidates", done: !generating && candidates !== null },
    { label: "Contract tests", done: Boolean(candidates?.some((c) => c.manifest && c.freePasses > 0)) },
    { label: "Your review", done: Boolean(picked) },
  ];
  const best = candidates && candidates.length ? candidates[0] : null;
  const bestUsable = best?.manifest && best.freePasses > 0 ? best.id : null;
  return (
    <div>
      <ul className="mb-3 space-y-1 text-[12px]">
        {milestones.map((m) => (
          <li key={m.label} className="flex items-center gap-2">
            <span style={{ color: m.done ? "var(--success)" : "var(--text-faint)" }}>{m.done ? "✓" : "○"}</span>
            <span style={{ color: m.done ? "var(--text)" : "var(--text-dim)" }}>{m.label}</span>
          </li>
        ))}
      </ul>
      {error && <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
      <div className="mb-3 grid grid-cols-3 gap-2">
        {["A", "B", "C"].map((id) => {
          const c = candidates?.find((x) => x.id === id);
          const stage = c ? undefined : stageOf(id);
          return (
            <div key={id} className="rounded border p-2" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[12px] font-semibold">Candidate {id}</span>
                {c?.manifest && c.freePasses > 0 && (
                  <span className="rounded px-1 text-[10px]" style={{ background: "var(--success)", color: "var(--bg)", fontWeight: 600 }}>
                    {bestUsable === id ? "★ recommended" : "usable"}
                  </span>
                )}
              </div>
              {!c && stage && <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>{stage === "parsing" ? "asking System AI…" : `${stage}…`}</div>}
              {!c && !stage && generating && <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>queued</div>}
              {c && !c.manifest && (
                <div className="text-[11px]" style={{ color: "var(--danger)" }}>
                  {c.rejectedReason ?? (c.schemaErrors[0] ?? c.lintErrors[0]) ?? "rejected"}
                </div>
              )}
              {c?.manifest && (
                <div className="space-y-0.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
                  <div>auth ✓ {c.contract?.checks.find((x) => x.name.startsWith("auth"))?.pass ? "" : "✕"}</div>
                  <div>models {c.contract?.checks.find((x) => x.name.startsWith("models"))?.pass ? "✓" : "—"}</div>
                  <div>
                    {Object.keys(c.manifest.endpoints).length} endpoint(s) · {c.score} pts
                  </div>
                  {c.contract?.checks.some((x) => !x.pass) && <div style={{ color: "var(--warn)" }}>some free checks failed</div>}
                  <div className="pt-1">
                    {c.manifest && c.freePasses > 0 ? (
                      <Button disabled={Boolean(picked)} onClick={() => onPick(c)}>
                        {picked?.id === id ? "Picked" : "Use this adapter"}
                      </Button>
                    ) : (
                      <span style={{ color: "var(--danger)" }}>no usable route</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!generating && candidates === null && !error && (
        <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>Preparing generation…</p>
      )}
      {candidates && (
        <div className="flex items-end gap-2">
          <input
            className={`${inputCls} flex-1`}
            style={inputStyle}
            placeholder="Optional: what should the next round do differently?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <Button onClick={onRegenerate}>Regenerate</Button>
        </div>
      )}
      <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        The AI sees only structure (paths, status codes, key/type shapes) — never your key. It cannot choose the host; lint pins it to your URL. Nothing enables until you approve.
      </p>
    </div>
  );
}

/**
 * What a saved session's machine state means to a person, for the resume panel — the raw state
 * string (`fingerprinting`) is this module's own vocabulary, not the operator's.
 */
const STATE_COPY: Partial<Record<OnboardingSessionData["state"], string>> = {
  collect_input: "it stopped at the connection form",
  probing: "it was still probing the API",
  fingerprinting: "it was identifying the API's dialect",
  template_instantiated: "the dialect was identified",
  ai_generating: "adapter generation was running",
  linting: "adapter generation was running",
  contract_testing: "it was running the contract checks",
  pending_registration: "it was waiting for your review",
  human_confirmation: "it was waiting for your review",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

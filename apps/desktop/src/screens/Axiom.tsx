/**
 * AXIOM — supervision over the Assistant.
 *
 * The screen is a *reader and a trigger*, not the engine: `@aiprovider/axiom-core` does the observing,
 * evaluating, diagnosing, designing, modifying, validating and evolving, and this component gives it
 * ports (`lib/axiom/ports`) and shows what came back. Nothing here decides whether a change is good.
 *
 * Two things it shows that a dashboard usually leaves out, both because the spec asks for them:
 *
 * - **"What AXIOM did not do."** `ImproveReport.notDone` is rendered in full. A report listing only
 *   what happened reads as a report of everything, and the gap is the part a user needs — a reused
 *   baseline, a proposal with no actuator, a candidate that was rejected and why.
 * - **The overclaim column.** The capability map's "claims to do but fails to accomplish reliably"
 *   state, which a pass-rate table hides: an agent that says "done" on a task whose expectations then
 *   failed is worse than one that says it could not, and only this column shows the difference.
 *
 * What it refuses to do: promote on the agent's word, or spend money without asking. The run is
 * gated by a consent modal showing the call count and the token assumption, and closing that modal
 * means *decline* — a dialog whose close button left a promise unresolved would hang an eval forever.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAxiom,
  describeCapabilityState,
  estimateCost,
  parseSuite,
  PaidRunRefusedError,
  type AgentVersion,
  type Autopsy,
  type ConsentPort,
  type CostEstimate,
  type ImproveReport,
  type PromotionDecision,
  type RunTrace,
  type SuiteResult,
} from "@aiprovider/axiom-core";
import {
  axiomActiveConfig,
  axiomGetAudit,
  axiomListAudits,
  axiomListDecisions,
  axiomListFindings,
  axiomListSuiteResults,
  axiomListTraces,
  axiomListVersions,
  axiomPutAudit,
  axiomSetVersionState,
  catalog,
  registry,
  type StoredAuditPass,
  type StoredFinding,
} from "../store";
import { selectableModels } from "../lib/models/selectable";
import { fetchDefaultRoot } from "../lib/tools";
import { ASSISTANT_POLICY, EVAL_DIR_NAME } from "../lib/axiom/runner";
import { createAxiomPorts } from "../lib/axiom/ports";
import { DEFAULT_SUITE_JSON } from "../lib/axiom/suite";
import { Button, EmptyState, Modal, inputCls, inputStyle } from "../components/atoms";
import { useUi } from "../ui-state";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const fmtTime = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AxiomScreen() {
  const tick = useUi((s) => s.tick);
  const screen = useUi((s) => s.screen);
  const [model, setModel] = useState("");
  const [repeats, setRepeats] = useState(2);
  const [suiteText, setSuiteText] = useState(DEFAULT_SUITE_JSON);
  const [showSuite, setShowSuite] = useState(false);
  const [root, setRoot] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImproveReport | null>(null);
  const controller = useRef<AbortController | null>(null);

  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<PromotionDecision[]>([]);
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [traces, setTraces] = useState<RunTrace[]>([]);
  const [audits, setAudits] = useState<StoredAuditPass[]>([]);
  /**
   * Every recorded suite result, kept so the cost estimate can use this suite's own measured token
   * counts once they exist rather than the standing assumption — `estimateCost` prefers history for
   * exactly that reason, and an assumption that survives a real run is an assumption nobody checked.
   */
  const [priors, setPriors] = useState<SuiteResult[]>([]);

  const [consent, setConsent] = useState<{ estimate: CostEstimate; answer: (ok: boolean) => void } | null>(null);
  const [autopsyRun, setAutopsyRun] = useState<string | null>(null);
  const [autopsy, setAutopsy] = useState<Autopsy | null>(null);

  const modelOptions = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";
    return selectableModels(catalog.forModality("text"), catalog.aliases, slugOf, isEnabled);
  }, [tick]);

  const reload = useCallback(async (opts?: { restoreReport?: boolean }) => {
    // Each read is independent and each failure is survivable: a screen that could not render its
    // version chain because the traces table was empty would be a screen that shows nothing.
    const [v, a, d, f, t, s, h] = await Promise.allSettled([
      axiomListVersions(),
      axiomActiveConfig(),
      axiomListDecisions(),
      axiomListFindings(),
      axiomListTraces(40),
      axiomListSuiteResults(),
      axiomListAudits(100),
    ]);
    if (v.status === "fulfilled") setVersions(v.value);
    if (a.status === "fulfilled") setActiveId(a.value.versionId);
    if (d.status === "fulfilled") setDecisions(d.value);
    if (f.status === "fulfilled") setFindings(f.value);
    if (t.status === "fulfilled") setTraces(t.value);
    if (s.status === "fulfilled") setPriors(s.value);
    if (h.status === "fulfilled") setAudits(h.value);
    // On a fresh mount, the newest completed pass is what the report area should show — a screen
    // that makes the last audit invisible until it is re-run would ask the user to pay to read
    // their own history. Later reloads keep whatever is on screen: a mid-session restore could
    // clobber a report the user is mid-way through reading.
    if (opts?.restoreReport && h.status === "fulfilled") {
      const latest = h.value.find((x) => x.status === "completed");
      if (latest) {
        // The list command deliberately omits the report body; open the one pass we need.
        const full = await axiomGetAudit(latest.id).catch(() => null);
        const rep =
          full?.report && isImproveReport(full.report)
            ? (full.report as unknown as ImproveReport)
            : null;
        if (rep) setReport(rep);
      }
    }
  }, []);

  /** Open one older pass's report. The list carries metadata only; the body is fetched here,
   *  by primary key, so the timeline can still inspect history without shipping every report. */
  const openAuditReport = useCallback(async (id: string) => {
    const full = await axiomGetAudit(id).catch(() => null);
    if (full?.report && isImproveReport(full.report)) {
      setReport(full.report as unknown as ImproveReport);
    }
  }, []);

  const reloadInFlight = useRef(false);
  useEffect(() => {
    // A hidden screen must not reload. The global tick moves on every user action, and this
    // screen is kept mounted after its first visit — without this guard a hidden AXIOM re-reads
    // every store (including the audit ledger) each time the Assistant touches the tick.
    if (screen !== "axiom" || reloadInFlight.current) return;
    reloadInFlight.current = true;
    void reload({ restoreReport: true })
      .catch(() => undefined)
      .finally(() => {
        reloadInFlight.current = false;
      });
    void fetchDefaultRoot().then(setRoot);
  }, [reload, tick, screen]);

  /** Consent as a port: the question belongs to the user, so the answer comes from the UI. */
  const consentPort: ConsentPort = useMemo(
    () => ({
      request: (estimate) =>
        new Promise<boolean>((resolve) => {
          setConsent({ estimate, answer: resolve });
        }),
    }),
    [],
  );

  /**
   * Ports for everything that does not spend: reading versions, estimating a run, opening an
   * autopsy, changing a version's state. Deliberately built without `consent`, so a path that
   * reached a paid call through these would throw rather than quietly assume yes. `run` builds its
   * own set with the consent port attached, because that is the only path that calls a model.
   */
  const readPorts = useMemo(() => createAxiomPorts({ root: root?.trim() ?? "", sessionId: null }), [root]);

  const run = async () => {
    if (running) return;
    if (!model.trim()) {
      setError("Pick the model to evaluate. AXIOM measures a configuration on one model at a time.");
      return;
    }
    if (!root || !root.trim()) {
      setError(`No workspace root is set, so there is nowhere to confine an eval run. Set one in the Assistant, then come back.`);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(suiteText);
    } catch (e) {
      setError(`The suite is not valid JSON: ${(e as Error).message}`);
      return;
    }
    const parsed = parseSuite(json);
    if (!parsed.ok) {
      setError(parsed.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
      return;
    }

    setError(null);
    setReport(null);
    setRunning(true);
    setProgress("starting");
    const ac = new AbortController();
    controller.current = ac;
    const auditId = `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    // Whatever the pass becomes, it becomes a record: completed, refused (you declined the spend),
    // aborted (you stopped it), or failed. A pass that leaves no row is a pass history cannot
    // distinguish from a pass that never happened.
    let outcome: {
      status: StoredAuditPass["status"];
      reportDoc: Record<string, unknown>;
      decision: StoredAuditPass["decision"];
      candidateId: string | null;
      baselineId: string | null;
    } | null = null;
    try {
      const ports = {
        ...createAxiomPorts({
          root: root.trim(),
          sessionId: null,
          onEvent: (ev, runId) => {
            if (ev.type === "tool_call") setProgress(`${runId.slice(-6)}: calling ${ev.call.name ?? "?"}`);
            else if (ev.type === "tool_result") setProgress(`${runId.slice(-6)}: ${ev.call.name ?? "?"} ${ev.ok ? "ok" : "failed"}`);
            else if (ev.type === "verification_nudge") setProgress(`${runId.slice(-6)}: held by the verification gate`);
            else if (ev.type === "done") setProgress(`${runId.slice(-6)}: finished in ${ev.iterations} iterations`);
          },
        }),
        consent: consentPort,
      };
      const axiom = createAxiom(ports, { policy: ASSISTANT_POLICY, repeats, runLimit: 200 });
      setProgress("reading the agent's recorded runs");
      // The signal is what makes the Stop button stop something: it reaches `evaluateSuite`, which
      // checks it between attempts and hands it to the runner, which aborts the loop in flight.
      const rep = await axiom.improve({ suite: parsed.suite, model: model.trim(), signal: ac.signal });
      setReport(rep);
      outcome = {
        status: "completed",
        reportDoc: rep as unknown as Record<string, unknown>,
        decision: rep.decision?.decision ?? null,
        candidateId: rep.decision?.candidateId ?? null,
        baselineId: rep.baseline.versionId,
      };
    } catch (e) {
      const msg = (e as Error).message;
      // A declined paid run arrives here as `PaidRunRefusedError`, which is a decision rather than a
      // fault — but it is still the honest thing to show, because the alternative is a screen that
      // looks like it ran and produced nothing.
      setError(msg);
      outcome = {
        status: ac.signal.aborted ? "aborted" : e instanceof PaidRunRefusedError ? "refused" : "failed",
        reportDoc: { error: msg },
        decision: null,
        candidateId: null,
        baselineId: null,
      };
    } finally {
      controller.current = null;
      setRunning(false);
      setProgress(null);
      if (outcome) {
        try {
          await axiomPutAudit({
            id: auditId,
            startedAt,
            endedAt: Date.now(),
            status: outcome.status,
            suiteId: parsed.suite.id,
            model: model.trim(),
            repeats,
            decision: outcome.decision,
            candidateId: outcome.candidateId,
            baselineId: outcome.baselineId,
            report: outcome.reportDoc,
          });
        } catch {
          // The ledger is additive; a failed write must not mask the pass's own outcome, which the
          // screen above already shows.
        }
        await reload();
      }
    }
  };

  const openAutopsy = async (runId: string) => {
    setAutopsyRun(runId);
    setAutopsy(null);
    const axiom = createAxiom(readPorts, { policy: ASSISTANT_POLICY });
    setAutopsy(await axiom.autopsyOf(runId));
  };

  const changeState = async (id: string, state: "active" | "rejected" | "retired") => {
    setError(null);
    try {
      await axiomSetVersionState(id, state);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rollBack = async () => {
    setError(null);
    try {
      const axiom = createAxiom(readPorts, { policy: ASSISTANT_POLICY });
      const r = await axiom.rollback();
      if (r.refusal) setError(r.refusal);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const estimate = useMemo(() => {
    const parsed = parseSuite(safeJson(suiteText));
    if (!parsed.ok) return null;
    const prior = priors.filter((r) => r.suiteId === parsed.suite.id);
    return estimateCost(
      readPorts,
      { suite: parsed.suite, model: model.trim() || "(no model chosen)", repeats },
      prior,
    );
  }, [suiteText, model, repeats, priors, readPorts]);

  /**
   * The stepper's seven notes, one per stage, each a sentence the report actually backs. Before any
   * run every stage reads "waiting" — a stepper that pre-filled optimism would be the one lie this
   * screen is not allowed to tell.
   */
  const stages = useMemo(() => {
    if (!report) return STAGES.map(() => ({ tone: "idle" as StageTone, note: "waiting" }));
    const t = report.observation.totals;
    const serious = report.diagnosis.findings.filter(isSerious).length;
    const partial =
      report.baseline.attemptSummaries.length < report.baseline.tasks.length * report.baseline.repeats;
    return [
      { tone: "done" as const, note: `${t.runs} run(s) read` },
      {
        tone: partial ? ("warn" as const) : ("done" as const),
        note: `${pct(report.baseline.passRate)} pass · ${report.baseline.tasks.length}×${report.baseline.repeats}`,
      },
      {
        tone: report.diagnosis.findings.length === 0 ? ("done" as const) : serious > 0 ? ("fail" as const) : ("warn" as const),
        note:
          report.diagnosis.findings.length === 0
            ? "no detector fired"
            : `${serious} serious of ${report.diagnosis.findings.length}`,
      },
      {
        tone: report.proposals.length > 0 ? ("done" as const) : ("warn" as const),
        note: report.proposals.length > 0 ? `${report.proposals.length} proposal(s)` : "nothing to propose",
      },
      report.candidate
        ? { tone: "done" as const, note: `candidate …${report.candidate.id.slice(-6)}` }
        : { tone: "warn" as const, note: "no candidate built" },
      report.guardian
        ? report.guardian.passed
          ? { tone: "done" as const, note: "guardian passed" }
          : { tone: "fail" as const, note: "guardian refused" }
        : { tone: "idle" as const, note: "skipped" },
      report.decision
        ? report.decision.decision === "promote"
          ? { tone: "done" as const, note: "promoted" }
          : { tone: "fail" as const, note: "rejected" }
        : { tone: "idle" as const, note: "—" },
    ];
  }, [report]);

  /**
   * The newest stored suite result, used when no report is on screen so the pass-rate card shows the
   * last thing that was actually measured rather than a dash pretending nothing ever happened — and
   * labelled with when, because a number without its date reads as today's.
   */
  const latestPrior = useMemo(
    () => priors.reduce<SuiteResult | null>((a, b) => (a === null || b.endedAt > a.endedAt ? b : a), null),
    [priors],
  );
  const measured = report?.baseline ?? latestPrior;
  const measuredAttempts = measured?.attemptSummaries.length ?? 0;

  /**
   * The rail's activity feed: the four row kinds the store holds, merged into one timeline. Every
   * line is a stored fact with its own timestamp — nothing is inferred, and a store with no rows
   * gets an empty feed rather than a friendly fake.
   */
  const activity = useMemo(() => {
    const evts: { at: number; label: string; detail: string | null; color: string }[] = [];
    const runTone: Record<RunTrace["status"], string> = {
      ok: "var(--success)",
      error: "var(--danger)",
      stopped: "var(--warn)",
      running: "var(--info)",
    };
    for (const t of traces) {
      const label =
        t.status === "ok" ? "Agent run finished"
        : t.status === "error" ? "Agent run failed"
        : t.status === "stopped" ? "Agent run stopped"
        : "Agent run in progress";
      evts.push({ at: t.startedAt, label, detail: t.prompt ?? `run …${t.id.slice(-6)}`, color: runTone[t.status] ?? "var(--text-faint)" });
    }
    for (const d of decisions) {
      evts.push({
        at: d.decidedAt,
        label: d.decision === "promote" ? "Version promoted" : "Candidate rejected",
        detail: `${d.candidateId} over ${d.baselineId}`,
        color: d.decision === "promote" ? "var(--success)" : "var(--danger)",
      });
    }
    for (const v of versions) {
      evts.push({
        at: v.createdAt,
        label: `Version ${v.state}`,
        detail: v.reason,
        color: v.state === "active" ? "var(--success)" : v.state === "rejected" ? "var(--danger)" : v.state === "candidate" ? "var(--info)" : "var(--text-faint)",
      });
    }
    for (const f of findings) {
      evts.push({ at: f.recordedAt, label: "Finding recorded", detail: f.title, color: isSerious(f) ? "var(--danger)" : "var(--warn)" });
    }
    return evts.sort((a, b) => b.at - a.at).slice(0, 8);
  }, [traces, decisions, versions, findings]);

  /**
   * The one thing worth doing next, derived from state the store actually holds — a rejected
   * decision tells you to read the refusal, a waiting candidate tells you to judge it, findings
   * tell you to measure a fix. Never more than one live suggestion, so it cannot become a
   * checklist nobody follows.
   */
  const nextStep = useMemo(() => {
    if (report?.decision) {
      return report.decision.decision === "promote"
        ? `${report.decision.candidateId} was promoted — the next Assistant turn runs it. Watch its runs.`
        : `${report.decision.candidateId} was rejected — read the refusal before proposing it again.`;
    }
    if (report) return "The pass ended without a decision — read what AXIOM did not do, and why.";
    // A decision outlives the run that made it: it is stored, so its guidance should survive a
    // remount too. Guarded by the version's current state — guidance about a candidate that has
    // since been promoted or retired by hand is guidance about a world that no longer exists.
    const latestDecision = decisions.reduce<PromotionDecision | null>(
      (a, d) => (a === null || d.decidedAt > a.decidedAt ? d : a),
      null,
    );
    if (latestDecision) {
      const subject = versions.find((v) => v.id === latestDecision.candidateId);
      if (latestDecision.decision === "reject" && subject?.state === "rejected") {
        return `${latestDecision.candidateId} was rejected — read the refusal before proposing it again.`;
      }
      if (latestDecision.decision === "promote" && subject?.state === "active") {
        return `${latestDecision.candidateId} was promoted — the next Assistant turn runs it. Watch its runs.`;
      }
    }
    const candidate = versions.find((v) => v.state === "candidate");
    if (candidate) return `Version ${candidate.id} is still a candidate — promote it or retire it.`;
    if (findings.length > 0) {
      return `${findings.length} finding(s) recorded — run an audit to measure a fix against them.`;
    }
    if (traces.length > 0) return `${traces.length} run(s) recorded — run an audit to measure them against a suite.`;
    if (activeId) return "Nothing pending. Use the Assistant — AXIOM reads what it does.";
    return "Run the first audit: pick a model, then press Audit & improve.";
  }, [report, decisions, versions, findings, traces, activeId]);

  /** A version proposed but not yet judged — the one state where a decision is still open. */
  const candidate = versions.find((v) => v.state === "candidate") ?? null;

  /**
   * The History timeline: one entry per audit pass, newest first. Decisions recorded before the
   * ledger existed (or by hand, outside any pass) join the timeline too — a promotion is part of
   * the story even when there is no audit row around it, and folding the old Decisions list into
   * this one means the story has one telling, not two.
   */
  const history = useMemo(() => {
    const entries: { at: number; key: string; audit: StoredAuditPass | null; decision: PromotionDecision | null }[] = [];
    for (const a of audits) entries.push({ at: a.startedAt, key: a.id, audit: a, decision: null });
    const covered = new Set(audits.map((a) => a.candidateId).filter((x): x is string => x !== null));
    for (const d of decisions) {
      if (!covered.has(d.candidateId)) entries.push({ at: d.decidedAt, key: d.id, audit: null, decision: d });
    }
    return entries.sort((a, b) => b.at - a.at);
  }, [audits, decisions]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[20px] font-semibold">AXIOM</h1>
            <span className="truncate text-[12px]" style={{ color: "var(--text-faint)" }}>
              agent intelligence, diagnostics &amp; evolution
            </span>
          </div>
          <p className="mt-1 text-[13px] font-medium" style={{ color: "var(--text-dim)" }}>
            See how your assistant is really doing — then improve it, one proven change at a time.
          </p>
          {/* The one workflow, in the order the screen is used. This is the answer to "how do I use
              this" sitting at the top, because a first-time reader should never have to derive the
              loop from the controls. */}
          <ol
            data-testid="axiom-how-to"
            aria-label="How to use AXIOM, in four steps"
            className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]"
            style={{ color: "var(--text-dim)" }}
          >
            {HOW_TO.map((step, i) => (
              <li key={step} className="flex items-center gap-1.5">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                  style={{ background: "var(--surface-2)", color: "var(--accent)" }}
                >
                  {i + 1}
                </span>
                <span>{step}</span>
                {i < HOW_TO.length - 1 && <span aria-hidden style={{ color: "var(--text-faint)" }}>→</span>}
              </li>
            ))}
          </ol>
          <details className="mt-2 max-w-3xl text-[12px]" style={{ color: "var(--text-faint)" }}>
            <summary className="cursor-pointer select-none">What happens under the hood</summary>
            <p className="mt-1 leading-relaxed">
              Reads what the Assistant actually did, measures it against a task suite whose expectations check the
              transcript rather than the agent's own account, finds the root cause of what went wrong, proposes one
              bounded change, re-measures, and promotes it only if the numbers moved past the noise floor and nothing
              that used to work stopped working. Eval runs are confined to <span className="mono">{EVAL_DIR_NAME}</span>{" "}
              inside your workspace root and cost real tokens — you are asked before the first call.
            </p>
          </details>
        </div>
        {/* What the Assistant is running with right now — a version id only if the store holds one as
            active, never a label that sounds like a version. */}
        <div
          data-testid="axiom-active-version"
          className="shrink-0 rounded-lg border px-3 py-2 text-right"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Running version</div>
          <div className="mono mt-0.5 max-w-[220px] truncate text-[12px]" title={activeId ?? undefined}>
            {activeId ?? "built-in configuration"}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Model to evaluate"
          className={`${inputCls} min-w-[220px]`}
          style={inputStyle}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">model…</option>
          {model && !modelOptions.some((o) => o.id === model) && <option value={model}>{model}</option>}
          {modelOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
          repeats
          <input
            aria-label="Repeats per task"
            type="number"
            min={1}
            max={5}
            className={`${inputCls} w-16`}
            style={inputStyle}
            value={repeats}
            onChange={(e) => setRepeats(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
          />
        </label>
        <Button onClick={() => setShowSuite(true)} ariaLabel="Edit the task suite">Suite</Button>
        <span className="grow" />
        {estimate && (
          <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
            {estimate.calls} call(s){estimate.usd === null ? " · cost unknown" : ` · ~$${estimate.usd.toFixed(4)}`}
          </span>
        )}
        {running ? (
          <Button variant="danger" onClick={() => controller.current?.abort()}>Stop</Button>
        ) : (
          <Button variant="primary" onClick={() => void run()}>Audit &amp; improve</Button>
        )}
      </div>

      {running && progress && (
        <p className="mono mb-3 text-[11px]" style={{ color: "var(--text-dim)" }} role="status">{progress}…</p>
      )}
      {error && (
        <pre role="alert" className="mb-3 whitespace-pre-wrap rounded border p-2 font-sans text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          {error}
        </pre>
      )}

      {/* Two columns on wide screens: the pipeline and its numbers on the left, the rail — what
          just happened and what to do next — on the right. Below the breakpoint the rail drops
          under, because a summary nobody reaches without scrolling past the tables is worse than
          no summary. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <Stepper stages={stages} />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              testId="axiom-metric-pass"
              label="Baseline pass rate"
              value={measured ? pct(measured.passRate) : "—"}
              fraction={measured ? measured.passRate : null}
              color={
                measured
                  ? measured.passRate >= 1
                    ? "var(--success)"
                    : measured.passRate === 0
                      ? "var(--danger)"
                      : "var(--text)"
                  : "var(--text-faint)"
              }
              sub={
                report
                  ? `${report.baseline.tasks.length} task(s) × ${report.baseline.repeats}${
                      report.candidateResult ? ` · candidate ${pct(report.candidateResult.passRate)}` : ""
                    }`
                  : measured
                    ? `last measured ${fmtTime(measured.endedAt)}`
                    : "no measurement yet"
              }
            />
            <MetricCard
              testId="axiom-metric-findings"
              label="Findings recorded"
              value={String(findings.length)}
              fraction={null}
              color={
                findings.some(isSerious) ? "var(--danger)" : findings.length > 0 ? "var(--warn)" : "var(--text)"
              }
              sub={findings.length === 0 ? "no detector has fired" : `${findings.filter(isSerious).length} major or worse`}
            />
            <MetricCard
              testId="axiom-metric-tokens"
              label="Tokens per attempt"
              value={
                measured && measuredAttempts > 0
                  ? Math.round((measured.cost.promptTokens + measured.cost.completionTokens) / measuredAttempts).toLocaleString()
                  : "—"
              }
              fraction={null}
              color={measured && measuredAttempts > 0 ? "var(--text)" : "var(--text-faint)"}
              sub={measured && measuredAttempts > 0 ? "measured, not assumed" : "run an audit to measure"}
            />
            <MetricCard
              testId="axiom-metric-versions"
              label="Versions kept"
              value={String(versions.length)}
              fraction={null}
              color="var(--text)"
              sub={activeId ? `the Assistant runs ${activeId}` : "the Assistant runs its built-in configuration"}
            />
          </div>

          {/* The mockup's "Improvement plan": the Design stage's proposals as a table. Impact and
              Effort in a plan table are usually guesses; here the target metric is the closest real
              thing to an impact, the effort column is the actuator the proposal would actually
              touch, and the status is what happened to it this pass — nothing is invented. */}
          <Section title="Improvement plan">
            <div data-testid="axiom-plan">
              {report ? (
                report.proposals.length > 0 ? (
                  <table className="w-full">
                    <thead>
                      <tr className="h-[28px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                        <th className="w-10 font-medium">#</th>
                        <th className="font-medium">Action</th>
                        <th className="w-32 font-medium">Target</th>
                        <th className="w-28 font-medium">Effort</th>
                        <th className="w-40 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.proposals.map((p, i) => {
                        const status = planStatus(report, p);
                        return (
                          <tr key={p.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                            <td className="mono py-1.5 text-[12px]">{i + 1}</td>
                            <td className="py-1.5 pr-3 text-[12px]">
                              <b>{p.title}</b>
                              <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>{p.rationale}</div>
                            </td>
                            <td className="mono py-1.5 pr-3 text-[11px]" style={{ color: "var(--text-dim)" }}>{p.targetMetric ?? "—"}</td>
                            <td className="mono py-1.5 pr-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
                              {p.patch ? "prompt patch" : p.loop ? `loop.${p.loop.field}` : "—"}
                            </td>
                            <td className="py-1.5 text-[11px]" style={{ color: status.color }}>{status.label}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                    Nothing was proposed this pass — the diagnosis found nothing worth a bounded change.
                  </p>
                )
              ) : (
                <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                  Run an audit — the plan lists what AXIOM proposes to change, most important first.
                </p>
              )}
            </div>
          </Section>

          {report ? <Report rep={report} /> : !running ? (
            <EmptyState title="Pick a model and run an audit. Nothing is changed until a candidate survives the guardian and all four roles." />
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-4" aria-label="Recent activity and next steps">
          <section data-testid="axiom-health" className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Agent health</h2>
            {report && report.capabilityMap.length >= 3 ? (
              <Radar caps={report.capabilityMap} />
            ) : (
              <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                {report
                  ? "The radar needs three or more capabilities to draw."
                  : "Run an audit — the radar draws each capability's measured pass rate."}
              </p>
            )}
          </section>

          <section data-testid="axiom-activity" className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Recent activity</h2>
            {activity.length === 0 ? (
              <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                Nothing recorded yet. Runs, findings, versions and decisions all land here as they happen.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {activity.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="border-l-2 pl-2" style={{ borderColor: e.color }}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium" style={{ color: e.color }}>{e.label}</span>
                      <span className="shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>{fmtTime(e.at)}</span>
                    </div>
                    {e.detail && (
                      <div className="truncate text-[11px]" style={{ color: "var(--text-dim)" }} title={e.detail}>{e.detail}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Entry points, not new logic: every button calls the same handler its full-page
              counterpart calls, and one renders only when the state it acts on exists. A quick
              action that re-implemented its handler would be a second place to get it wrong. */}
          <section data-testid="axiom-quick-actions" className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Quick actions</h2>
            <div className="flex flex-col gap-1.5">
              <Button variant="primary" onClick={() => void run()} ariaLabel="Run a full audit" disabled={running}>
                {running ? "Running…" : "Run full audit"}
              </Button>
              <Button onClick={() => setShowSuite(true)} ariaLabel="Edit the task suite">Edit the task suite</Button>
              {candidate && (
                <>
                  <Button onClick={() => void changeState(candidate.id, "active")} ariaLabel={`Promote candidate ${candidate.id}`}>
                    Promote candidate
                  </Button>
                  <Button variant="danger" onClick={() => void changeState(candidate.id, "retired")} ariaLabel={`Retire candidate ${candidate.id}`}>
                    Retire candidate
                  </Button>
                </>
              )}
              {versions.length > 0 && (
                <Button onClick={() => void rollBack()} ariaLabel="Roll back to the previous version">Roll back</Button>
              )}
            </div>
          </section>

          <section data-testid="axiom-next-step" className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Next step</h2>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-dim)" }}>{nextStep}</p>
          </section>
        </aside>
      </div>

      <Section title={`Capability map${report ? ` (${report.capabilityMapOf})` : ""}`}>
        {report && report.capabilityMap.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="h-[28px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                <th className="font-medium">Capability</th>
                <th className="w-28 font-medium">State</th>
                <th className="w-20 font-medium">Pass</th>
                <th className="w-16 font-medium">Tasks</th>
                <th className="w-24 font-medium">Overclaims</th>
                <th className="font-medium">Detectors</th>
              </tr>
            </thead>
            <tbody>
              {report.capabilityMap.map((c) => (
                <tr key={c.capability} className="h-[32px] border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="mono text-[12px]">{c.capability}</td>
                  <td className="text-[12px]" style={{ color: c.state === "overclaimed" || c.state === "absent" ? "var(--danger)" : c.state === "unreliable" ? "var(--warn)" : "var(--success)" }}>
                    {describeCapabilityState(c.state)}
                  </td>
                  <td className="mono text-[12px]">{pct(c.passRate)}</td>
                  <td className="mono text-[12px]">{c.tasks}</td>
                  {/* The column a pass rate hides: said it was done, and the transcript disagreed. */}
                  <td className="mono text-[12px]" style={{ color: c.overclaimRuns > 0 ? "var(--danger)" : "var(--text-faint)" }}>{c.overclaimRuns}</td>
                  <td className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>{c.findings.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>Run an audit — the map is built from the suite's attempts.</p>
        )}
      </Section>

      <Section title={`Versions (${versions.length})`}>
        {versions.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            No versions yet. The Assistant is running its built-in prompt and loop parameters.
          </p>
        ) : (
          <>
            <div className="mb-2">
              <Button onClick={() => void rollBack()} ariaLabel="Roll back to the previous version">Roll back</Button>
            </div>
            <table className="w-full">
              <thead>
                <tr className="h-[28px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  <th className="font-medium">Id</th>
                  <th className="w-24 font-medium">State</th>
                  <th className="w-28 font-medium">Parent</th>
                  <th className="w-32 font-medium">Created</th>
                  <th className="font-medium">Why it exists</th>
                  <th className="w-40 font-medium" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                    <td className="mono py-1.5 text-[11px]">{v.id}</td>
                    <td className="py-1.5"><StateChip state={v.state} /></td>
                    <td className="mono py-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>{v.parentId ?? "—"}</td>
                    <td className="py-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>{fmtTime(v.createdAt)}</td>
                    <td className="py-1.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                      {v.reason}
                      <span className="mono ml-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
                        · {v.config.loop.maxIterations} steps · {v.config.loop.verificationNudgeMax} demand(s)
                        {v.decisionId ? ` · ${v.decisionId}` : ""}
                      </span>
                    </td>
                    <td className="py-1.5">
                      <span className="flex gap-1">
                        {v.state !== "active" && (
                          <Button onClick={() => void changeState(v.id, "active")} ariaLabel={`Promote version ${v.id}`}>Promote</Button>
                        )}
                        {v.state === "active" && (
                          <Button onClick={() => void changeState(v.id, "retired")} ariaLabel={`Retire version ${v.id}`}>Retire</Button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title={`Findings (${findings.length})`}>
        {findings.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>Nothing recorded. Findings are never deleted — one that stops recurring is evidence the fix worked.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="h-[28px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                <th className="w-36 font-medium">Detector</th>
                <th className="w-16 font-medium">Severity</th>
                <th className="w-24 font-medium">Root cause</th>
                <th className="w-14 font-medium">Runs</th>
                <th className="w-28 font-medium">Last seen</th>
                <th className="font-medium">What it says</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                  <td className="mono py-1.5 text-[11px]">{f.detector}</td>
                  <td className="py-1.5 text-[11px]" style={{ color: f.severity === "critical" || f.severity === "major" ? "var(--danger)" : "var(--text-dim)" }}>{f.severity}</td>
                  <td className="mono py-1.5 text-[11px]">{f.rootCause}</td>
                  <td className="mono py-1.5 text-[12px]">{f.occurrences}</td>
                  <td className="py-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>{fmtTime(f.recordedAt)}</td>
                  <td className="py-1.5 text-[12px]">
                    {f.title}
                    {/* The rationale is the differential that chose the cause. Without it a root cause
                        is an opinion, and "the model is weak" is an opinion a user would spend money on. */}
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
                      {f.rationale}{f.differential ? "" : " · inferred from one transcript, not measured across models"}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`History (${history.length} pass${history.length === 1 ? "" : "es"})`}>
        {history.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            No audit has run yet. Every pass lands here when it ends — completed, declined, stopped or failed —
            so the next session can read what this one did.
          </p>
        ) : (
          <ol data-testid="axiom-history" className="flex flex-col gap-0">
            {history.map((e) => (
              <li key={e.key} className="relative pl-6">
                <span
                  aria-hidden
                  className="absolute left-[5px] top-4 h-2.5 w-2.5 rounded-full"
                  style={{ background: entryTone(e).color, outline: "2px solid var(--surface)" }}
                />
                {e.at !== history[history.length - 1]?.at && (
                  <span aria-hidden className="absolute left-[10px] top-6 bottom-0 w-px" style={{ background: "var(--border)" }} />
                )}
                {e.audit ? (
                  <AuditEntry audit={e.audit} onAutopsy={openAutopsy} onOpen={openAuditReport} />
                ) : null}
                {e.decision ? <DecisionEntry decision={e.decision} /> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title={`Recorded runs (${traces.length})`}>
        {traces.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>No agent runs recorded yet. Use the Assistant, or run an audit — eval runs land here too.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="h-[28px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                <th className="w-40 font-medium">Run</th>
                <th className="w-16 font-medium">Status</th>
                <th className="w-16 font-medium">Steps</th>
                <th className="w-20 font-medium">Tokens</th>
                <th className="w-32 font-medium">Started</th>
                <th className="font-medium">Prompt</th>
                <th className="w-24 font-medium" />
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.id} className="h-[32px] border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="mono text-[11px]">{t.id}</td>
                  <td className="text-[11px]" style={{ color: t.status === "ok" ? "var(--success)" : t.status === "running" ? "var(--text-faint)" : "var(--danger)" }}>{t.status}</td>
                  <td className="mono text-[11px]">{t.steps.length}</td>
                  <td className="mono text-[11px]">{t.promptTokens + t.completionTokens}</td>
                  <td className="text-[11px]" style={{ color: "var(--text-dim)" }}>{fmtTime(t.startedAt)}</td>
                  <td className="truncate text-[12px]" style={{ color: "var(--text-dim)" }} title={t.prompt ?? undefined}>{t.prompt ?? "—"}</td>
                  <td><Button onClick={() => void openAutopsy(t.id)} ariaLabel={`Open the autopsy for run ${t.id}`}>Autopsy</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {showSuite && (
        <Modal title="Task suite" onClose={() => setShowSuite(false)} width={720}>
          <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
            Every expectation is checked against the transcript — the tools called, the status the run ended in,
            the text produced — never against what the agent says about itself. Editing this changes what AXIOM
            measures; it does not change the agent.
          </p>
          <textarea
            aria-label="Suite JSON"
            className={`${inputCls} mono h-[46vh] w-full`}
            style={inputStyle}
            value={suiteText}
            onChange={(e) => setSuiteText(e.target.value)}
            spellCheck={false}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" onClick={() => setShowSuite(false)}>Done</Button>
            <Button onClick={() => setSuiteText(DEFAULT_SUITE_JSON)} ariaLabel="Restore the default suite">Restore default</Button>
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>{suiteProblems(suiteText)}</span>
          </div>
        </Modal>
      )}

      {consent && (
        <Modal
          title="This run spends money"
          width={520}
          // Closing is a decline. Leaving the promise unresolved would hang the eval forever, and a
          // modal whose ✕ silently abandons a run is a modal nobody trusts twice.
          onClose={() => { consent.answer(false); setConsent(null); }}
        >
          <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
            AXIOM is about to run the agent on purpose, repeatedly, to produce a number:{" "}
            <b>{consent.estimate.calls} model call(s)</b> on <span className="mono">{consent.estimate.model}</span>{" "}
            ({consent.estimate.tasks} task(s) × {consent.estimate.repeats} repeat(s)), each assuming{" "}
            {consent.estimate.assumedTokensPerCall.prompt} prompt and {consent.estimate.assumedTokensPerCall.completion} completion tokens.
          </p>
          <p className="mb-3 text-[12px]" style={{ color: consent.estimate.usd === null ? "var(--warn)" : "var(--text)" }}>
            {consent.estimate.usd === null
              ? "The cost is unknown: no price is published for this model, so no figure is shown rather than a wrong one."
              : `Estimated cost: $${consent.estimate.usd.toFixed(4)}.`}
          </p>
          <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
            A baseline is reused instead of re-run whenever the same suite, model and version were already measured,
            so a second audit of an unchanged configuration spends less than the first.
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => { consent.answer(true); setConsent(null); }}>Allow these calls</Button>
            <Button variant="danger" onClick={() => { consent.answer(false); setConsent(null); }}>Decline</Button>
          </div>
        </Modal>
      )}

      {autopsyRun && (
        <Modal title={`Autopsy — ${autopsyRun}`} onClose={() => { setAutopsyRun(null); setAutopsy(null); }} width={760}>
          {!autopsy ? (
            <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>Reading the run…</p>
          ) : (
            <>
              <p className="mb-1 text-[12px]">
                <b>{autopsy.status}</b> · <span className="mono">{autopsy.model}</span>
                {autopsy.cause ? <> · root cause <span className="mono">{autopsy.cause}</span></> : null}
              </p>
              <p className="mb-2 text-[12px]" style={{ color: "var(--text-dim)" }}>{autopsy.verdict}</p>
              {autopsy.prompt && <p className="mono mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>prompt: {autopsy.prompt}</p>}
              <div className="flex flex-col gap-1">
                {autopsy.lines.map((l) => (
                  <div key={l.seq} className="rounded border p-1.5" style={{ borderColor: "var(--border)" }}>
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>#{l.seq}</span>
                      <span className="mono text-[11px]">{l.kind}{l.label ? ` · ${l.label}` : ""}</span>
                      {l.gapMs !== null && <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>+{l.gapMs}ms</span>}
                      {l.ok === false && <span className="text-[10px]" style={{ color: "var(--danger)" }}>failed</span>}
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--text-dim)" }}>{l.summary}</div>
                    {/* Stored model and tool output: untrusted text, rendered as text. Never markup. */}
                    {l.detail && <pre className="mono mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px]" style={{ color: "var(--text-faint)" }}>{l.detail}{l.truncated ? " …(truncated in storage)" : ""}</pre>}
                    {l.annotations.map((a, i) => (
                      <div key={i} className="mt-0.5 text-[11px]" style={{ color: "var(--warn)" }}>{a}</div>
                    ))}
                  </div>
                ))}
              </div>
              {autopsy.blindSpots.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>What this cannot tell you</div>
                  <ul className="flex flex-col gap-0.5">
                    {autopsy.blindSpots.map((b, i) => <li key={i} className="text-[11px]" style={{ color: "var(--text-dim)" }}>{b}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

/** One labelled panel. A heading and a border, so the sections below stay readable rather than nested. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>{title}</h2>
      {children}
    </section>
  );
}

/** The seven stages in the order the pipeline runs them. Names and hints only — the state under
 *  each is computed from the report, never assumed. */
const STAGES = [
  { n: "1", name: "Observe", hint: "read the recorded runs" },
  { n: "2", name: "Evaluate", hint: "run the suite" },
  { n: "3", name: "Diagnose", hint: "find root causes" },
  { n: "4", name: "Design", hint: "propose one bounded change" },
  { n: "5", name: "Modify", hint: "build the candidate" },
  { n: "6", name: "Validate", hint: "guardian + four roles" },
  { n: "7", name: "Evolve", hint: "promote or reject" },
] as const;

/** The four steps a first-time reader needs, in the order the screen is used. The dense mechanism
 *  text moved into a collapsed details — context on demand, not a wall before the first action. */
const HOW_TO = [
  "Pick a model",
  "Press Audit & improve — you approve the cost first",
  "Read the stepper, cards and plan",
  "Promote the candidate — or roll back",
] as const;

/**
 * The four honest statuses a proposal can carry. A plan table's "Impact" and "Effort" are usually
 * guesses; here the effort column is the actuator the proposal would actually touch (chosen by the
 * caller), and the status is what happened to it this pass — proposed, blocked, attempted, or built
 * into the candidate that came out of it.
 */
function planStatus(rep: ImproveReport, p: ImproveReport["proposals"][number]): { label: string; color: string } {
  if (rep.attempted?.id === p.id) {
    return rep.candidate
      ? { label: "built into the candidate", color: "var(--success)" }
      : { label: "attempted this pass", color: "var(--info)" };
  }
  if (p.blockedReason) return { label: `blocked — ${p.blockedReason}`, color: "var(--warn)" };
  return { label: "proposed", color: "var(--text-dim)" };
}

type StageTone = "idle" | "done" | "warn" | "fail";
interface StageState {
  tone: StageTone;
  note: string;
}

const stageToneColor: Record<StageTone, string> = {
  idle: "var(--text-faint)",
  done: "var(--success)",
  warn: "var(--warn)",
  fail: "var(--danger)",
};

const isSerious = (f: { severity: string }) => f.severity === "critical" || f.severity === "major";

/** The pipeline drawn as the shape it runs in. Each stage's note is one real sentence — a count, a
 *  verdict, or "waiting" when no report exists yet. The connecting line is presentation; the states
 *  are data. */
function Stepper({ stages }: { stages: StageState[] }) {
  return (
    <ol data-testid="axiom-stepper" aria-label="The seven stages of an AXIOM pass" className="mb-4 flex items-start">
      {STAGES.map((s, i) => {
        const st = stages[i]!;
        return (
          <li key={s.n} className="min-w-0 flex-1">
            <div className="flex items-center">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium"
                style={{
                  borderColor: stageToneColor[st.tone],
                  color: stageToneColor[st.tone],
                  background: st.tone === "idle" ? "transparent" : "var(--surface-2)",
                }}
              >
                {s.n}
              </span>
              {i < STAGES.length - 1 && (
                <span aria-hidden className="mx-1.5 h-px min-w-2 flex-1" style={{ background: "var(--border)" }} />
              )}
            </div>
            <div className="mt-1.5 pr-2">
              <div className="text-[12px] font-medium" style={{ color: st.tone === "idle" ? "var(--text-faint)" : "var(--text)" }}>
                {s.name}
              </div>
              <div className="truncate text-[11px]" style={{ color: "var(--text-faint)" }} title={st.note}>
                {st.tone === "idle" && st.note === "waiting" ? s.hint : st.note}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One metric, drawn as a ring gauge like the reference design. `fraction` is the only thing the arc
 * is allowed to encode: a real 0..1 measurement, or `null` — and `null` draws a full ring as the
 * card's frame, the same decorative role the reference design gives its latency and cost rings. A
 * count has no fraction, so inventing one for visual variety would be the lie this screen exists
 * to catch.
 */
function MetricCard({ label, value, sub, color, testId, fraction }: { label: string; value: string; sub: string; color: string; testId: string; fraction: number | null }) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const frac = fraction === null ? 1 : Math.max(0, Math.min(1, fraction));
  return (
    <div data-testid={testId} className="flex items-center gap-3 rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0" aria-hidden>
        <circle cx="26" cy="26" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="5" />
        <circle
          cx="26"
          cy="26"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${frac * C} ${C}`}
          transform="rotate(-90 26 26)"
        />
      </svg>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>{label}</div>
        <div className="text-[18px] font-semibold leading-tight" style={{ color }}>{value}</div>
        <div className="truncate text-[11px]" style={{ color: "var(--text-dim)" }} title={sub}>{sub}</div>
      </div>
    </div>
  );
}

/** The radar behind the health panel: one axis per capability, radius = its measured pass rate. */
function Radar({ caps }: { caps: ImproveReport["capabilityMap"] }) {
  const n = caps.length;
  const cx = 120;
  const cy = 120;
  const R = 84;
  const pt = (i: number, v: number): [number, number] => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v];
  };
  const worst = caps.some((c) => c.state === "overclaimed" || c.state === "absent")
    ? "var(--danger)"
    : caps.some((c) => c.state === "unreliable")
      ? "var(--warn)"
      : "var(--success)";
  const at = (v: number) => caps.map((_, i) => pt(i, v).join(",")).join(" ");
  return (
    // The viewBox extends past the drawing on every side so edge axis labels (drawn outside the
    // R ring at 1.22×) are not clipped by the viewport.
    <svg viewBox="-28 -6 296 252" width="100%" role="img" aria-label="Radar of pass rate by capability">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <polygon key={g} points={at(g)} fill="none" stroke="var(--border)" strokeWidth="1" />
      ))}
      {caps.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth="1" />;
      })}
      {/* The 4% floor keeps a zero-pass capability visible as a point at its axis rather than a
          vertex collapsed onto the center, which would read as "missing axis". */}
      <polygon
        points={caps.map((c, i) => pt(i, Math.max(0.04, c.passRate)).join(",")).join(" ")}
        fill={worst}
        fillOpacity="0.18"
        stroke={worst}
        strokeWidth="2"
      />
      {caps.map((c, i) => {
        const [x, y] = pt(i, Math.max(0.04, c.passRate));
        return <circle key={i} cx={x} cy={y} r="3" fill={worst} />;
      })}
      {caps.map((c, i) => {
        const [x, y] = pt(i, 1.22);
        return (
          <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="var(--text-dim)">
            {c.capability.length > 14 ? `${c.capability.slice(0, 13)}…` : c.capability}
          </text>
        );
      })}
    </svg>
  );
}

function StateChip({ state }: { state: AgentVersion["state"] }) {
  const color =
    state === "active" ? "var(--success)" : state === "rejected" ? "var(--danger)" : state === "candidate" ? "var(--info)" : "var(--text-faint)";
  return <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color }}>{state}</span>;
}

/**
 * A stored audit report is trusted structurally, not blindly: completed passes hold a full
 * `ImproveReport`, the other endings hold `{error}`, and a guard is cheaper than a render that
 * throws on a shape the store did not write.
 */
function isImproveReport(doc: Record<string, unknown>): boolean {
  return "observation" in doc && "baseline" in doc && "diagnosis" in doc;
}

/** The dot color and one-line verdict a timeline entry is remembered by. */
function entryTone(e: { audit: StoredAuditPass | null; decision: PromotionDecision | null }): { color: string; label: string } {
  const a = e.audit;
  if (a) {
    if (a.status === "completed") {
      if (a.decision === "promote") return { color: "var(--success)", label: `promoted ${shortId(a.candidateId)}` };
      if (a.decision === "reject") return { color: "var(--danger)", label: "candidate rejected" };
      return { color: "var(--text-faint)", label: "completed — nothing promoted" };
    }
    if (a.status === "refused") return { color: "var(--warn)", label: "refused — the spend was declined" };
    if (a.status === "aborted") return { color: "var(--warn)", label: "stopped part way" };
    return { color: "var(--danger)", label: "failed" };
  }
  const d = e.decision!;
  return d.decision === "promote"
    ? { color: "var(--success)", label: `promoted ${shortId(d.candidateId)}` }
    : { color: "var(--danger)", label: "candidate rejected" };
}

const shortId = (id: string | null) => (id ? (id.length > 10 ? `…${id.slice(-8)}` : id) : "—");

/** The delta chips a decision report carries. */
type AuditDelta = {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  beyondNoise: boolean;
};

/** One audit pass on the timeline: verdict, delta chips, and the pass's own seven-stage summary. */
function AuditEntry({
  audit,
  onAutopsy,
  onOpen,
}: {
  audit: StoredAuditPass;
  onAutopsy: (runId: string) => void;
  onOpen: (id: string) => void;
}) {
  const tone = entryTone({ audit, decision: null });
  const [loadedReport, setLoadedReport] = useState<ImproveReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  // The list sends metadata plus the two small fields the row renders. The seven-stage body is
  // fetched only when the reader expands it — a timeline row must not pull an 8 MB report.
  const rep =
    loadedReport ??
    (audit.report && isImproveReport(audit.report) ? (audit.report as unknown as ImproveReport) : null);
  const error =
    audit.reportError ?? (typeof audit.report?.error === "string" ? audit.report.error : null);
  let listedDeltas: AuditDelta[] = [];
  if (audit.reportDeltas) {
    try {
      const parsed: unknown = JSON.parse(audit.reportDeltas);
      if (Array.isArray(parsed)) listedDeltas = parsed as AuditDelta[];
    } catch {
      // A malformed chip list is not worth losing the row over.
    }
  }
  const deltas = rep?.decision?.deltas ?? listedDeltas;
  const ensureReport = async () => {
    if (rep || loadingReport) return;
    setLoadingReport(true);
    const full = await axiomGetAudit(audit.id).catch(() => null);
    if (full?.report && isImproveReport(full.report)) {
      setLoadedReport(full.report as unknown as ImproveReport);
    }
    setLoadingReport(false);
  };
  return (
    <div className="border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12px] font-semibold" style={{ color: tone.color }}>{tone.label}</span>
        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
          {audit.suiteId ?? "—"} · {audit.model ?? "—"} · {fmtTime(audit.startedAt)}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: "var(--surface-2)", color: tone.color }}
        >
          {audit.status}
        </span>
      </div>
      {!rep && (
        <button
          type="button"
          onClick={() => onOpen(audit.id)}
          className="mt-1 text-[11px] underline"
          style={{ color: "var(--text-dim)" }}
        >
          open this pass's report
        </button>
      )}
      {error && <div className="mt-0.5 text-[11px]" style={{ color: "var(--danger)" }}>{error}</div>}
      {deltas.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {deltas.map((m) => (
            <span
              key={m.metric}
              className="mono rounded px-1.5 py-0.5 text-[10px]"
              style={{ background: "var(--surface-2)", color: m.beyondNoise ? "var(--text)" : "var(--text-faint)" }}
              title={`${m.baseline} → ${m.candidate}${m.beyondNoise ? "" : " · within noise"}`}
            >
              {m.metric} {m.delta >= 0 ? "+" : ""}{m.delta.toFixed(3)}{m.beyondNoise ? "" : " ·noise"}
            </span>
          ))}
        </div>
      )}
      {(rep || audit.status === "completed") && (
        <details
          className="mt-1"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void ensureReport();
          }}
        >
          <summary className="cursor-pointer select-none text-[11px]" style={{ color: "var(--text-faint)" }}>
            the pass in seven stages
          </summary>
          <div className="mt-1.5 pl-3">
            {loadingReport ? (
              <p className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                Loading the pass report…
              </p>
            ) : rep ? (
              <>
                <StageSummary rep={rep} />
                {rep.notDone.length > 0 && (
                  <div className="mt-1.5">
                    <div className="text-[11px] font-medium" style={{ color: "var(--warn)" }}>What this pass did not do</div>
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {rep.notDone.map((n, i) => (
                        <li key={i} className="text-[11px]" style={{ color: "var(--text-dim)" }}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <AutopsyLinks rep={rep} onAutopsy={onAutopsy} />
              </>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                The pass ended before a report existed — its suite, model and ending are the record.
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** The seven stages as one line each, from the stored report — the shape a pass took, compact. */
function StageSummary({ rep }: { rep: ImproveReport }) {
  const line = (n: string, name: string, text: string, color?: string) => (
    <li className="flex gap-2 text-[11px]" style={{ color: color ?? "var(--text-dim)" }}>
      <span className="mono w-16 shrink-0" style={{ color: "var(--text-faint)" }}>{n} {name}</span>
      <span>{text}</span>
    </li>
  );
  const guardian = rep.guardian;
  return (
    <ul className="flex flex-col gap-0.5">
      {line("01", "Observe", `${rep.observation.totals.runs} run(s) read · ${rep.observation.totals.toolCalls} tool call(s)`)}
      {line("02", "Evaluate", `baseline ${pct(rep.baseline.passRate)} on ${rep.baseline.tasks.length} task(s) × ${rep.baseline.repeats}${rep.candidateResult ? ` · candidate ${pct(rep.candidateResult.passRate)}` : ""}`)}
      {line("03", "Diagnose", rep.diagnosis.findings.length === 0 ? "no detector fired" : `${rep.diagnosis.findings.length} finding(s)`, rep.diagnosis.findings.some(isSerious) ? "var(--danger)" : undefined)}
      {line("04", "Design", rep.proposals.length === 0 ? "nothing to propose" : `${rep.proposals.length} proposal(s) — ${rep.proposals[0]?.title ?? ""}`)}
      {line("05", "Modify", rep.candidate ? `candidate ${shortId(rep.candidate.id)}` : "no candidate built")}
      {line("06", "Validate", guardian ? (guardian.passed ? "guardian passed" : "guardian refused") : "skipped", guardian && !guardian.passed ? "var(--danger)" : undefined)}
      {line("07", "Evolve", rep.decision ? (rep.decision.decision === "promote" ? `promoted ${shortId(rep.decision.candidateId)}` : `rejected ${shortId(rep.decision.candidateId)}`) : "no decision", rep.decision?.decision === "promote" ? "var(--success)" : rep.decision ? "var(--danger)" : undefined)}
    </ul>
  );
}

/** The eval runs this pass's numbers came from, each openable as an autopsy. */
function AutopsyLinks({ rep, onAutopsy }: { rep: ImproveReport; onAutopsy: (runId: string) => void }) {
  const runIds = [
    ...new Set(
      [...rep.baseline.attemptSummaries, ...(rep.candidateResult?.attemptSummaries ?? [])].map((a) => a.runId),
    ),
  ];
  if (runIds.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>Autopsy the runs:</span>
      {runIds.slice(0, 8).map((id) => (
        <Button key={id} onClick={() => onAutopsy(id)} ariaLabel={`Open the autopsy for run ${id}`}>
          …{id.slice(-6)}
        </Button>
      ))}
      {runIds.length > 8 && <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>+{runIds.length - 8} more in Recorded runs</span>}
    </div>
  );
}

/** A decision with no audit row around it — recorded before the ledger existed. */
function DecisionEntry({ decision: d }: { decision: PromotionDecision }) {
  return (
    <div className="border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12px] font-semibold" style={{ color: d.decision === "promote" ? "var(--success)" : "var(--danger)" }}>
          {d.decision === "promote" ? "promoted" : "rejected"} {shortId(d.candidateId)}
        </span>
        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
          over {shortId(d.baselineId)} · {d.model} · {fmtTime(d.decidedAt)}
        </span>
        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--text-faint)" }}>
          no audit record — decided outside a pass
        </span>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {d.deltas.map((m) => (
          <li key={m.metric} className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
            {m.metric}: {m.baseline} → {m.candidate} ({m.delta >= 0 ? "+" : ""}{m.delta.toFixed(3)})
            {m.beyondNoise ? "" : " · within noise"}
          </li>
        ))}
      </ul>
      <ul className="mt-1 flex flex-col gap-0.5">
        {d.checks.filter((c) => !c.passed).map((c) => (
          <li key={c.id} className="text-[11px]" style={{ color: "var(--danger)" }}>{c.label}: {c.detail}</li>
        ))}
        {d.roles.filter((r) => !r.approve).flatMap((r) => r.objections.map((o, i) => (
          <li key={`${r.role}-${i}`} className="text-[11px]" style={{ color: "var(--warn)" }}>{r.role}: {o}</li>
        )))}
      </ul>
    </div>
  );
}

/**
 * The report from one `improve` pass, in the order the stages ran.
 *
 * `notDone` is rendered first among the details rather than last: it is the part most likely to change
 * how the rest should be read, and a reader who scrolls past it will misread a reused baseline as a
 * fresh measurement.
 */
function Report({ rep }: { rep: ImproveReport }) {
  const t = rep.observation.totals;
  return (
    <div className="mb-5">
      <Section title="01 Observe — the agent's own history">
        <p className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
          {t.runs} run(s) · {t.ok} ok · {t.error} error · {t.stopped} stopped · {t.unfinished} never ended ·{" "}
          {t.toolCalls} tool call(s) · {t.totalTokens} tokens
          {t.durationMs === null ? " · no run reported an end" : ` · ${Math.round(t.durationMs / 1000)}s total`}
        </p>
      </Section>

      <Section title="02 Evaluate — the baseline">
        <p className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
          {pct(rep.baseline.passRate)} pass on {rep.baseline.tasks.length} task(s) ×{" "}
          {rep.baseline.repeats} repeat(s) · {rep.baseline.cost.promptTokens}+{rep.baseline.cost.completionTokens} tokens ·{" "}
          version {rep.baseline.versionId}
        </p>
        {/* The attempt count is here rather than only in `notDone` because a stopped run is the one
            case where the pass rate above is not of the whole suite: 0 of 8 attempts and 4 of 8
            both read as a percentage, and only this line tells them apart. */}
        {rep.baseline.attemptSummaries.length < rep.baseline.tasks.length * rep.baseline.repeats && (
          <p className="mono text-[11px]" style={{ color: "var(--warn)" }}>
            only {rep.baseline.attemptSummaries.length} of {rep.baseline.tasks.length * rep.baseline.repeats}{" "}
            attempts ran, so the pass rate above covers what completed — it was not used to judge anything
          </p>
        )}
        <table className="mt-1 w-full">
          <tbody>
            {rep.baseline.tasks.map((r) => (
              <tr key={r.taskId} className="h-[26px] border-t" style={{ borderColor: "var(--border)" }}>
                <td className="mono text-[11px]">{r.taskId}</td>
                <td className="mono text-[11px]" style={{ color: r.passRate >= 1 ? "var(--success)" : r.passRate === 0 ? "var(--danger)" : "var(--warn)" }}>
                  {r.passes}/{r.attempts}
                </td>
                <td className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                  {r.meanIterations.toFixed(1)} iters · {Math.round(r.meanTokens)} tokens
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`03 Diagnose — ${rep.diagnosis.findings.length} finding(s) from ${rep.diagnosis.runsExamined} run(s)`}>
        {rep.diagnosis.findings.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            No detector fired. {rep.diagnosis.runsClean} of {rep.diagnosis.runsExamined} examined runs were clean.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rep.diagnosis.findings.map((f) => (
              <li key={f.id} className="text-[12px]">
                <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{f.detector}</span>{" "}
                <b style={{ color: f.severity === "critical" || f.severity === "major" ? "var(--danger)" : undefined }}>{f.title}</b>{" "}
                <span style={{ color: "var(--text-dim)" }}>— cause: {f.rootCause}, {f.occurrences} run(s), {f.evidence.length} piece(s) of evidence</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`04 Design — ${rep.proposals.length} proposal(s)`}>
        <ul className="flex flex-col gap-1">
          {rep.proposals.map((p) => (
            <li key={p.id} className="text-[12px]">
              <b>{p.title}</b>{" "}
              <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                [{p.actuator}]{p.targetMetric ? ` → ${p.targetMetric}` : ""}
              </span>
              {rep.attempted?.id === p.id && <span className="ml-1 text-[11px]" style={{ color: "var(--info)" }}>← attempted</span>}
              <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>{p.rationale}</div>
              {p.patch && <pre className="mono mt-1 whitespace-pre-wrap rounded border p-1.5 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}>{p.patch.marker}: {p.patch.text}</pre>}
              {p.loop && <div className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>loop.{p.loop.field}: {p.loop.from} → {p.loop.to}</div>}
              {p.blockedReason && <div className="text-[11px]" style={{ color: "var(--warn)" }}>{p.blockedReason}</div>}
            </li>
          ))}
          {rep.proposals.length === 0 && <li className="text-[12px]" style={{ color: "var(--text-faint)" }}>Nothing to propose.</li>}
        </ul>
      </Section>

      {rep.guardian && (
        <Section title={`06 Validate — guardian ${rep.guardian.passed ? "passed" : "refused"}`}>
          <ul className="flex flex-col gap-0.5">
            {rep.guardian.checks.map((c) => (
              <li key={c.id} className="text-[11px]" style={{ color: c.passed ? "var(--text-dim)" : "var(--danger)" }}>
                {c.passed ? "✓" : "✕"} {c.label} — {c.detail}
              </li>
            ))}
          </ul>
          <ul className="mt-1 flex flex-col gap-0.5">
            {rep.guardian.deltas.map((m) => (
              <li key={m.metric} className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
                {m.metric}: {m.baseline} → {m.candidate} ({m.delta >= 0 ? "+" : ""}{m.delta.toFixed(3)}){m.beyondNoise ? "" : " · within noise"}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rep.decision && (
        <Section title="Roles">
          <ul className="flex flex-col gap-1">
            {rep.decision.roles.map((r) => (
              <li key={r.role} className="text-[12px]">
                <span className="mono text-[11px]">{r.role}</span>{" "}
                <span style={{ color: r.approve ? "var(--success)" : "var(--danger)" }}>{r.approve ? "approves" : "objects"}</span>
                {r.objections.map((o, i) => (
                  <div key={i} className="text-[11px]" style={{ color: "var(--text-dim)" }}>— {o}</div>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] font-semibold" style={{ color: rep.decision.decision === "promote" ? "var(--success)" : "var(--danger)" }}>
            07 Evolve: {rep.decision.decision === "promote"
              ? `promoted ${rep.decision.candidateId} — the next Assistant turn runs it.`
              : `rejected ${rep.decision.candidateId} — kept as 'rejected', not deleted, so the measurement behind it stays readable.`}
          </p>
        </Section>
      )}

      {rep.notDone.length > 0 && (
        <Section title="What AXIOM did not do">
          <ul className="flex flex-col gap-1">
            {rep.notDone.map((n, i) => (
              <li key={i} className="text-[12px]" style={{ color: "var(--warn)" }}>{n}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** `JSON.parse` that returns `null` instead of throwing, for the editor's live validity line. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The editor's one-line verdict, so a problem is found while typing rather than on Run. */
function suiteProblems(text: string): string {
  const parsed = parseSuite(safeJson(text));
  if (parsed.ok) return `${parsed.suite.tasks.length} task(s) — valid`;
  const first = parsed.errors[0];
  return safeJson(text) === null ? "not valid JSON yet" : `${parsed.errors.length} problem(s): ${first?.path} ${first?.message}`;
}

/**
 * The webview's implementation of AXIOM's ports — the seam between the engine and this app.
 *
 * `@aiprovider/axiom-core` performs no network I/O, holds no key and touches no database; everything
 * crosses a port. This module is where those ports become real: storage goes to the host's four
 * `axiom_*` tables through `store.ts`, traces come from `agent_runs`/`agent_steps`, and the runner is
 * the actual agent loop (see `./runner`).
 *
 * Two deliberate omissions:
 *
 * - **No `PricePort`.** The app can price a *served* call from its catalog, but an eval run's model
 *   is whatever the user picks and the price of a call that has not happened is not something this
 *   module should invent. Without a price port `estimateCost` returns `usd: null`, and the consent
 *   dialog then shows the call count and the per-call token assumption instead of a number — which is
 *   the port contract's point: "an unknown cost is never presented as free".
 * - **No `ConsentPort`** here either. Consent is a UI act, so the screen owns it and passes one in
 *   when it builds the pipeline; a ports module that answered its own consent question would be
 *   answering the only question invariant #7 says belongs to the user.
 */
import {
  type AxiomPorts,
  type ClockPort,
  type ConfigStorePort,
  type IdPort,
  type ResultStorePort,
  type TraceSourcePort,
} from "@aiprovider/axiom-core";
import {
  axiomActiveConfig,
  axiomGetTrace,
  axiomGetVersion,
  axiomLinkDecision,
  axiomListDecisions,
  axiomListFindings,
  axiomListSuiteResults,
  axiomListTraces,
  axiomListVersions,
  axiomPutDecision,
  axiomPutFindings,
  axiomPutSuiteResult,
  axiomPutVersion,
  axiomSetVersionState,
} from "../../store";
import { AGENT_SYSTEM } from "../chat/turn/prompt";
import { createEvalRunner, type EvalRunnerOptions } from "./runner";

/**
 * Ids that survive a restart. `createIdPort` in the engine is sequential and is for tests, where
 * predicting an id is the only way to assert an exact chain; a per-process counter in production
 * would hand two runs the same id after a reload, and the store refuses a taken id rather than
 * overwriting — so the second run would fail instead of quietly measuring over the first.
 *
 * Same shape as `newRunId` in the orchestrator, because it is the same problem solved twice.
 */
export function createHostIdPort(): IdPort {
  return {
    next: (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export const hostClock: ClockPort = { now: () => Date.now() };

export const hostTraces: TraceSourcePort = {
  listRuns: (o) => axiomListTraces(o?.limit ?? 200, o?.sessionId ?? null),
  getRun: (runId) => axiomGetTrace(runId),
};

export const hostConfigs: ConfigStorePort = {
  listVersions: () => axiomListVersions(),
  getVersion: (id) => axiomGetVersion(id),
  // There is no "get the active version" command: the host guarantees at most one row is active
  // (a partial unique index), and `axiom_active_config` is the read that already resolves it — the
  // same read a send uses, so the two cannot disagree about what is running.
  activeVersion: async () => {
    const { versionId } = await axiomActiveConfig();
    return versionId === null ? null : axiomGetVersion(versionId);
  },
  put: (v) => axiomPutVersion(v),
  setState: (id, state) => axiomSetVersionState(id, state),
  linkDecision: (versionId, decisionId) => axiomLinkDecision(versionId, decisionId),
  effectiveConfig: async () => (await axiomActiveConfig()).config,
  // The base a candidate is built on. `AGENT_SYSTEM` rather than a transcription of it: the patch
  // library appends to this text, and a copy in another package is a rule in two places.
  builtinPrompt: async () => AGENT_SYSTEM,
};

export const hostResults: ResultStorePort = {
  putSuiteResult: (r) => axiomPutSuiteResult(r),
  listSuiteResults: (o) => axiomListSuiteResults({ suiteId: o?.suiteId ?? null, versionId: o?.versionId ?? null }),
  putFindings: (f) => axiomPutFindings(f),
  listFindings: () => axiomListFindings(),
  putDecision: (d) => axiomPutDecision(d),
  listDecisions: () => axiomListDecisions(),
};

/**
 * The ports for one AXIOM session. Called per run rather than once at boot: the runner closes over the
 * workspace root and the session id, and both are the user's to change.
 */
export function createAxiomPorts(opts: EvalRunnerOptions): AxiomPorts {
  return {
    traces: hostTraces,
    runner: createEvalRunner(opts),
    configs: hostConfigs,
    results: hostResults,
    ids: createHostIdPort(),
    clock: hostClock,
  };
}

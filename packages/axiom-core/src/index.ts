/**
 * **AXIOM** — AI Agent Intelligence, Diagnostics & Evolution Engine.
 *
 * A supervisory layer over an AI agent: it reads what the agent did, measures it against tasks whose
 * expectations check the transcript rather than the agent's word, finds the root cause of what went
 * wrong, proposes one bounded change, re-measures, and promotes the change only if the numbers moved
 * past the noise floor and nothing that used to work stopped working.
 *
 * The rule underneath all of it, from the spec:
 *
 * > AXIOM must not mark an agent as improved merely because the agent says it has improved.
 *
 * Hard boundaries, inherited from `router-core` and enforced by the port shape: this package performs
 * **no network I/O**, holds **no API key**, and touches **no database**. It also never reimplements a
 * judgement the agent loop already makes — the host injects those predicates, so a rule lives in one
 * place.
 *
 * | Stage | Entry point |
 * |---|---|
 * | 01 Observe | `observe`, `deriveMetrics` |
 * | 02 Evaluate | `parseSuite`, `evaluateSuite`, `estimateCost` |
 * | 03 Diagnose | `runDetectors`, `diagnose`, `autopsy`, `buildCapabilityMap` |
 * | 04 Design | `design` |
 * | 05 Modify | `buildCandidate`, `applyPromptPatches` |
 * | 06 Validate | `runGuardian`, `conveneRoles` |
 * | 07 Evolve | `createAxiom(...).improve`, `.rollback` |
 */
export * from "./types";
export type {
  AxiomPorts,
  AgentRunnerPort,
  ClockPort,
  ConfigStorePort,
  ConsentPort,
  CostEstimate,
  IdPort,
  PricePort,
  ResultStorePort,
  TraceSourcePort,
} from "./ports";

export { claimsDone, deriveMetrics, pairInvocations, parseArgs, type DetectorPolicy } from "./trace";

export {
  DEFAULT_THRESHOLDS,
  DETECTORS,
  RESULT_TRUNCATION_CHARS,
  readsAsArgumentComplaint,
  resultWasTruncated,
  runDetectors,
  type DetectorHit,
  type DetectorInput,
  type DetectorThresholds,
} from "./detectors";

export { diagnose, findingId, observe, type DiagnoseInput, type DiagnoseReport, type ObservedRun } from "./diagnose";
export { autopsy, type Autopsy, type AutopsyLine } from "./autopsy";

export { describeExpectation, parseSuite, suiteSchema, type SuiteParseFailure, type SuiteParseResult } from "./suite";
export {
  ASSUMED_TOKENS_PER_CALL,
  DEFAULT_REPEATS,
  PaidRunRefusedError,
  authorizePaidRun,
  checkTask,
  estimateCost,
  evaluateSuite,
  type CostEstimateInput,
  type EvaluateOptions,
  type TaskCheck,
} from "./evaluate";

export { buildCapabilityMap, describeCapabilityState, toCapabilityAttempts, type CapabilityAttempt, type CapabilityMapInput } from "./capability";

export {
  PATCH_LIBRARY,
  PROMPT_CAP,
  VERIFICATION_NUDGE_HARD_MAX,
  applyPromptPatches,
  buildCandidate,
  countPatches,
  design,
  parsePromptPatches,
  patchChars,
  type CandidateInput,
  type CandidateResult,
  type LoopParamChange,
  type PatchApplication,
  type Proposal,
  type ProposalActuator,
  type PromptPatch,
  type PromptPatchBlock,
} from "./version";

export {
  DEFAULT_GUARDIAN,
  compareMetric,
  isComparableMetric,
  mean,
  runGuardian,
  stddev,
  type ComparableMetric,
  type GuardianInput,
  type GuardianOptions,
  type GuardianReport,
  type MetricComparison,
} from "./guardian";

export { conveneRoles, critique, investigate, reviewArchitecture, verify, type RoleInput } from "./roles";

export {
  BUILTIN_VERSION_ID,
  builtinVersionId,
  createAxiom,
  type Axiom,
  type AxiomConfig,
  type BenchmarkOutcome,
  type ImproveReport,
  type Observation,
  type ValidationResult,
} from "./pipeline";

export { MemoryConfigStore, MemoryResultStore, createClock, createIdPort } from "./inmemory";

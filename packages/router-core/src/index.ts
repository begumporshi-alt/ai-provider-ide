export type { AdapterManifest } from "@aiprovider/adapter-spec";
export { ManifestInterpreter, ManifestHttpError, type HttpPortLike, type AdapterContext, type ModelEntry, type TextArgs } from "./manifest-interpreter.js";
export { type AdapterInstance } from "./adapter-instance.js";
export { CodeAdapterInstance, SandboxError, lintCodeSource, type CodeAdapterOptions } from "./code-adapter.js";
export {
  generateCodeCandidate, reviewCodeCandidate, lintCodeManifest,
  type CodeGenerationDeps, type CodeReviewContext,
} from "./code-candidate.js";
export { selectAll, selectOne, parsePath } from "./jsonpath.js";
export { renderTemplate } from "./template.js";
export {
  BUILTIN_TEMPLATES, PROVIDER_PROFILES, PROVIDER_PROFILE_LABELS, profileForBaseUrl,
  type BuiltinTemplateId,
} from "./builtin-templates.js";
export { ProviderRegistry } from "./provider-registry.js";
export { HealthTracker } from "./health-tracker.js";
export { buildPlan, orderKeys, type Candidate, type PlanContext, type PlanInput } from "./route-planner.js";
export { ExecutionEngine, AllAttemptsFailedError, MAX_ATTEMPTS_DEFAULT, type AttemptOutcome, type TextExecution } from "./execution-engine.js";
export { ProviderLimiter, PER_PROVIDER_DEFAULT, MAX_PER_PROVIDER, clampConcurrency } from "./concurrency.js";
export { parsePricing, estimateCostMicros, priceRank, type PricingMicros } from "./pricing.js";
export { parseContextWindow, parseReasoningSupport, parseVisionSupport } from "./model-meta.js";
export {
  textOfContent,
  renderContentParts,
  shapeMessageContent,
  userContent,
  countImageParts,
  IMAGE_PLACEHOLDER,
  type ContentPartTemplates,
} from "./content-parts.js";
export {
  attachToolParts,
  blockField,
  isToolCallBlock,
  readToolCall,
  readToolCalls,
  shapeToolDeclarations,
  type ToolCallDiscriminator,
  type ToolCallShape,
  type ToolDeclarationTemplates,
  type ToolPartTemplates,
} from "./tool-shaping.js";
export {
  compressMessages,
  compressWithSummary,
  SUMMARY_LABEL,
  promptBudget,
  estimateTokens,
  estimateMessageTokens,
  DEFAULT_CONTEXT_WINDOW,
  CHARS_PER_TOKEN,
  RESERVE_FRACTION,
  type CompressResult,
} from "./context-compress.js";
export { UsageLedger, type LedgerEntry, type LedgerSource } from "./usage-ledger.js";
export { AdapterRuntime } from "./adapter-runtime.js";
export { ModelCatalog } from "./model-catalog.js";
export { ModelRouter, type AiTextPort, type RouterSettings, type SystemAiHealth } from "./model-router.js";
export * from "./ports.js";
export * from "./domain.js";
export * from "./errors.js";
export * from "./redaction.js";
export { runProbes, type ProbeReport, type ProbeAttempt } from "./probe-runner.js";
export { detectClientGate, clientGateNotice } from "./client-gate.js";
export { fingerprint, type FingerprintResult } from "./fingerprinter.js";
export { runContractSuite, type ContractReport, type ContractCheck, type ContractOptions } from "./contract-suite.js";
export {
  OnboardingOrchestrator, type OnboardingState, type OnboardingInput,
  type OnboardingSessionData, type OnboardingPersistence,
} from "./onboarding-orchestrator.js";
export {
  generateCandidates, lintManifest, fetchDocsExcerpt, redactionHash, extractJson,
  type RankedCandidate, type CandidateProgress, type CandidateStage, type GenerationDeps, type AuditRecord,
} from "./adapter-generator.js";
export { DriftMonitor, type DriftAttempt, type DriftEvidence, type DriftMonitorDeps } from "./drift-monitor.js";
export { RepairOrchestrator, type RepairPlan, type RepairDeps } from "./repair-orchestrator.js";
export {
  CONFIG_FORMAT_VERSION, validateImport,
  type ConfigExport, type ExportProviderRow, type ExportKeyRow, type ExportManifestRow,
  type ExportAliasRow, type ExportSettingRow, type ImportReport,
} from "./config.js";
// `gateway-normalizer.ts` and `gateway-client-detector.ts` are deliberately **not** re-exported.
// Both were ported to Rust (`core/gateway_normalizer.rs`) and the port is what serves requests —
// `core/router_bridge.rs` is the call site — so the TypeScript is kept only as the frozen reference
// the port is measured against. Nothing in this repo imports either module except its own spec, and
// they were re-exported here until 2026-09-27. An export with no importer is a promise the package
// cannot keep: a consumer reaching for one would have been reaching for code no request path runs.
// See the module header of `gateway-normalizer.ts` before changing anything in either file.

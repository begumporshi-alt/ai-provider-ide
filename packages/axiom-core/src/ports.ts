/**
 * AXIOM's ports — the same discipline `router-core` holds: this package performs **no network
 * I/O**, holds **no API key**, and touches **no database** itself. Everything crosses a port,
 * implemented by the Tauri host in production and by fakes in tests.
 *
 * One port deserves its comment up front, because it encodes an invariant rather than a
 * convenience. `ConsentPort` exists because invariant #7 says a *paid* validation call requires
 * explicit consent with an estimated cost — and AXIOM's Evaluate and Validate stages are exactly
 * that: they run the agent, on purpose, repeatedly, to produce a number. An audit tool that
 * silently spends the user's money to prove the user's agent wastes money would be the joke it
 * is investigating. So a paid run is refused unless consent comes back true.
 */
import type {
  AgentConfig,
  AgentVersion,
  EvalTask,
  Finding,
  PromotionDecision,
  RunTrace,
  SuiteResult,
  VersionState,
} from "./types";

/** Reads the agent's own history. In production this is `agent_runs` + `agent_steps`. */
export interface TraceSourcePort {
  listRuns(opts?: { limit?: number; sinceTs?: number; sessionId?: string | null }): Promise<RunTrace[]>;
  getRun(runId: string): Promise<RunTrace | null>;
}

/**
 * Runs one eval task through the agent and returns the trace it produced.
 *
 * `paid` is a property of the runner, not of the call: a fixture-backed runner costs nothing and
 * needs no consent, a runner that reaches a provider does. Declaring it lets the pipeline gate
 * the right runs instead of gating all of them — gating everything would push people to bypass
 * the gate, which is worse than not having one.
 */
export interface AgentRunnerPort {
  readonly paid: boolean;
  run(req: {
    task: EvalTask;
    model: string;
    config: AgentConfig;
    signal?: AbortSignal;
  }): Promise<RunTrace>;
}

/** The version chain, including the one configuration the agent actually runs with. */
export interface ConfigStorePort {
  listVersions(): Promise<AgentVersion[]>;
  getVersion(id: string): Promise<AgentVersion | null>;
  activeVersion(): Promise<AgentVersion | null>;
  put(v: AgentVersion): Promise<void>;
  setState(id: string, state: VersionState): Promise<void>;
  linkDecision(versionId: string, decisionId: string): Promise<void>;
  /**
   * What the agent would run with *right now*. Read rather than derived from `activeVersion`,
   * because the two disagree whenever a human edits the prompt in the UI — and AXIOM proposing a
   * change against a baseline the agent is not using is a change measured against nothing.
   */
  effectiveConfig(): Promise<AgentConfig>;
  /**
   * The built-in `AGENT_SYSTEM`, as the host defines it. A port rather than a copy: the prompt
   * patch library appends to this text, and a second transcription of it in this package would be a
   * rule in two places — the one that rots is always the copy.
   */
  builtinPrompt(): Promise<string>;
}

/** Findings, suite results and decisions. Separate from the version chain: results are evidence, versions are state. */
export interface ResultStorePort {
  putSuiteResult(r: SuiteResult): Promise<void>;
  listSuiteResults(opts?: { versionId?: string; suiteId?: string }): Promise<SuiteResult[]>;
  putFindings(f: Finding[]): Promise<void>;
  /** Every finding AXIOM has recorded. Findings are never deleted: a finding that stops recurring
   *  is evidence the fix worked, and deleting it would destroy that evidence. */
  listFindings(): Promise<Finding[]>;
  putDecision(d: PromotionDecision): Promise<void>;
  listDecisions(): Promise<PromotionDecision[]>;
}

/**
 * Identifier minting. A port rather than `Date.now() + Math.random()` inline, for the reason the
 * data model chapter gives: an id that must be unique for the database's lifetime must not come
 * from a per-process counter, and it must be replaceable in tests so a fixture can assert an
 * exact id.
 */
export interface IdPort {
  next(prefix: string): string;
}

export interface ClockPort {
  now(): number;
}

/**
 * Pricing. Returns `undefined` for a model with no known price — deliberately not `0`, because
 * "this costs nothing" and "we cannot tell what this costs" lead to opposite decisions and a
 * default erases the difference.
 */
export interface PricePort {
  estimate(model: string, promptTokens: number, completionTokens: number): { usd: number } | undefined;
}

export interface CostEstimate {
  model: string;
  tasks: number;
  repeats: number;
  calls: number;
  /** Null when any part of the estimate is unknown. An unknown cost is never presented as free. */
  usd: number | null;
  /** Per-task token assumption the estimate was built from, so the user can see the arithmetic. */
  assumedTokensPerCall: { prompt: number; completion: number };
}

export interface ConsentPort {
  request(estimate: CostEstimate): Promise<boolean>;
}

export interface AxiomPorts {
  traces: TraceSourcePort;
  runner: AgentRunnerPort;
  configs: ConfigStorePort;
  results: ResultStorePort;
  ids: IdPort;
  clock: ClockPort;
  /** Required before any paid run; optional so a fixture-backed pipeline needs neither. */
  prices?: PricePort;
  consent?: ConsentPort;
}

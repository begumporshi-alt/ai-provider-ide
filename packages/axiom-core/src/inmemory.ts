/**
 * In-memory implementations of the store ports.
 *
 * These are **not persistent** and say so in the name. They exist for three reasons: unit tests, the
 * browser shim that drives the real UI under Playwright, and a first run of AXIOM against an agent
 * whose host has not wired the tables yet. In all three the correct behaviour is "works, and loses
 * everything on reload" — which is fine for a decision that is re-derivable and not fine for a
 * version chain anyone intends to keep, so the production host implements the same ports over SQLite.
 *
 * The version chain is the one place where losing state has teeth, and it is handled rather than
 * ignored: at most one version may be `active`, enforced on every `setState`, because two active
 * versions is a configuration with no answer to "what is the agent running".
 */
import type { AgentVersion, Finding, PromotionDecision, SuiteResult, VersionState } from "./types";
import type { ClockPort, ConfigStorePort, IdPort, ResultStorePort } from "./ports";

export class MemoryConfigStore implements ConfigStorePort {
  private readonly versions = new Map<string, AgentVersion>();
  private readonly builtin: string;

  constructor(builtinPrompt: string) {
    this.builtin = builtinPrompt;
  }

  async listVersions(): Promise<AgentVersion[]> {
    return [...this.versions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getVersion(id: string): Promise<AgentVersion | null> {
    return this.versions.get(id) ?? null;
  }

  async activeVersion(): Promise<AgentVersion | null> {
    for (const v of this.versions.values()) if (v.state === "active") return v;
    return null;
  }

  async put(v: AgentVersion): Promise<void> {
    if (this.versions.has(v.id)) throw new Error(`version ${v.id} already exists — versions are immutable`);
    this.versions.set(v.id, structuredClone(v));
  }

  async setState(id: string, state: VersionState): Promise<void> {
    const v = this.versions.get(id);
    if (!v) throw new Error(`no version ${id}`);
    if (state === "active") {
      for (const other of this.versions.values()) {
        if (other.id !== id && other.state === "active") other.state = "retired";
      }
    }
    v.state = state;
  }

  async linkDecision(versionId: string, decisionId: string): Promise<void> {
    const v = this.versions.get(versionId);
    if (!v) throw new Error(`no version ${versionId}`);
    v.decisionId = decisionId;
  }

  async effectiveConfig(): Promise<AgentVersion["config"]> {
    const active = await this.activeVersion();
    return active ? structuredClone(active.config) : { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } };
  }

  async builtinPrompt(): Promise<string> {
    return this.builtin;
  }
}

export class MemoryResultStore implements ResultStorePort {
  private readonly results: SuiteResult[] = [];
  private readonly findings = new Map<string, Finding>();
  private readonly decisions: PromotionDecision[] = [];

  async putSuiteResult(r: SuiteResult): Promise<void> {
    this.results.push(structuredClone(r));
  }

  async listSuiteResults(opts?: { versionId?: string; suiteId?: string }): Promise<SuiteResult[]> {
    return this.results
      .filter((r) => (opts?.versionId ? r.versionId === opts.versionId : true))
      .filter((r) => (opts?.suiteId ? r.suiteId === opts.suiteId : true))
      .map((r) => structuredClone(r));
  }

  async putFindings(f: Finding[]): Promise<void> {
    for (const x of f) this.findings.set(x.id, structuredClone(x));
  }

  async listFindings(): Promise<Finding[]> {
    return [...this.findings.values()].map((f) => structuredClone(f));
  }

  async putDecision(d: PromotionDecision): Promise<void> {
    this.decisions.push(structuredClone(d));
  }

  async listDecisions(): Promise<PromotionDecision[]> {
    return this.decisions.map((d) => structuredClone(d));
  }
}

export function createClock(start = 1_700_000_000_000, step = 1000): ClockPort {
  let t = start;
  return { now: () => (t += step) };
}

/**
 * Sequential ids with a fixed boot marker. A real host mints ids that survive a restart; a test needs
 * ids it can predict, and predicting them is the only way to assert an exact chain.
 */
export function createIdPort(bootMarker = "test"): IdPort {
  let n = 0;
  return { next: (prefix) => `${prefix}-${bootMarker}-${(n += 1)}` };
}

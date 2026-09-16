/**
 * onboarding-orchestrator (L3, §2.1): the deterministic pipeline state machine.
 *   collect_input → probing → fingerprinting → template_instantiated → contract_testing →
 *   pending_registration → human_confirmation → enabled
 * Every transition persists the session (state + redacted inputs — NEVER the key) so the
 * wizard resumes after an app restart. The AI path (ai_generating/linting) is Phase 4; a
 * fingerprint miss ends in `failed` with guidance until then.
 */

import type { AdapterManifest } from "@aiprovider/adapter-spec";
import type { HttpPortLike } from "./manifest-interpreter.js";
import { runProbes, type ProbeReport } from "./probe-runner.js";
import { fingerprint, type FingerprintResult } from "./fingerprinter.js";
import type { ContractReport } from "./contract-suite.js";

export type OnboardingState =
  | "collect_input"
  | "probing"
  | "fingerprinting"
  | "template_instantiated"
  | "ai_generating"
  | "linting"
  | "contract_testing"
  | "pending_registration"
  | "human_confirmation"
  | "enabled"
  | "failed";

export interface OnboardingInput {
  name: string;
  baseUrl: string;
  docsUrl?: string;
}

/** What may be persisted/shown — the API key is NOT here by design (§2.3). */
export interface OnboardingSessionData {
  input: OnboardingInput;
  state: OnboardingState;
  probeReport?: ProbeReport; // already redacted by probe-runner (shapes only)
  fingerprint?: FingerprintResult;
  manifest?: AdapterManifest;
  contract?: ContractReport;
  failureReason?: string;
  updatedAt: number;
}

export interface OnboardingPersistence {
  /** Persist the session; the host stores it in onboarding_sessions. */
  save(data: OnboardingSessionData): Promise<void>;
  /** Latest non-terminal session, if any (resume support). */
  loadLatest(): Promise<OnboardingSessionData | null>;
}

export class OnboardingOrchestrator {
  constructor(
    private readonly http: HttpPortLike,
    private readonly persistence: OnboardingPersistence,
    private data: OnboardingSessionData = { input: { name: "", baseUrl: "" }, state: "collect_input", updatedAt: Date.now() },
  ) {}

  get session(): OnboardingSessionData {
    return this.data;
  }

  private async transition(state: OnboardingState, patch: Partial<OnboardingSessionData> = {}): Promise<void> {
    this.data = { ...this.data, ...patch, state, updatedAt: Date.now() };
    await this.persistence.save(this.data);
  }

  async start(input: OnboardingInput): Promise<ProbeReport> {
    if (!input.name.trim() || !/^https?:\/\//.test(input.baseUrl)) {
      throw new Error("name and an http(s) base URL are required");
    }
    await this.transition("probing", {
      input,
      probeReport: undefined,
      fingerprint: undefined,
      manifest: undefined,
      contract: undefined,
      failureReason: undefined,
    });
    const report = await runProbes(this.http, input.baseUrl);
    await this.transition("fingerprinting", { probeReport: report });
    return report;
  }

  async identify(): Promise<FingerprintResult> {
    if (!this.data.probeReport) throw new Error("probe report missing — run start() first");
    const result = fingerprint(this.data.probeReport);
    if (result.dialect === "unknown" || !result.template) {
      await this.transition("failed", {
        fingerprint: result,
        failureReason:
          "No known dialect matched the probe results. Deterministic setup covers OpenAI- and Anthropic-compatible APIs. " +
          "AI-assisted adapter generation arrives in Phase 4 (unlocks after your first provider is live).",
      });
      return result;
    }
    await this.transition("template_instantiated", { fingerprint: result, manifest: result.template });
    return result;
  }

  /** The AI path adopted a generated manifest: record it and move to the contract step. */
  async adoptGeneratedManifest(manifest: AdapterManifest): Promise<void> {
    await this.transition("ai_generating", { manifest });
    await this.transition("linting", { manifest });
    await this.transition("template_instantiated", { manifest });
  }

  /** Free contract checks run automatically; paid ones need explicit consent (§2.2). */
  async setContract(report: ContractReport): Promise<void> {
    await this.transition("contract_testing", { contract: report });
  }

  async confirmRegistration(): Promise<void> {
    if (!this.data.manifest) throw new Error("no manifest to register");
    if (this.data.contract && !this.data.contract.freePassed) {
      throw new Error("free contract checks did not pass — review the failing assertions");
    }
    await this.transition("pending_registration");
    await this.transition("human_confirmation");
  }

  async enable(): Promise<void> {
    await this.transition("enabled");
  }

  async fail(reason: string): Promise<void> {
    await this.transition("failed", { failureReason: reason });
  }

  async resume(data: OnboardingSessionData): Promise<void> {
    this.data = data;
    await this.persistence.save(data);
  }
}

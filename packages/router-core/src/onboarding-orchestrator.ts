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
import { runProbes, type ProbeAttempt, type ProbeReport } from "./probe-runner.js";
import { fingerprint, type FingerprintResult } from "./fingerprinter.js";
import { profileForBaseUrl } from "./builtin-templates.js";
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
  /**
   * Request headers to send on every probe, and to carry into the manifest setup registers.
   *
   * This is how a **client gate** is answered during setup. Such a gateway refuses the caller before
   * it reads any credential, so the probe cannot see past it — and the probe runs before any
   * manifest exists, so a per-provider header has nowhere else to live at this point. Measured
   * 2026-09-29 on `agentrouter.org`, which answers `401 unauthorized_client_error` to every path
   * unless the `User-Agent` names a client it serves.
   */
  extraHeaders?: Record<string, string>;
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

  /**
   * Options for the probe phase.
   *
   * `onAttempt` streams each probe result as it lands, so the wizard can render the attempt log
   * live instead of after the whole matrix finishes (up to 9 sequential requests). `signal` lets
   * the operator cancel mid-probe: `runProbes` returns a partial report when aborted, so this
   * re-raises the abort itself — a partial matrix must never reach the fingerprinter and masquerade
   * as a decided dialect.
   */
  async start(
    input: OnboardingInput,
    opts?: { onAttempt?: (a: ProbeAttempt) => void; signal?: AbortSignal },
  ): Promise<ProbeReport> {
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
    const report = await runProbes(this.http, input.baseUrl, opts?.onAttempt, opts?.signal, input.extraHeaders);
    opts?.signal?.throwIfAborted();
    await this.transition("fingerprinting", { probeReport: report });
    return report;
  }

  async identify(): Promise<FingerprintResult> {
    if (!this.data.probeReport) throw new Error("probe report missing — run start() first");
    const result = fingerprint(this.data.probeReport);
    if (result.dialect === "unknown" || !result.template) {
      // **A host already measured beats a probe that provably cannot decide.**
      //
      // A gateway serving *both* `/messages` and `/chat/completions` defeats the anthropic rule
      // ("a messages endpoint exists AND no chat-completions") by construction, so the verdict is
      // `unknown` no matter how well the probe went. Measured 2026-09-29: `agentrouter.org` returns
      // `401` on both routes once the client-gate header is supplied, both therefore "exist", and
      // no unauthenticated signal is left to break the tie.
      //
      // So this does not try to break it. It answers a question that does have an answer — is this
      // a host whose dialect we have already measured? — and uses that profile instead of a guess.
      //
      // A client gate is deliberately excluded. It means the probe never reached the provider, so
      // the operator still has a header to supply, and the gate panel is where they supply it;
      // resolving the dialect now would present a working-looking provider that cannot be reached.
      const known = result.clientGate ? undefined : profileForBaseUrl(this.data.input.baseUrl);
      if (known) {
        const resolved: FingerprintResult = {
          dialect: known.templateId,
          template: known.manifest,
          evidence: [
            ...result.evidence,
            `no probe result decided the dialect, but this host is a known provider (${known.slug}) ` +
              `whose route has already been measured — using its built-in profile`,
          ],
        };
        await this.transition("template_instantiated", {
          fingerprint: resolved,
          manifest: known.manifest,
        });
        return resolved;
      }
      await this.transition("failed", {
        fingerprint: result,
        // **A client gate gets its own sentence, because the generic one would be wrong twice.**
        // "No known dialect matched" invites the operator to conclude their provider is unsupported,
        // and — worse — to go looking at their key, which the provider never read. What actually
        // happened is that the caller was refused, and the remedy is a header, not a different
        // provider.
        failureReason: result.clientGate
          ? `The gateway refused this client before reading any credential (${result.clientGate}). ` +
            `No probe result is usable, so the dialect could not be determined. This gateway serves ` +
            `only specific clients — add the User-Agent it expects under the provider's custom ` +
            `headers and run auto setup again.`
          : "No known dialect matched the probe results. Deterministic setup covers OpenAI- and Anthropic-compatible APIs. " +
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

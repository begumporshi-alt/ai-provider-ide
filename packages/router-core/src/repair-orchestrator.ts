/**
 * repair flow (L3, §2.10): the repair pipeline for a drifted provider.
 *
 * mark repairing (failover keeps serving) → re-probe (free) → deterministic
 * re-fingerprint first → if that can't fix it, the Generator produces a PATCH manifest
 * (current manifest + new redacted report + failing assertions, excludeProviderIds=[P])
 * → contract suite gates the candidate → staged as a new manifest VERSION →
 * HUMAN CONFIRMATION → hot-swap in adapter-runtime → previous version kept for rollback.
 *
 * Single-provider caveat (§2.10): if the drifted provider is the ONLY one, AI-assisted
 * repair has no candidate model (it's excluded) — deterministic re-fingerprint only.
 */
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import type { HttpPortLike } from "./manifest-interpreter.js";
import { runProbes, type ProbeReport } from "./probe-runner.js";
import { fingerprint } from "./fingerprinter.js";
import { generateCandidates, type RankedCandidate } from "./adapter-generator.js";
import { runContractSuite, type ContractReport } from "./contract-suite.js";
import type { AiTextPort } from "./model-router.js";
import type { ContractCheck } from "./contract-suite.js";

export interface RepairPlan {
  providerId: string;
  providerSlug: string;
  name: string;
  baseUrl: string;
  currentVersion: number;
  evidence: string[]; // drift trigger summary + failing assertions
  candidate?: RankedCandidate; // ai-generated patch (contract-checked, not yet active)
  deterministic?: AdapterManifest; // re-fingerprint result
  status: "planned" | "no_ai_available" | "no_fix_found";
}

export interface RepairDeps {
  http: HttpPortLike;
  ai: AiTextPort;
  systemLabel: string;
  currentManifest: AdapterManifest;
  currentVersion: number;
  provider: { id: string; slug: string; name: string; baseUrl: string };
  secretRef: string;
  /** Other enabled providers that could serve — decides whether AI repair is possible. */
  otherHealthyProviders: number;
  failingChecks: ContractCheck[];
  signal?: AbortSignal;
  audit?: (e: { modelUsed: string; promptChars: number; completionChars: number; redactionHash: string }) => Promise<void>;
}

export class RepairOrchestrator {
  constructor(private readonly deps: RepairDeps) {}

  async plan(): Promise<RepairPlan> {
    const { provider, failingChecks } = this.deps;
    const evidence = [
      `${provider.name}: ${failingChecks.length} failing contract check(s): ` +
        failingChecks.map((c) => c.name).join(", "),
    ];
    // 1. re-probe (free)
    const report: ProbeReport = await runProbes(this.deps.http, provider.baseUrl, undefined, this.deps.signal);
    // 2. deterministic re-fingerprint FIRST (no AI, no cost)
    const fp = fingerprint(report);
    if (fp.template) {
      const deterministic = fp.template;
      evidence.push(`re-fingerprint matched: ${fp.dialect}`);
      const contract = await this.runChecks(deterministic);
      if (contract.freePassed) {
        evidence.push("deterministic re-fingerprint passes free contract checks");
        return {
          providerId: provider.id, providerSlug: provider.slug, name: provider.name,
          baseUrl: provider.baseUrl, currentVersion: this.deps.currentVersion,
          evidence, deterministic, status: "planned",
        };
      }
      evidence.push("deterministic template failed contract checks — falling through to AI patch");
    } else {
      evidence.push("re-fingerprint: no known dialect matched");
    }
    // 3. AI patch — needs a second healthy provider (exclusion rule, §2.8/§2.9)
    if (this.deps.otherHealthyProviders === 0) {
      evidence.push("AI-assisted repair needs a second healthy provider (none configured) — deterministic fix unavailable");
      return {
        providerId: provider.id, providerSlug: provider.slug, name: provider.name,
        baseUrl: provider.baseUrl, currentVersion: this.deps.currentVersion,
        evidence, status: "no_ai_available",
      };
    }
    const candidates = await generateCandidates({
      ai: this.deps.ai,
      systemLabel: this.deps.systemLabel,
      report,
      baseUrl: provider.baseUrl,
      secretRef: this.deps.secretRef,
      excludeProviderIds: [provider.id],
      http: this.deps.http, // without this, candidates skip contract checks entirely
      feedback: `The provider ${provider.slug} previously worked with this adapter:\n` +
        `${JSON.stringify(this.deps.currentManifest)}\n` +
        `It now FAILS these contract checks: ${failingChecks.map((c) => `${c.name} (${c.detail ?? "no detail"})`).join("; ")}.\n` +
        `Produce a corrected manifest for the NEW response shape observed in the probe report above.`,
      n: 2,
      audit: this.deps.audit,
      signal: this.deps.signal,
    });
    const usable = candidates.find((c) => c.manifest && c.freePasses > 0);
    if (!usable) {
      evidence.push("AI candidates failed contract checks");
      return {
        providerId: provider.id, providerSlug: provider.slug, name: provider.name,
        baseUrl: provider.baseUrl, currentVersion: this.deps.currentVersion,
        evidence, status: "no_fix_found",
      };
    }
    evidence.push(`candidate ${usable.id}: ${usable.contract?.checks.filter((c) => c.pass && !c.paid).length ?? 0} free checks passed`);
    return {
      providerId: provider.id, providerSlug: provider.slug, name: provider.name,
      baseUrl: provider.baseUrl, currentVersion: this.deps.currentVersion,
      evidence, candidate: usable, status: "planned",
    };
  }

  private async runChecks(manifest: AdapterManifest): Promise<ContractReport> {
    const { ManifestInterpreter } = await import("./manifest-interpreter.js");
    const interp = new ManifestInterpreter(manifest, { http: this.deps.http, vars: { appUrl: "https://aiprovider.ide" } });
    return runContractSuite(interp, { secretRef: this.deps.secretRef, consent: { text: false, image: false } });
  }
}

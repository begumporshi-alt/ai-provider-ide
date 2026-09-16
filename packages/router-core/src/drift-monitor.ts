/**
 * drift-monitor (L3, §2.10): sliding-window provider-drift detection from the attempt
 * stream. Trigger: >= minErrors drift-class errors within the window affecting
 * >= minModels distinct models, AND at least one of the failed requests would have
 * succeeded through another provider (isolates provider-side change from our own bug).
 *
 * Detection is rate-limited (one trigger per provider per cooldownMs) and side-effect free:
 * it only calls onTrigger — the caller decides marking-repairing / re-probe / notifications.
 */
import { DRIFT_CLASSES, type ErrorClass } from "./errors.js";

export interface DriftAttempt {
  providerId: string;
  providerSlug: string;
  model: string; // native id at that provider
  requestedModel: string; // what the caller asked for (alias/bare/qualified)
  cls: ErrorClass;
  ts: number;
}

export interface DriftEvidence {
  providerId: string;
  providerSlug: string;
  errors: number;
  models: string[];
  windowMs: number;
  detectedAt: number;
}

export interface DriftMonitorDeps {
  windowMs?: number; // default 15 min
  minErrors?: number; // default 5
  minModels?: number; // default 2
  cooldownMs?: number; // default 1 h — at most one auto re-probe per provider per hour
  now?: () => number;
  onTrigger: (e: DriftEvidence) => void;
  /** Did this requested model recently succeed via a DIFFERENT provider? (§2.10) */
  succeededElsewhere: (requestedModel: string, excludeProviderId: string) => boolean;
}

export class DriftMonitor {
  private attempts: DriftAttempt[] = [];
  private lastTrigger = new Map<string, number>();
  private readonly windowMs: number;
  private readonly minErrors: number;
  private readonly minModels: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DriftMonitorDeps) {
    this.windowMs = deps.windowMs ?? 15 * 60_000;
    this.minErrors = deps.minErrors ?? 5;
    this.minModels = deps.minModels ?? 2;
    this.cooldownMs = deps.cooldownMs ?? 60 * 60_000;
    this.now = deps.now ?? (() => Date.now());
  }

  observe(a: DriftAttempt): void {
    if (!DRIFT_CLASSES.has(a.cls)) return;
    this.attempts.push(a);
    this.prune();
    this.evaluate(a.providerId);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.attempts = this.attempts.filter((a) => a.ts >= cutoff);
  }

  evaluate(providerId: string): void {
    this.prune();
    const now = this.now();
    const last = this.lastTrigger.get(providerId);
    if (last !== undefined && now - last < this.cooldownMs) return; // rate limit: one auto repair per provider per hour
    const mine = this.attempts.filter((a) => a.providerId === providerId);
    const models = [...new Set(mine.map((a) => a.model))];
    if (mine.length < this.minErrors || models.length < this.minModels) return;
    // provider-side vs our bug: at least one failed request must be one another provider
    // could have served recently.
    const isolated = mine.some((a) => this.deps.succeededElsewhere(a.requestedModel, providerId));
    if (!isolated) return;
    this.lastTrigger.set(providerId, now);
    const evidence: DriftEvidence = {
      providerId,
      providerSlug: mine[mine.length - 1]!.providerSlug,
      errors: mine.length,
      models,
      windowMs: this.windowMs,
      detectedAt: now,
    };
    this.deps.onTrigger(evidence);
  }

  /** Manual "Repair provider" bypasses the cooldown (still requires confirmation downstream). */
  forceClearCooldown(providerId: string): void {
    this.lastTrigger.delete(providerId);
  }

  /** Test/state hook. */
  reset(): void {
    this.attempts = [];
    this.lastTrigger.clear();
  }
}

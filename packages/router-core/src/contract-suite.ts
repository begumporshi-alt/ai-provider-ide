/**
 * contract-suite (L1, §2.1 step 4): conformance tests a candidate manifest must pass before
 * registration. FREE checks run automatically; PAID checks (minimal text / image generation)
 * only behind explicit user consent (§2.2 — never automatic). Runs against the
 * key-blind AdapterInstance seam, so a declarative manifest and a sandboxed code adapter
 * (§2.7) are gated by exactly the same checks.
 *
 * Test dimensions: auth (ping), models (listModels parses), text (max_tokens:1), image
 * (smallest, only if the manifest claims image support).
 */

import type { AdapterInstance } from "./adapter-instance.js";

export interface ContractCheck {
  name: string;
  pass: boolean;
  paid: boolean;
  detail?: string;
}

export interface ContractReport {
  checks: ContractCheck[];
  allPassed: boolean; // free checks must pass; paid checks pass if consented and green
  freePassed: boolean;
}

export interface ContractOptions {
  secretRef: string;
  /** Consent gate: each paid test only runs if the user opted in. */
  consent: { text: boolean; image: boolean };
  /** Model ids to use for the paid probes (from listModels; free picks the first if unset). */
  textModel?: string;
  imageModel?: string;
  signal?: AbortSignal;
}

export async function runContractSuite(
  adapter: AdapterInstance,
  opts: ContractOptions,
): Promise<ContractReport> {
  const checks: ContractCheck[] = [];

  // 1. ping + model list (free)
  let models: string[] = [];
  try {
    const ping = await adapter.pingKey(opts.secretRef, opts.signal);
    checks.push({
      name: "auth: model list with this key",
      pass: ping.ok,
      paid: false,
      detail: ping.ok ? undefined : (ping.message ?? `HTTP ${ping.status}`),
    });
    if (ping.ok) {
      const entries = await adapter.listModels(opts.secretRef, opts.signal);
      models = entries.map((e) => e.nativeId);
      const sane = models.length > 0 && models.every((m) => typeof m === "string" && m.length > 0 && m.length < 200);
      checks.push({
        name: `models: catalog parses (${models.length} models)`,
        pass: sane,
        paid: false,
        detail: sane ? undefined : "model list empty or ids look wrong",
      });
    }
  } catch (e) {
    checks.push({ name: "auth: model list with this key", pass: false, paid: false, detail: String((e as Error).message).slice(0, 200) });
  }

  // 2. minimal text generation (PAID — consent)
  if (opts.consent.text && models.length) {
    const model = opts.textModel ?? models[0]!;
    try {
      let text = "";
      for await (const chunk of adapter.generateText(
        opts.secretRef,
        { model, messages: [{ role: "user", content: "ping" }], stream: false, maxTokens: 1 },
        opts.signal,
      )) {
        text += chunk;
      }
      checks.push({ name: `text: minimal completion (${model})`, pass: true, paid: true, detail: `${text.length} chars` });
    } catch (e) {
      checks.push({
        name: `text: minimal completion (${model})`,
        pass: false,
        paid: true,
        detail: String((e as Error).message).slice(0, 200),
      });
    }
  } else if (opts.consent.text) {
    checks.push({ name: "text: minimal completion", pass: false, paid: true, detail: "no models to test with" });
  }

  // 3. minimal image generation (PAID — consent, only if the manifest claims images)
  if (opts.consent.image && adapter.capabilities().image) {
    const imageModel =
      opts.imageModel ??
      models.find((m) => adapter.tagModality(m) === "image") ??
      adapter.tagModality(models[0] ?? "") === "image"
        ? models[0]
        : undefined;
    if (imageModel) {
      try {
        const res = await adapter.generateImage(
          opts.secretRef,
          { model: imageModel, prompt: "a single white pixel" },
          opts.signal,
        );
        checks.push({
          name: `image: minimal generation (${imageModel})`,
          pass: res.ok && Boolean(res.base64 || res.url),
          paid: true,
          detail: res.ok ? undefined : (res.errorBody ?? `HTTP ${res.status}`).slice(0, 200),
        });
      } catch (e) {
        checks.push({
          name: `image: minimal generation (${imageModel})`,
          pass: false,
          paid: true,
          detail: String((e as Error).message).slice(0, 200),
        });
      }
    } else {
      checks.push({ name: "image: minimal generation", pass: false, paid: true, detail: "no image-tagged model found" });
    }
  }

  const free = checks.filter((c) => !c.paid);
  const paid = checks.filter((c) => c.paid);
  const freePassed = free.every((c) => c.pass);
  // allPassed: every free check green AND every consented paid check green.
  // Non-consented paid checks don't block registration (they're skipped, not failed).
  const allPassed = freePassed && paid.every((c) => c.pass);
  return { checks, allPassed, freePassed };
}

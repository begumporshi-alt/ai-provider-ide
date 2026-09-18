/**
 * adapter-generator (L1, §2.5/§2.8): turns a redacted probe report + optional docs excerpt
 * into RANKED, LINTED candidate manifests via the System AI (AiTextPort).
 *
 * The AI's only creative act is choosing paths/mappings. Everything around it is
 * deterministic gates, in order: zod schema -> lint (host pinned to the user's input —
 * invariant 4; request-field whitelist — a hostile manifest cannot smuggle body params)
 * -> free contract checks against the real provider. Best-of-N: three varied prompts;
 * rarely do all three hallucinate the same mapping.
 */

import { ADAPTER_MANIFEST_V1_1, REQUEST_FIELD_WHITELIST, type AdapterManifest } from "@aiprovider/adapter-spec";
import { parsePath } from "./jsonpath.js";
import { ManifestInterpreter, type HttpPortLike } from "./manifest-interpreter.js";
import { runContractSuite, type ContractReport } from "./contract-suite.js";
import { scrubStrings } from "./redaction.js";
import { BUILTIN_TEMPLATES } from "./builtin-templates.js";
import type { ProbeReport } from "./probe-runner.js";
import type { AiTextPort } from "./model-router.js";

export type CandidateStage = "parsing" | "schema" | "lint" | "contract" | "scored" | "rejected";

export interface CandidateProgress {
  id: string;
  stage: CandidateStage;
  detail?: string;
}

export interface RankedCandidate {
  id: string; // "A" | "B" | "C" for declarative; "JS" for a Tier-2 code candidate
  schemaErrors: string[];
  lintErrors: string[];
  manifest?: AdapterManifest;
  contract?: ContractReport;
  /** free contract checks passed (0 = unusable) */
  freePasses: number;
  score: number;
  rejectedReason?: string;
  /** Tier-2 only (§2.7): the sandbox compile gate — the module actually compiled inside
   *  QuickJS-WASM before the free contract checks ran on it. */
  code?: { compiled: boolean; compileError?: string };
}

export interface AuditRecord {
  modelUsed: string;
  promptChars: number;
  completionChars: number;
  redactionHash: string;
}

export interface GenerationDeps {
  ai: Pick<AiTextPort, "complete">;
  systemLabel: string; // model id surfaced to the user + audit
  report: ProbeReport;
  baseUrl: string; // the USER-entered baseUrl; lint pins manifests to it
  secretRef: string; // the wizard's key (for free contract checks)
  excludeProviderIds: string[]; // §2.8 rule 3: never serve through the adapter being built
  docsUrl?: string;
  http?: HttpPortLike; // needed for docs fetch + contract checks
  n?: number;
  feedback?: string;
  maxTokens?: number;
  timeoutMs?: number;
  onProgress?: (p: CandidateProgress) => void;
  audit?: (e: AuditRecord) => Promise<void>;
  signal?: AbortSignal;
}

// ---------- prompt pack (§2.5) ----------

const SCHEMA_SUMMARY = `A manifest JSON object with:
- manifestVersion: 1
- dialect: a short name like "custom-v1"
- provider: { baseUrl: string, auth: { headers: [{ name, prefix? }] } }  // "prefix {{secret}}" placeholders are substituted host-side; header VALUES must stay as the literal "{{secret}}" or "Bearer {{secret}}"
- endpoints.listModels?: { method: "GET", path, map: { models: "$.path[*]" } }
- endpoints.generateText?: { method: "POST", path, requestTemplate: { <whitelist fields>: "{{...}}" }, responseMap: { text: "$.path" }, stream?: { protocol: "sse", chunkMap: { delta: "$.path" }, stopWhen?: { path, equals } } }
- endpoints.generateImage?: { method: "POST", path, requestTemplate: {...}, responseMap: { imageB64?: "$.path", imageUrl?: "$.path" } }
- capabilities: { text: boolean, image: boolean }
- provenance: { origin: "ai-generated", generatorModel: null, createdAt: "x" }

requestTemplate placeholders are ONLY: {{model}} {{messages}} {{stream}} {{maxTokens?}} {{temperature?}} — and request-body fields ONLY: model, messages, stream, max_tokens, temperature (text); model, prompt, size (image). Selectors are $ .field [0] [*] only — no filters, no expressions.`;

function systemPrompt(pinnedBaseUrl: string): string {
  const example = JSON.stringify(
    { ...BUILTIN_TEMPLATES["openai-compat"]!("https://api.example.com/v1"), provenance: { origin: "ai-generated", generatorModel: null, createdAt: "x" } },
    null,
    1,
  );
  return [
    "You write adapter manifests for an AI provider routing app. Output EXACTLY ONE JSON object. No prose, no markdown fences, no comments.",
    SCHEMA_SUMMARY,
    `HARD RULE: provider.baseUrl must be exactly ${pinnedBaseUrl}. You choose paths, header names, and JSON-path mappings — never the host.`,
    "Complete example (OpenAI-compatible): " + example,
    "If the provider uses a non-standard response envelope, map responseMap/stream.chunkMap to its actual fields as observed in the probe report.",
  ].join("\n\n");
}

function userPrompt(report: ProbeReport, docsExcerpt?: string, feedback?: string, variantHint?: string): string {
  const lines = [
    "Provider probe report (response bodies reduced to key/type shapes — values removed):",
    JSON.stringify(report.attempts.map((a) => ({ m: a.method, p: a.path, s: a.status, ct: a.contentType, ch: a.authChallenge, shape: a.bodyShape }))),
  ];
  if (report.openapiShape) lines.push("OpenAPI document (shaped):", JSON.stringify(report.openapiShape));
  if (docsExcerpt) lines.push("Provider docs excerpt:", docsExcerpt);
  if (feedback) lines.push("Reviewer feedback from the previous round — address it:", feedback);
  if (variantHint) lines.push(variantHint);
  return lines.join("\n\n");
}

const VARIANTS = [
  undefined,
  "Prefer the simplest mappings that satisfy the observed shapes.",
  "Pay special attention to the streaming termination event and error shapes.",
];

// ---------- lint (invariants 3, 4 + field whitelist) ----------

function norm(u: string): string {
  return u.replace(/\/+$/, "").toLowerCase();
}

/** All "$"-prefixed selector strings anywhere in a manifest object. */
function selectorsIn(obj: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.startsWith("$")) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(obj);
  return out;
}

export function lintManifest(m: AdapterManifest, pinnedBaseUrl: string): string[] {
  const errors: string[] = [];
  if (norm(m.provider.baseUrl) !== norm(pinnedBaseUrl)) {
    errors.push(`provider.baseUrl "${m.provider.baseUrl}" differs from the user-entered URL (invariant 4)`);
  }
  const text = m.endpoints.generateText;
  if (text) {
    for (const f of Object.keys(text.requestTemplate)) {
      if (!REQUEST_FIELD_WHITELIST.generateText!.has(f)) errors.push(`generateText: request field "${f}" is not whitelisted`);
    }
    if (!/^\/[A-Za-z0-9._/~{}-]*$/.test(text.path)) errors.push(`generateText: path must be a URL path, got "${text.path}"`);
  }
  const image = m.endpoints.generateImage;
  if (image) {
    for (const f of Object.keys(image.requestTemplate)) {
      if (!REQUEST_FIELD_WHITELIST.generateImage!.has(f)) errors.push(`generateImage: request field "${f}" is not whitelisted`);
    }
  }
  for (const sel of selectorsIn({ ...(text ? { responseMap: text.responseMap, stream: text.stream } : {}), ...(m.endpoints.listModels ? { listModels: m.endpoints.listModels.map } : {}) })) {
    try {
      parsePath(sel);
    } catch {
      errors.push(`unsupported selector "${sel}"`);
    }
  }
  if (!text && !image) errors.push("manifest defines no generation endpoint");
  return errors;
}

// ---------- docs excerpt (§2.3: scrubbed, size-capped; same-host only in v1) ----------

export async function fetchDocsExcerpt(http: HttpPortLike, docsUrl: string, baseUrl: string): Promise<{ text?: string; error?: string }> {
  let docs: URL;
  let base: URL;
  try {
    docs = new URL(docsUrl);
    base = new URL(baseUrl);
  } catch (e) {
    return { error: `bad docs URL: ${(e as Error).message}` };
  }
  // v1 restricts docs fetch to the provider's own host (invariant 3 keep-it-simple; see
  // DECISIONS.md). A docs URL on another host is not fetched.
  if (docs.hostname !== base.hostname) return { error: `docs host ${docs.hostname} differs from provider host ${base.hostname}; not fetched (v1 same-host rule)` };
  try {
    const res = await http.request({ url: docsUrl, method: "GET", headers: { accept: "text/plain, text/markdown, */*" } });
    if (res.status >= 400) return { error: `docs fetch HTTP ${res.status}` };
    const body = await res.text();
    return { text: scrubStrings(body).slice(0, 4000) };
  } catch (e) {
    return { error: `docs fetch failed: ${(e as Error).message}` };
  }
}

// ---------- content-identity hash (audit linkage, §2.5; non-cryptographic by design) ----------

export function redactionHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) >>> 0);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = ((h2 + s.charCodeAt(i) * (i + 7)) >>> 0) ^ Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
}

// ---------- JSON extraction (models love fences despite instructions) ----------

export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------- the pipeline ----------

export async function generateCandidates(deps: GenerationDeps): Promise<RankedCandidate[]> {
  const n = Math.min(deps.n ?? 3, VARIANTS.length);
  let docsExcerpt: string | undefined;
  if (deps.docsUrl && deps.http) {
    const d = await fetchDocsExcerpt(deps.http, deps.docsUrl, deps.baseUrl);
    docsExcerpt = d.text;
    if (d.error) deps.onProgress?.({ id: "docs", stage: "parsing", detail: d.error });
  }
  const reportHash = redactionHash(JSON.stringify(deps.report) + (docsExcerpt ?? ""));

  const results: RankedCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const id = String.fromCharCode(65 + i); // A, B, C
    deps.onProgress?.({ id, stage: "parsing", detail: `AI call ${i + 1}/${n}` });
    const user = userPrompt(deps.report, docsExcerpt, deps.feedback, VARIANTS[i]);
    let text = "";
    try {
      text = await deps.ai.complete({
        prompt: user,
        system: systemPrompt(deps.baseUrl),
        maxTokens: deps.maxTokens ?? 1400,
        timeoutMs: deps.timeoutMs ?? 120_000,
        excludeProviderIds: deps.excludeProviderIds,
      });
    } catch (e) {
      results.push({ id, schemaErrors: [], lintErrors: [], freePasses: 0, score: 0, rejectedReason: `AI call failed: ${(e as Error).message}`.slice(0, 300) });
      deps.onProgress?.({ id, stage: "rejected", detail: "AI call failed" });
      continue;
    }
    await deps.audit?.({ modelUsed: deps.systemLabel, promptChars: user.length + SCHEMA_SUMMARY.length, completionChars: text.length, redactionHash: reportHash });

    const json = extractJson(text);
    if (json == null) {
      results.push({ id, schemaErrors: ["output contained no parseable JSON object"], lintErrors: [], freePasses: 0, score: 0, rejectedReason: "unparseable output" });
      deps.onProgress?.({ id, stage: "rejected", detail: "no JSON in output" });
      continue;
    }
    const parsed = ADAPTER_MANIFEST_V1_1.safeParse(json);
    if (!parsed.success) {
      const errs = parsed.error.issues.slice(0, 4).map((iss) => `${iss.path.join(".") || "root"}: ${iss.message}`);
      results.push({ id, schemaErrors: errs, lintErrors: [], freePasses: 0, score: 0 });
      deps.onProgress?.({ id, stage: "schema", detail: errs[0] });
      continue;
    }
    deps.onProgress?.({ id, stage: "schema", detail: "valid" });

    // provenance is OURS to set, never the model's
    const manifest: AdapterManifest = {
      ...parsed.data,
      provenance: { origin: "ai-generated", generatorModel: deps.systemLabel, createdAt: new Date().toISOString() },
    };
    const lintErrors = lintManifest(manifest, deps.baseUrl);
    if (lintErrors.length) {
      results.push({ id, schemaErrors: [], lintErrors, freePasses: 0, score: 0 });
      deps.onProgress?.({ id, stage: "lint", detail: lintErrors[0] });
      continue;
    }
    deps.onProgress?.({ id, stage: "lint", detail: "clean" });

    // free contract checks against the REAL provider (paid checks come later, once, for the
    // picked candidate — this keeps AI-path cost bounded)
    let contract: ContractReport | undefined;
    if (deps.http) {
      deps.onProgress?.({ id, stage: "contract", detail: "running free checks…" });
      const interpreter = new ManifestInterpreter(manifest, { http: deps.http, vars: { appUrl: "https://aiprovider.router" } });
      try {
        contract = await runContractSuite(interpreter, { secretRef: deps.secretRef, consent: { text: false, image: false }, signal: deps.signal });
      } catch (e) {
        contract = { checks: [], allPassed: false, freePassed: false };
        deps.onProgress?.({ id, stage: "contract", detail: String((e as Error).message).slice(0, 120) });
      }
    }
    const freePasses = contract ? contract.checks.filter((c) => !c.paid && c.pass).length : 0;
    const specificity = Object.keys(manifest.endpoints).length;
    const score = freePasses * 10 + specificity;
    results.push({ id, schemaErrors: [], lintErrors: [], manifest, contract, freePasses, score });
    deps.onProgress?.({ id, stage: "scored", detail: `${freePasses} free check(s) passed` });
  }

  // rank: score desc; ties -> smaller JSON first (simplicity)
  results.sort((a, b) => b.score - a.score || (a.manifest ? JSON.stringify(a.manifest).length : 1e9) - (b.manifest ? JSON.stringify(b.manifest).length : 1e9));
  return results;
}

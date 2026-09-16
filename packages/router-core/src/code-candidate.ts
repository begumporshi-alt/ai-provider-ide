/**
 * code-candidate (L2, §2.7): the Tier-2 generation + review gate.
 *
 * When no declarative manifest can express a provider (exotic auth dance, non-JSON framing,
 * unusual streaming), the Generator may emit a JS module instead. That module is EXECUTABLE
 * code from an AI, so it never reaches a human — and never reaches the sandbox for a real
 * request — until it has cleared four gates, in order:
 *
 *   1. schema   — the wrapped manifest parses against the frozen v1.1 grammar
 *   2. lint     — static tripwires (size, `export default {`, no import/eval/fetch/…)
 *   3. compile  — the module actually compiles inside QuickJS-WASM
 *   4. contract — FREE checks over REAL HTTP: the guest must list models through the sandbox
 *
 * Gate 4 is the load-bearing one. The untrusted code actually runs, sandboxed, against the
 * live provider; the only way it passes is to call `http({path:"/models"})` on the
 * provider's own host with credentials it never sees. A guest that reaches anywhere else,
 * or returns nothing, fails and is rejected before registration.
 *
 * The host (this module) owns everything security-relevant: the baseUrl is pinned to the
 * user-entered URL, provenance is stamped here (never by the model), and the manifest the
 * human approves is byte-identical to the one that executes later.
 */
import { ADAPTER_MANIFEST_V1_1, type AdapterManifest } from "@aiprovider/adapter-spec";
import { CodeAdapterInstance, lintCodeSource } from "./code-adapter.js";
import { runContractSuite, type ContractReport } from "./contract-suite.js";
import type { HttpPort } from "./ports.js";
import type { ProbeReport } from "./probe-runner.js";
import { extractJson } from "./adapter-generator.js";
import type { RankedCandidate } from "./adapter-generator.js";
import type { AiTextPort } from "./model-router.js";

/** The JSON envelope the model emits. The host wraps it into a full manifest — the model
 *  never gets to choose the host, the provenance, or the grammar version. */
interface CodeEnvelope {
  dialect: string;
  authHeader: { name: string; prefix?: string };
  capabilities?: { text: boolean; image: boolean };
  source: string;
}

const CODE_CANDIDATE_ID = "JS"; // distinct from the declarative A/B/C grid

// ---------- prompt pack ----------

const GUEST_CONTRACT = `A JS ES module, EXACTLY ONE, no prose, no markdown fences, no comments. It must "export default" an object implementing this contract:
  async listModels(http) -> array of {id}|string (or omit)
  async generateText(http, emit, argsJson) -> undefined; emit(chunk) streams text
  async generateImage(http, argsJson) -> {ok,status,base64?,url?,errorBody?}
  argsJson is a JSON string: {model, messages, stream, maxTokens?, temperature?}.
  http(req) -> Promise<{status,text}>; req = {path, method?, headers?, body?}.
    path MUST be a RELATIVE provider path like "/models" — the host prefixes the baseUrl and
    injects auth. You may set non-auth headers only. Setting Authorization/x-api-key/api-key/cookie
    is pointless: the host drops them and injects the real credential itself.
  log(string) is available globally.
HARD RULES on the source: must contain "export default {"; must NOT contain import(, import X,
require(, eval(, new Function, Function(, WebAssembly, Atomics, SharedArrayBuffer, fetch(,
XMLHttpRequest, import.meta. No filesystem, no DOM, no Node — none exist in the sandbox.
Budgets per operation: 45s wall clock, 20 http calls, 400 emitted lines, 8MB response body.
Emit plain string chunks; the host reassembles them.`;

function codeSystemPrompt(pinnedBaseUrl: string): string {
  return [
    "You write Tier-2 code adapters for an AI provider routing app, as a last resort when the",
    "provider's API cannot be described by the declarative manifest grammar. Output EXACTLY ONE",
    'JSON object: { dialect: string, authHeader: { name: string, prefix?: string },',
    "capabilities: { text: boolean, image: boolean }, source: string }. No prose, no fences.",
    GUEST_CONTRACT,
    `HARD RULE: the host pins provider.baseUrl to ${pinnedBaseUrl}; you only choose the relative`,
    "paths, the auth header NAME you observed in the probe report, and the mappings.",
    "authHeader.name is the request header the provider expects (Authorization, x-api-key, ...);",
    "prefix is \"Bearer\" if the provider uses a bearer scheme. Never put the key value anywhere.",
  ].join("\n");
}

function codeUserPrompt(report: ProbeReport, docsExcerpt?: string, feedback?: string): string {
  const lines = [
    "Provider probe report (response bodies reduced to key/type shapes — values removed):",
    JSON.stringify(report.attempts.map((a) => ({ m: a.method, p: a.path, s: a.status, ct: a.contentType, ch: a.authChallenge, shape: a.bodyShape }))),
  ];
  if (report.openapiShape) lines.push("OpenAPI document (shaped):", JSON.stringify(report.openapiShape));
  if (docsExcerpt) lines.push("Provider docs excerpt:", docsExcerpt);
  if (feedback) lines.push("Reviewer feedback from the previous round — address it:", feedback);
  return lines.join("\n\n");
}

// ---------- lint ----------

function norm(u: string): string {
  return u.replace(/\/+$/, "").toLowerCase();
}

/**
 * Static gate for a code manifest: the baseUrl pin (invariant 4 — the generator may not
 * redirect traffic elsewhere) plus the source tripwires. The declarative lint is not reused:
 * it rejects a code manifest outright for lacking endpoints, which is the whole point.
 */
export function lintCodeManifest(m: AdapterManifest, pinnedBaseUrl: string): string[] {
  const errors: string[] = [];
  if (m.kind !== "code" || !m.code?.source) {
    errors.push('kind "code" requires code.source');
    return errors;
  }
  if (norm(m.provider.baseUrl) !== norm(pinnedBaseUrl)) {
    errors.push(`provider.baseUrl "${m.provider.baseUrl}" differs from the user-entered URL (invariant 4)`);
  }
  errors.push(...lintCodeSource(m.code.source));
  if (!m.capabilities.text && !m.capabilities.image) {
    errors.push("code adapter declares neither text nor image capability");
  }
  return errors;
}

// ---------- the review gate ----------

export interface CodeReviewContext {
  http: HttpPort;
  secretRef: string;
  baseUrl: string;
  signal?: AbortSignal;
  /** Guest log lines — surfaced in the review UI as execution evidence. */
  onLog?: (line: string) => void;
}

/**
 * Run the four-gate review on a fully-assembled code manifest. Returns a RankedCandidate
 * shaped exactly like a declarative one, so the wizard's pick/register path is kind-blind.
 * A candidate that fails any gate returns with the manifest attached ONLY when it is safe to
 * show a human (schema + lint clean) — compile/contract failures keep the source out of the
 * result so the UI can explain why without offering a broken module for approval.
 */
export async function reviewCodeCandidate(
  manifest: AdapterManifest,
  ctx: CodeReviewContext,
): Promise<RankedCandidate> {
  // 1. schema (the manifest is host-assembled, but validate anyway — never trust the caller)
  const parsed = ADAPTER_MANIFEST_V1_1.safeParse(manifest);
  if (!parsed.success) {
    const schemaErrors = parsed.error.issues.slice(0, 4).map((iss) => `${iss.path.join(".") || "root"}: ${iss.message}`);
    return { id: CODE_CANDIDATE_ID, schemaErrors, lintErrors: [], freePasses: 0, score: 0, rejectedReason: "manifest failed schema" };
  }

  // 2. lint (static tripwires — the source never reaches QuickJS until this is clean)
  const lintErrors = lintCodeManifest(manifest, ctx.baseUrl);
  if (lintErrors.length) {
    return { id: CODE_CANDIDATE_ID, schemaErrors: [], lintErrors, freePasses: 0, score: 0, rejectedReason: lintErrors[0] };
  }

  // 3+4. compile, then free contract checks over real HTTP — both on the SAME instance, so
  // the artifact a human reviews is the artifact that executed. Faults tear the context down
  // and the next call rebuilds from source; nothing here can poison a later operation.
  let contract: ContractReport | undefined;
  try {
    const instance = new CodeAdapterInstance(manifest, { http: ctx.http, onLog: ctx.onLog });
    try {
      await instance.compile();
    } catch (e) {
      // The source stays attached so the review UI can show what failed — read-only, since
      // freePasses is 0 and the Approve button keys off that.
      return {
        id: CODE_CANDIDATE_ID,
        schemaErrors: [],
        lintErrors: [],
        manifest,
        freePasses: 0,
        score: 0,
        code: { compiled: false, compileError: String((e as Error).message ?? e).slice(0, 300) },
        rejectedReason: String((e as Error).message ?? e).slice(0, 300),
      };
    }
    contract = await runContractSuite(instance, {
      secretRef: ctx.secretRef,
      consent: { text: false, image: false },
      signal: ctx.signal,
    });
  } catch (e) {
    return {
      id: CODE_CANDIDATE_ID,
      schemaErrors: [],
      lintErrors: [],
      freePasses: 0,
      score: 0,
      code: { compiled: true, compileError: String((e as Error).message ?? e).slice(0, 300) },
      rejectedReason: String((e as Error).message ?? e).slice(0, 300),
    };
  }
  const freePasses = contract.checks.filter((c) => !c.paid && c.pass).length;
  return {
    id: CODE_CANDIDATE_ID,
    schemaErrors: [],
    lintErrors: [],
    manifest,
    contract,
    freePasses,
    score: freePasses * 10,
    code: { compiled: true },
  };
}

// ---------- generation ----------

export interface CodeGenerationDeps {
  ai: Pick<AiTextPort, "complete">;
  systemLabel: string;
  report: ProbeReport;
  baseUrl: string;
  secretRef: string;
  excludeProviderIds: string[];
  http: HttpPort;
  feedback?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

/**
 * Ask the System AI for a Tier-2 code adapter, then run the review gate on what came back.
 * The envelope is model-controlled (dialect, header name, source); the manifest is not —
 * baseUrl, grammar version and provenance are all host-assembled below.
 */
export async function generateCodeCandidate(deps: CodeGenerationDeps): Promise<RankedCandidate> {
  let text = "";
  try {
    text = await deps.ai.complete({
      prompt: codeUserPrompt(deps.report, undefined, deps.feedback),
      system: codeSystemPrompt(deps.baseUrl),
      maxTokens: deps.maxTokens ?? 4000,
      timeoutMs: deps.timeoutMs ?? 180_000,
      excludeProviderIds: deps.excludeProviderIds,
    });
  } catch (e) {
    return {
      id: CODE_CANDIDATE_ID, schemaErrors: [], lintErrors: [], freePasses: 0, score: 0,
      rejectedReason: `AI call failed: ${String((e as Error).message ?? e)}`.slice(0, 300),
    };
  }

  const json = extractJson(text);
  if (json == null) {
    return { id: CODE_CANDIDATE_ID, schemaErrors: ["output contained no parseable JSON object"], lintErrors: [], freePasses: 0, score: 0, rejectedReason: "unparseable output" };
  }
  const env = json as Partial<CodeEnvelope>;
  const source = typeof env.source === "string" ? env.source : "";
  const headerName = typeof env.authHeader?.name === "string" && env.authHeader.name ? env.authHeader.name : "Authorization";
  const manifest: AdapterManifest = {
    manifestVersion: 1,
    kind: "code",
    dialect: typeof env.dialect === "string" && env.dialect ? env.dialect : "custom-code-v1",
    provider: {
      baseUrl: deps.baseUrl, // pinned, not the model's
      auth: { headers: [{ name: headerName, ...(env.authHeader?.prefix ? { prefix: env.authHeader.prefix } : {}) }] },
    },
    endpoints: {},
    code: { source, entry: "adapter" },
    capabilities: env.capabilities ?? { text: true, image: false },
    provenance: { origin: "ai-generated", generatorModel: deps.systemLabel, createdAt: new Date().toISOString() },
  };
  return reviewCodeCandidate(manifest, {
    http: deps.http,
    secretRef: deps.secretRef,
    baseUrl: deps.baseUrl,
    signal: deps.signal,
    onLog: deps.onLog,
  });
}

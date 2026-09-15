/**
 * Phase 3 pipeline tests: probe → fingerprint → template → contract → orchestrator,
 * all against scripted fakes (the deterministic, zero-AI path — criterion 7's core).
 */
import { describe, expect, it } from "vitest";
import { OnboardingOrchestrator, type OnboardingSessionData } from "../src/onboarding-orchestrator.js";
import { runProbes } from "../src/probe-runner.js";
import { fingerprint } from "../src/fingerprinter.js";
import { runContractSuite } from "../src/contract-suite.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { shapeOf, scrubStrings } from "../src/redaction.js";
import { FakeHttp } from "./fakes.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";

/** An OpenAI-compatible provider: model list at /models, chat at /chat/completions. */
const OPENAI_SERVER = (url: string): { status: number; body?: unknown } => {
  if (url.endsWith("/models") || url.endsWith("/v1/models"))
    return { status: 200, body: { object: "list", data: [{ id: "gpt-4o" }, { id: "dall-e-3" }] } };
  if (url.endsWith("/chat/completions")) return { status: 400, body: { error: { message: "messages required" } } }; // route exists
  if (url.endsWith("/messages")) return { status: 404 };
  return { status: 404 };
};

/** An Anthropic-compatible provider: models + /messages, NO /chat/completions. */
const ANTHROPIC_SERVER = (url: string): { status: number; body?: unknown } => {
  if (url.endsWith("/models") || url.endsWith("/v1/models"))
    return { status: 200, body: { data: [{ id: "qwen3.8-flash" }] } };
  if (url.endsWith("/messages")) return { status: 400, body: { error: { type: "invalid_request_error", message: "max_tokens: field required" } } };
  if (url.endsWith("/chat/completions")) return { status: 404 };
  return { status: 404 };
};

describe("probe-runner", () => {
  it("probes the matrix, never records raw bodies, and shapes JSON responses", async () => {
    const http = new FakeHttp((url) => OPENAI_SERVER(url));
    const report = await runProbes(http, "https://api.example.com/v1");
    const paths = report.attempts.map((a) => a.path);
    expect(paths).toContain("/models");
    expect(paths).toContain("/chat/completions");
    const models = report.attempts.find((a) => a.path === "/models")!;
    expect(models.status).toBe(200);
    expect(models.bodyShape).toBeDefined();
    // values never survive: the shape holds types, not ids
    expect(JSON.stringify(models.bodyShape)).not.toContain("gpt-4o");
  });

  it("records the 401 auth challenge scheme (name only)", async () => {
    const http = new FakeHttp((url) => {
      if (url.endsWith("/models")) {
        // unauthenticated probe: 401 + WWW-Authenticate challenge (§2.2)
        return { status: 401, headers: { "www-authenticate": 'Bearer realm="api"' } };
      }
      return { status: 404 };
    });
    const report = await runProbes(http, "https://x.test/v1");
    const models = report.attempts.find((a) => a.path === "/models")!;
    expect(models.authChallenge).toBe("Bearer");
  });
});

describe("fingerprinter (§2.4 signatures)", () => {
  it("classifies an OpenAI-compatible probe set and pins the user baseUrl", async () => {
    const report = await runProbes(new FakeHttp((url) => OPENAI_SERVER(url)), "https://api.example.com/v1");
    const result = fingerprint(report);
    expect(result.dialect).toBe("openai-compat");
    expect(result.template?.provider.baseUrl).toBe("https://api.example.com/v1");
    expect(result.evidence.join(" ")).toContain("model list");
  });

  it("classifies an Anthropic-compatible probe set", async () => {
    const report = await runProbes(new FakeHttp((url) => ANTHROPIC_SERVER(url)), "https://api.b.test/v1");
    const result = fingerprint(report);
    expect(result.dialect).toBe("anthropic-compat");
    expect(result.template?.dialect).toBe("anthropic-messages-v1");
  });

  it("returns unknown for a service with no recognizable surface", async () => {
    const report = await runProbes(new FakeHttp(() => ({ status: 404 })), "https://nothing.test");
    expect(fingerprint(report).dialect).toBe("unknown");
  });
});

describe("contract-suite", () => {
  it("free checks pass and paid checks respect consent", async () => {
    const interpreter = new ManifestInterpreter(BUILTIN_TEMPLATES["openai-compat"]!("https://api.test/v1"), {
      http: new FakeHttp((url) => {
        if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "m1" }] } };
        if (url.endsWith("/chat/completions")) return { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
        return { status: 404 };
      }),
      vars: {},
    });
    const noConsent = await runContractSuite(interpreter, { secretRef: "key:t", consent: { text: false, image: false } });
    expect(noConsent.freePassed).toBe(true);
    expect(noConsent.checks.every((c) => !c.paid)).toBe(true);

    const withConsent = await runContractSuite(interpreter, { secretRef: "key:t", consent: { text: true, image: false } });
    expect(withConsent.allPassed).toBe(true);
    expect(withConsent.checks.some((c) => c.paid && c.name.startsWith("text"))).toBe(true);
  });

  it("a failing key fails the auth check with the real message", async () => {
    const interpreter = new ManifestInterpreter(BUILTIN_TEMPLATES["openai-compat"]!("https://api.test/v1"), {
      http: new FakeHttp(() => ({ status: 401, body: { error: "bad key" } })),
      vars: {},
    });
    const r = await runContractSuite(interpreter, { secretRef: "key:t", consent: { text: false, image: false } });
    expect(r.freePassed).toBe(false);
    expect(r.checks[0]!.detail).toContain("401");
  });
});

describe("onboarding-orchestrator (state machine, §2.1)", () => {
  function makeOrch(server: (url: string) => { status: number; body?: unknown }) {
    const saved: OnboardingSessionData[] = [];
    const orch = new OnboardingOrchestrator(
      new FakeHttp((url) => server(url)),
      {
        save: async (d) => {
          saved.push(JSON.parse(JSON.stringify(d)));
        },
        loadLatest: async () => null,
      },
    );
    return { orch, saved };
  }

  it("happy path: probe → template → contract → confirm → enabled (criterion 7 core)", async () => {
    const { orch, saved } = makeOrch((url) => {
      if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "m1" }] } };
      if (url.endsWith("/chat/completions")) return { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
      return OPENAI_SERVER(url);
    });
    await orch.start({ name: "Example", baseUrl: "https://api.example.com/v1" });
    const fp = await orch.identify();
    expect(fp.dialect).toBe("openai-compat");
    const contract = await runContractSuite(
      new ManifestInterpreter(fp.template!, { http: new FakeHttp((url) => OPENAI_SERVER(url)), vars: {} }),
      { secretRef: "key:t", consent: { text: false, image: false } },
    );
    await orch.setContract(contract);
    await orch.confirmRegistration();
    await orch.enable();
    expect(orch.session.state).toBe("enabled");
    // every transition persisted
    expect(saved.length).toBeGreaterThanOrEqual(6);
    // the API key never appears in persisted state (redaction contract)
    expect(JSON.stringify(saved)).not.toMatch(/sk-/);
  });

  it("unknown dialect fails with guidance and no manifest", async () => {
    const { orch } = makeOrch(() => ({ status: 404 }));
    await orch.start({ name: "Alien", baseUrl: "https://alien.test" });
    const fp = await orch.identify();
    expect(fp.dialect).toBe("unknown");
    expect(orch.session.state).toBe("failed");
    expect(orch.session.failureReason).toContain("Phase 4");
  });

  it("registration refuses when free contract checks failed", async () => {
    const { orch } = makeOrch((url) => OPENAI_SERVER(url));
    await orch.start({ name: "Example", baseUrl: "https://api.example.com/v1" });
    await orch.identify();
    await orch.setContract({ checks: [{ name: "auth", pass: false, paid: false, detail: "401" }], allPassed: false, freePassed: false });
    await expect(orch.confirmRegistration()).rejects.toThrow(/free contract checks did not pass/);
  });
});

describe("redaction (§2.3)", () => {
  it("strips key-shaped strings", () => {
    expect(scrubStrings("Bearer sk-abcdef1234567890")).not.toContain("abcdef");
    expect(scrubStrings("api_key: ghp_1234567890abcdef")).toContain("[REDACTED]");
  });
  it("shapes nested objects without values", () => {
    const shape = shapeOf({ data: [{ id: "gpt-4o", pricing: { prompt: "0.001" } }], secret: "sk-abcdefgh12345678" });
    const s = JSON.stringify(shape);
    expect(s).not.toContain("gpt-4o");
    expect(s).not.toContain("0.001");
    expect(s).not.toContain("sk-abcdefgh");
    expect(s).toContain("data");
  });
});

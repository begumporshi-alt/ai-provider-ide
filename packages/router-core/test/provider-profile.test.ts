/**
 * A host that serves BOTH dialects cannot be classified by the fingerprinter.
 *
 * `fingerprinter.ts`'s anthropic rule is a NEGATIVE test — `messages?.exists && !chat?.exists` — so a
 * host answering on `/messages` *and* `/chat/completions` fails it by construction. No
 * unauthenticated probe can break the tie: the probe set is deliberately credential-free and
 * free-only, so both routes answer identically and the verdict is `unknown`.
 *
 * Measured 2026-09-29 against `agentrouter.org`, where the wizard then told the operator
 * "Deterministic setup covers OpenAI- and Anthropic-compatible APIs" — about a host that is both.
 *
 * The fix is a measured-host profile plus a fallback in `OnboardingOrchestrator.identify()`. The
 * text-block defect that same host exposed is covered by `anthropic-text-blocks.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_PROFILES, profileForBaseUrl } from "../src/builtin-templates.js";
import { OnboardingOrchestrator, type OnboardingSessionData } from "../src/onboarding-orchestrator.js";
import { runProbes } from "../src/probe-runner.js";
import { fingerprint } from "../src/fingerprinter.js";
import { FakeHttp } from "./fakes.js";

describe("the agentrouter profile", () => {
  const m = PROVIDER_PROFILES["agentrouter"]!();

  it("pins the Anthropic route, which is the one that returns text", () => {
    expect(m.dialect).toBe("anthropic-messages-v1");
    expect(m.provider.baseUrl).toBe("https://agentrouter.org/v1");
    expect(m.endpoints.generateText?.path).toBe("/messages");
    expect(m.endpoints.listModels?.path).toBe("/models");
    // The selector `anthropic-text-blocks.test.ts` exists to protect.
    expect(m.endpoints.generateText?.responseMap.text).toBe("$.content");
  });

  it("names no client — impersonating one is the operator's decision, not this product's default", () => {
    const headers = JSON.stringify([
      m.endpoints.listModels?.headers,
      m.endpoints.generateText?.headers,
    ]).toLowerCase();
    expect(headers).not.toContain("user-agent");
  });
});

describe("profileForBaseUrl", () => {
  it("matches the profile's host, with or without a path", () => {
    expect(profileForBaseUrl("https://agentrouter.org/v1")?.slug).toBe("agentrouter");
    expect(profileForBaseUrl("https://agentrouter.org")?.slug).toBe("agentrouter");
  });

  it("does not match a lookalike host", () => {
    // A suffix test would hand a stranger's host the profile's wiring.
    expect(profileForBaseUrl("https://agentrouter.org.evil.test/v1")).toBeUndefined();
    expect(profileForBaseUrl("https://notagentrouter.org/v1")).toBeUndefined();
  });

  it("returns nothing for an unknown host or a non-URL", () => {
    expect(profileForBaseUrl("https://relay.test/v1")).toBeUndefined();
    expect(profileForBaseUrl("not a url")).toBeUndefined();
  });
});

describe("a dual-dialect host, which no unauthenticated probe can classify", () => {
  const BASE = "https://agentrouter.org/v1";

  /**
   * The measured surface: both routes answer, neither without a credential.
   *
   * `GET /models` is included because that is what the probe asks first — on the real host it is
   * `401` too, so no model-list signal is available to the classifier either.
   */
  const dualDialect = (url: string) =>
    [`${BASE}/models`, `${BASE}/chat/completions`, `${BASE}/messages`].includes(url)
      ? { status: 401, body: { error: { type: "new_api_error", message: "no token" } } }
      : { status: 404 };

  const memory = () => {
    let saved: OnboardingSessionData | null = null;
    return {
      save: async (d: OnboardingSessionData) => { saved = d; },
      loadLatest: async () => saved,
      get: () => saved,
    };
  };

  it("is `unknown` to the fingerprinter — the precondition, not the outcome", async () => {
    const fp = fingerprint(await runProbes(new FakeHttp(dualDialect), BASE));
    expect(fp.dialect).toBe("unknown");
    // Asserted so this test cannot pass for the wrong reason later: a *gate* would also be
    // `unknown`, but a gate means the operator still owes a header, and that path must not be
    // resolved by a profile.
    expect(fp.clientGate).toBeUndefined();
    expect(fp.evidence.join(" ")).toContain("chat/completions endpoint exists");
    expect(fp.evidence.join(" ")).toContain("messages endpoint exists");
  });

  it("resolves through the profile, and registers the profile's manifest", async () => {
    const p = memory();
    const orch = new OnboardingOrchestrator(new FakeHttp(dualDialect), p);
    await orch.start({ name: "AgentRouter", baseUrl: BASE });
    const fp = await orch.identify();

    expect(fp.dialect).toBe("anthropic-compat");
    expect(fp.template?.provider.baseUrl).toBe("https://agentrouter.org/v1");
    expect(orch.session.state).toBe("template_instantiated");
    expect(fp.evidence.join(" ")).toContain("known provider");
    expect(p.get()!.manifest?.dialect).toBe("anthropic-messages-v1");
  });

  it("still fails for the same probe shape on a host no profile covers", async () => {
    const relay = "https://relay.test/v1";
    const p = memory();
    const orch = new OnboardingOrchestrator(
      new FakeHttp((url) =>
        [`${relay}/models`, `${relay}/chat/completions`, `${relay}/messages`].includes(url)
          ? { status: 401, body: { error: { type: "x", message: "no token" } } }
          : { status: 404 },
      ),
      p,
    );
    await orch.start({ name: "Relay", baseUrl: relay });
    const fp = await orch.identify();

    expect(fp.dialect).toBe("unknown");
    expect(orch.session.state).toBe("failed");
    expect(p.get()!.failureReason).toContain("No known dialect matched");
  });

  it("does not resolve a client gate through a profile — the operator still owes a header", async () => {
    const p = memory();
    const orch = new OnboardingOrchestrator(
      new FakeHttp(() => ({
        status: 401,
        body: {
          error: { message: "unauthorized client detected" },
          type: "unauthorized_client_error",
        },
      })),
      p,
    );
    await orch.start({ name: "AgentRouter", baseUrl: BASE });
    const fp = await orch.identify();

    // A profile match here would register a working-looking provider that cannot be reached: the
    // probe never got past the gate, so nothing about the host has actually been confirmed.
    expect(fp.dialect).toBe("unknown");
    expect(fp.clientGate).toBe("unauthorized_client_error");
    expect(orch.session.state).toBe("failed");
  });
});

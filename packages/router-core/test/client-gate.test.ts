/**
 * The client-gate path: a gateway that refuses the caller before it reads any credential.
 *
 * Every body in here is quoted from a real response, measured 2026-09-29 against
 * `agentrouter.org` with the credential held constant and only `User-Agent` varied:
 *
 *   no UA / `curl` / a browser UA / a made-up UA  -> `401 unauthorized_client_error`
 *   `claude-cli/2.0.0 (external, cli)`, `zcode`   -> `401 new_api_error` ("invalid token")
 *
 * The second row is the whole point: the *same* dummy key is judged on its merits once the client
 * is accepted, so the first row is evidence about the client and none at all about the key. Before
 * this existed, both rows collapsed into "the provider rejected this key" — and the key was taken
 * out of rotation for a decision the provider never made.
 */
import { describe, expect, it } from "vitest";
import { detectClientGate } from "../src/client-gate.js";
import { runProbes } from "../src/probe-runner.js";
import { fingerprint } from "../src/fingerprinter.js";
import { OnboardingOrchestrator, type OnboardingSessionData } from "../src/onboarding-orchestrator.js";
import { FakeHttp } from "./fakes.js";

/** Verbatim from `agentrouter.org`, with the Discord URL left as the provider sent it. */
const GATE_BODY = JSON.stringify({
  error: {
    message:
      "unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB",
  },
  message: "UNAUTHENTICATED",
  success: false,
  type: "unauthorized_client_error",
});

/** What the same gateway says once it accepts the client — a judgement about the *key*. */
const BAD_KEY_BODY = JSON.stringify({ error: { message: "无效的令牌", type: "new_api_error" } });

/**
 * The gateway: a client gate on every path, unless the request names a client it serves.
 *
 * Reads the call `FakeHttp` has already recorded, because the responder signature carries no
 * headers — `http` is assigned before any request is issued, so this is safe.
 */
function gatedGateway(acceptedUa: string) {
  let http: FakeHttp;
  http = new FakeHttp((url) => {
    const sent = http.calls[http.calls.length - 1]?.headers ?? {};
    const ua = Object.entries(sent).find(([k]) => k.toLowerCase() === "user-agent")?.[1] ?? "";
    if (!ua.includes(acceptedUa)) return { status: 401, raw: GATE_BODY, headers: { "content-type": "application/json" } };
    // Client accepted: the gateway now answers as a normal Anthropic-shaped relay.
    if (url.endsWith("/models")) return { status: 401, raw: BAD_KEY_BODY };
    if (url.endsWith("/messages")) return { status: 401, raw: BAD_KEY_BODY };
    return { status: 404 };
  });
  return { http, get: () => http };
}

describe("detectClientGate", () => {
  it("recognises the measured refusal, by either marker", () => {
    expect(detectClientGate(401, GATE_BODY)).toBe("unauthorized_client_error");
    // The prose alone, without the `type` token, is enough.
    expect(detectClientGate(401, '{"error":{"message":"unauthorized client detected"}}')).toBe(
      "unauthorized client",
    );
    expect(detectClientGate(403, GATE_BODY)).toBe("unauthorized_client_error");
  });

  it("does not mistake a credential rejection for a client gate", () => {
    // The decisive contrast: the same status, a different claim. This one *is* about the key.
    expect(detectClientGate(401, BAD_KEY_BODY)).toBeUndefined();
    expect(detectClientGate(401, "HTTP 401: no auth credentials")).toBeUndefined();
    expect(detectClientGate(401, "")).toBeUndefined();
    expect(detectClientGate(401, undefined)).toBeUndefined();
  });

  it("only treats a refusal as a gate", () => {
    // A success or a provider-side failure carrying this prose is not a refusal, so it is not a
    // gate. Without the status guard the phrase alone would suppress a real credential verdict.
    expect(detectClientGate(200, GATE_BODY)).toBeUndefined();
    expect(detectClientGate(500, GATE_BODY)).toBeUndefined();
  });
});

describe("the probe records a client gate", () => {
  it("marks the attempts and keeps no body", async () => {
    const { http } = gatedGateway("claude-cli");
    const report = await runProbes(http, "https://relay.test/v1");
    const gated = report.attempts.filter((a) => a.clientGate);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]!.clientGate).toBe("unauthorized_client_error");
    // §2.3: the marker is a fixed string this repo names; the response text does not survive.
    expect(JSON.stringify(report)).not.toContain("discord.gg");
    expect(JSON.stringify(report)).not.toContain("unauthorized client detected");
  });

  it("leaves an ordinary provider unmarked", async () => {
    const http = new FakeHttp((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : { status: 404 },
    );
    const report = await runProbes(http, "https://api.example.com/v1");
    expect(report.attempts.some((a) => a.clientGate)).toBe(false);
  });
});

describe("the fingerprint stops rather than guessing", () => {
  it("reports the gate and suppresses the endpoint evidence it invalidates", async () => {
    const { http } = gatedGateway("claude-cli");
    const fp = fingerprint(await runProbes(http, "https://relay.test/v1"));
    expect(fp.dialect).toBe("unknown");
    expect(fp.clientGate).toBe("unauthorized_client_error");
    // The bug this replaces: a uniform refusal makes every path answer `401`, so `exists` was true
    // for all of them and the old code emitted two confident, worthless facts. `/chat/completions`
    // and `/messages` "exist" on a host that answers identically for any path at all.
    expect(fp.evidence.join(" ")).not.toContain("chat/completions endpoint exists");
    expect(fp.evidence.join(" ")).not.toContain("messages endpoint exists");
    expect(fp.evidence.join(" ")).toContain("refused this client");
  });
});

describe("the retry the operator is offered actually works", () => {
  it("identifies the provider once the accepted client is named", async () => {
    const { http } = gatedGateway("claude-cli");
    const base = "https://relay.test/v1";

    // Without the header the probe is refused and learns nothing. Asserting `clientGate` here and
    // not merely `unknown` is deliberate: `unknown` is also what the *old* code returned, so a test
    // stopping there would pass against the behaviour it is meant to pin.
    const gated = fingerprint(await runProbes(http, base));
    expect(gated.dialect).toBe("unknown");
    expect(gated.clientGate).toBe("unauthorized_client_error");

    // With it, the same gateway answers as the relay it is — and the dialect resolves. This is the
    // end-to-end claim behind the gate panel's "Retry with these headers" button, asserted at the
    // layer the button drives rather than at the button.
    const fp = fingerprint(
      await runProbes(http, base, undefined, undefined, {
        "user-agent": "claude-cli/2.0.0 (external, cli)",
      }),
    );
    expect(fp.clientGate).toBeUndefined();
    expect(fp.dialect).toBe("anthropic-compat");
    expect(fp.template?.provider.baseUrl).toBe(base);
  });

  it("sends the extra headers on every probe, not just the first", async () => {
    const { http, get } = gatedGateway("claude-cli");
    await runProbes(http, "https://relay.test/v1", undefined, undefined, { "x-probe": "1" });
    const sent = get().calls;
    expect(sent.length).toBeGreaterThan(1);
    for (const c of sent) expect(c.headers["x-probe"]).toBe("1");
  });
});

describe("the orchestrator explains the gate instead of blaming the provider", () => {
  const memory = () => {
    let saved: OnboardingSessionData | null = null;
    return {
      save: async (d: OnboardingSessionData) => { saved = d; },
      loadLatest: async () => saved,
      get: () => saved,
    };
  };

  it("fails with the header remedy, not with 'no known dialect'", async () => {
    const { http } = gatedGateway("claude-cli");
    const p = memory();
    const orch = new OnboardingOrchestrator(http, p);
    await orch.start({ name: "Relay", baseUrl: "https://relay.test/v1" });
    const fp = await orch.identify();
    expect(fp.clientGate).toBe("unauthorized_client_error");
    const reason = p.get()!.failureReason ?? "";
    expect(reason).toContain("refused this client");
    expect(reason).toContain("custom headers");
    // The generic sentence would send the operator looking for a different provider.
    expect(reason).not.toContain("No known dialect matched");
  });

  it("reaches the template path when the start input carries the header", async () => {
    const { http } = gatedGateway("claude-cli");
    const p = memory();
    const orch = new OnboardingOrchestrator(http, p);
    await orch.start({
      name: "Relay",
      baseUrl: "https://relay.test/v1",
      extraHeaders: { "user-agent": "claude-cli/2.0.0 (external, cli)" },
    });
    const fp = await orch.identify();
    expect(fp.dialect).toBe("anthropic-compat");
    expect(orch.session.state).toBe("template_instantiated");
  });
});

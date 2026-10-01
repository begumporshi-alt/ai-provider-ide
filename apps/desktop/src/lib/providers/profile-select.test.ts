/**
 * profile-select.test.ts — which manifest serves a provider, and what survives the choice.
 *
 * The failure this pins was measured, not hypothetical: the live database carried a provider named
 * `agent-router` whose builtin profile is keyed `agentrouter`. One hyphen, and `PROVIDER_PROFILES[p.slug]`
 * missed — the provider was served by its stored user-edited manifest, which lacked every shaping
 * declaration and sent `role:"system"` inside `messages` to an Anthropic-API endpoint. A 400 on
 * every request, and the provider never served one successful row.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_PROFILES, type AdapterManifest } from "@aiprovider/router-core";
import { resolveProviderManifest } from "./profile-select";

/** agentrouter's stored row, reduced to what the selection reads. */
const STORED_AGENT_ROUTER = JSON.stringify({
  manifestVersion: 1,
  kind: "declarative",
  dialect: "anthropic-messages-v1",
  provider: { baseUrl: "https://agentrouter.org/v1", auth: { headers: [{ name: "x-api-key" }] } },
  endpoints: {
    generateText: {
      method: "POST",
      path: "/messages",
      headers: { "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.0.18 (external, cli)" },
      requestTemplate: { model: "{{model}}", messages: "{{messages}}" },
      responseMap: { text: "$.content" },
    },
  },
  capabilities: { text: true, image: false },
  provenance: { origin: "user-edited", generatorModel: null, createdAt: "1970-01-01T00:00:00Z" },
});

const row = (bodyJson: string) => ({ bodyJson });

describe("resolveProviderManifest", () => {
  it("reaches the measured profile through a differently-spelled slug, by whole hostname", () => {
    // THE case: slug `agent-router`, profile `agentrouter`. The old lookup missed and the stored
    // (unshaped) row won.
    const m = resolveProviderManifest(
      { slug: "agent-router", baseUrl: "https://agentrouter.org/v1" },
      row(STORED_AGENT_ROUTER),
    );
    expect(m?.dialect).toBe("anthropic-messages-v1");
    // The shaped builtin, not the stored row: the role map that hoists `system` is the field the
    // stored row was missing.
    const t = m!.endpoints.generateText!;
    expect((t as unknown as Record<string, unknown>).messagesRoleMap).toBeDefined();
  });

  it("still matches an exact slug", () => {
    const m = resolveProviderManifest(
      { slug: "openrouter", baseUrl: "https://x.test/api/v1" },
      undefined,
    );
    expect(m?.provider.baseUrl).toBe("https://x.test/api/v1");
  });

  it("never matches a suffix host", () => {
    // Whole-hostname matching is the D80 rule: a lookalike host gets nothing, so a hostile lookalike
    // cannot inherit a measured profile's wiring.
    expect(
      resolveProviderManifest({ slug: "not-a-profile", baseUrl: "https://agentrouter.org.evil.test/v1" }, row(STORED_AGENT_ROUTER)),
    ).toEqual(JSON.parse(STORED_AGENT_ROUTER));
  });

  it("the stored row's operator headers survive the profile", () => {
    // The profile deliberately names no User-Agent — which client to claim is the operator's
    // client-gate decision — so a merge that dropped the stored header would trade the shaping
    // failure for a client refusal.
    const m = resolveProviderManifest(
      { slug: "agent-router", baseUrl: "https://agentrouter.org/v1" },
      row(STORED_AGENT_ROUTER),
    )!;
    const headers = (m.endpoints.generateText as { headers: Record<string, string> }).headers;
    expect(headers["user-agent"]).toBe("claude-cli/2.0.18 (external, cli)");
    // The profile's own default is still there under the merge.
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("the stored row's shaping does NOT survive — the profile's pinned facts win", () => {
    // One direction only. The stored row is a snapshot written once; the profile is current code.
    const m = resolveProviderManifest(
      { slug: "agent-router", baseUrl: "https://agentrouter.org/v1" },
      row(STORED_AGENT_ROUTER),
    )!;
    const t = m.endpoints.generateText as Record<string, unknown>;
    expect((t.messagesRoleMap as Record<string, unknown>).system).toBeNull();
  });

  it("a custom provider with no profile is served by its stored row", () => {
    const stored = JSON.parse(STORED_AGENT_ROUTER) as AdapterManifest;
    // A host with no measured profile: the row is the only source, and it must pass through.
    const m = resolveProviderManifest({ slug: "vice", baseUrl: "https://vyceai.com" }, row(STORED_AGENT_ROUTER));
    expect(m?.provider.baseUrl).toBe("https://agentrouter.org/v1");
    expect(m).not.toBeNull();
    void stored;
  });

  it("no profile and no row: null, not a throw — the caller reports it as an unregistered provider", () => {
    expect(resolveProviderManifest({ slug: "custom", baseUrl: "https://x.test/v1" }, undefined)).toBeNull();
  });

  it("a corrupt stored row still lets the profile win, and never takes the boot down", () => {
    const m = resolveProviderManifest(
      { slug: "agent-router", baseUrl: "https://agentrouter.org/v1" },
      row("{not json"),
    );
    expect(m?.dialect).toBe("anthropic-messages-v1");
  });

  it("every builtin slug still resolves to its own profile", () => {
    // The lookup was rewritten; this walks all of them so a refactor cannot quietly drop one.
    for (const slug of Object.keys(PROVIDER_PROFILES)) {
      const m = resolveProviderManifest({ slug, baseUrl: "https://x.test/v1" }, undefined);
      expect(m, slug).not.toBeNull();
      expect(m!.dialect, slug).toBe(PROVIDER_PROFILES[slug]!().dialect);
    }
  });
});

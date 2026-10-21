import { describe, expect, it } from "vitest";

import {
  AGENT_ROUTER_TIMEOUT_PROFILE,
  seedAgentRouterTimeouts,
} from "./timeout-defaults";

const agentRouter = { id: "p1", slug: "agent-router", status: "enabled" };

describe("seedAgentRouterTimeouts", () => {
  it("adds the recommended profile when the provider has none", () => {
    const next = seedAgentRouterTimeouts(undefined, [agentRouter]);
    expect(next).toEqual({ p1: AGENT_ROUTER_TIMEOUT_PROFILE });
  });

  it("is idempotent — a second run changes nothing", () => {
    const first = seedAgentRouterTimeouts(undefined, [agentRouter]);
    expect(seedAgentRouterTimeouts(first ?? undefined, [agentRouter])).toBeNull();
  });

  it("never overwrites a value the operator set", () => {
    const existing = { p1: { headerMs: 30_000 } };
    expect(seedAgentRouterTimeouts(existing, [agentRouter])).toBeNull();
  });

  it("ignores a disabled agent-router and a different provider", () => {
    expect(
      seedAgentRouterTimeouts(undefined, [{ ...agentRouter, status: "disabled" }]),
    ).toBeNull();
    expect(
      seedAgentRouterTimeouts(undefined, [
        { id: "p2", slug: "vice", status: "enabled" },
      ]),
    ).toBeNull();
  });

  it("keeps other providers' profiles", () => {
    const next = seedAgentRouterTimeouts(
      { p2: { planBudgetMs: 30_000 } },
      [agentRouter],
    );
    expect(next).toEqual({
      p2: { planBudgetMs: 30_000 },
      p1: AGENT_ROUTER_TIMEOUT_PROFILE,
    });
  });
});

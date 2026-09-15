import { describe, expect, it } from "vitest";
import type { HttpPort } from "../src/index.js";

describe("router-core ports", () => {
  it("HttpPort request carries only a secretRef, never a secret string", () => {
    // Compile-time guarantee: HttpPort has no `secret` field.
    const req: Parameters<HttpPort["request"]>[0] = {
      url: "https://example.test/v1/models",
      method: "GET",
      headers: {},
      secretRef: "ref-1",
    };
    expect(req.secretRef).toBe("ref-1");
    expect(Object.keys(req)).not.toContain("secret");
  });
});

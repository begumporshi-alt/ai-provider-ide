import { describe, expect, it } from "vitest";
import { MANIFEST_VERSION } from "../src/index.js";

describe("adapter-spec", () => {
  it("pins the frozen manifest grammar version", () => {
    expect(MANIFEST_VERSION).toBe("1.1");
  });
});

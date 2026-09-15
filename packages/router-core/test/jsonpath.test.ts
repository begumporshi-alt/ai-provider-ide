import { describe, expect, it } from "vitest";
import { selectAll, selectOne } from "../src/jsonpath.js";

const doc = {
  data: [
    { id: "a", nested: { x: 1 } },
    { id: "b", nested: { x: 2 } },
  ],
  usage: { prompt_tokens: 3 },
  "odd.key": { v: 9 },
};

describe("jsonpath subset", () => {
  it("selects child paths", () => {
    expect(selectOne(doc, "$.usage.prompt_tokens")).toBe(3);
  });
  it("selects wildcard collections", () => {
    expect(selectAll(doc, "$.data[*].id")).toEqual(["a", "b"]);
    expect(selectAll(doc, "$.data[*]")).toHaveLength(2);
  });
  it("selects array indices", () => {
    expect(selectOne(doc, "$.data[1].nested.x")).toBe(2);
  });
  it("supports quoted bracket keys", () => {
    expect(selectOne(doc, '$["odd.key"].v')).toBe(9);
  });
  it("returns undefined for missing paths, not throw", () => {
    expect(selectOne(doc, "$.data[9].id")).toBeUndefined();
    expect(selectOne(doc, "$.nope.deep")).toBeUndefined();
  });
  it("rejects unsupported syntax", () => {
    expect(() => selectAll(doc, "$..id")).toThrow();
    expect(() => selectAll(doc, "$.data[?(@.id)]")).toThrow();
  });
});

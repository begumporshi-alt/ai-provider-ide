/**
 * The boundary machinery (audit M3 + M8).
 *
 * These specs are about the *tool*, not about any one route. Two properties here are load-bearing
 * beyond this file:
 *
 * - **`HostShapeError` is not a `TypeError`.** `store.ts`'s `isUnreachable` is
 *   `e instanceof TypeError` and chooses between degrading the boot and failing it. If a shape
 *   mismatch were a `TypeError`, a broken host contract would be reported to the operator as "the
 *   gateway is not running" — the D46 failure mode, one layer up.
 * - **`isNum` rejects `NaN` and `Infinity`.** Both satisfy `typeof v === "number"`, so a bare
 *   `typeof` check would let a non-finite value through a field the app does arithmetic on.
 */
import { describe, expect, it } from "vitest";

import {
  arrayOf,
  expectShape,
  expectShapeOr,
  HostShapeError,
  isArr,
  isBool,
  isNum,
  isObj,
  isStr,
  maybe,
  nullable,
  oneOf,
  parseHostJson,
  parseHostJsonOr,
  shape,
} from "./host-boundary";

describe("primitives", () => {
  it("isNum rejects the values that survive typeof", () => {
    expect(isNum(0)).toBe(true);
    expect(isNum(-1.5)).toBe(true);
    expect(isNum(Number.NaN)).toBe(false);
    expect(isNum(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNum(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isNum("3")).toBe(false);
  });

  it("isObj is false for null and for an array", () => {
    expect(isObj({})).toBe(true);
    expect(isObj(null)).toBe(false);
    expect(isObj([])).toBe(false);
    expect(isObj("x")).toBe(false);
  });

  it("isArr distinguishes an array from an object", () => {
    expect(isArr([])).toBe(true);
    expect(isArr({})).toBe(false);
  });

  it("oneOf accepts only the declared literals", () => {
    const layer = oneOf("L0", "L1");
    expect(layer("L0")).toBe(true);
    expect(layer("L2")).toBe(false);
    expect(layer("")).toBe(false);
  });

  it("nullable accepts null but not undefined", () => {
    const g = nullable(isStr);
    expect(g("x")).toBe(true);
    expect(g(null)).toBe(true);
    expect(g(undefined)).toBe(false);
  });

  it("maybe accepts absent as well as null — a host may send either", () => {
    const g = maybe(isNum);
    expect(g(1)).toBe(true);
    expect(g(null)).toBe(true);
    expect(g(undefined)).toBe(true);
    expect(g("1")).toBe(false);
  });
});

describe("arrayOf", () => {
  it("rejects a non-array, and an array with one bad element", () => {
    const g = arrayOf(isStr);
    expect(g([])).toBe(true);
    expect(g(["a", "b"])).toBe(true);
    expect(g("a")).toBe(false);
    expect(g({})).toBe(false);
    expect(g(["a", 1])).toBe(false);
  });
});

describe("shape", () => {
  const g = shape<{ id: string; n: number | null; note?: string }>({
    id: isStr,
    n: nullable(isNum),
    note: maybe(isStr),
  });

  it("requires every listed field", () => {
    expect(g({ id: "a", n: null })).toBe(true);
    expect(g({ id: "a" })).toBe(false);
  });

  it("rejects a retyped field", () => {
    expect(g({ id: 1, n: null })).toBe(false);
    expect(g({ id: "a", n: "1" })).toBe(false);
  });

  it("ignores fields the host adds beyond the table", () => {
    // Forward compatibility, and the reason the guard is written as a field table rather than a
    // deep-equality check: a host that adds a column must not break this build.
    expect(g({ id: "a", n: null, extra: { deeply: ["nested"] } })).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(g(null)).toBe(false);
    expect(g([])).toBe(false);
  });
});

describe("parseHostJson", () => {
  it("returns the value on the good path", () => {
    expect(parseHostJson('{"port":9123}', isObj, "the row")).toEqual({ port: 9123 });
  });

  it("throws a HostShapeError on malformed JSON, naming the subject", () => {
    expect(() => parseHostJson("{not json", isObj, "the `gateway` settings row")).toThrow(
      /the `gateway` settings row: the host sent malformed JSON/,
    );
  });

  it("throws a HostShapeError when the shape is wrong", () => {
    expect(() => parseHostJson("[1,2]", isObj, "the row")).toThrow(HostShapeError);
  });

  it("reports the failure as an Error but never as a TypeError", () => {
    const err = (() => {
      try {
        parseHostJson("{not json", isObj, "the row");
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HostShapeError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as HostShapeError).name).toBe("HostShapeError");
  });
});

describe("parseHostJsonOr", () => {
  const fallback = { port: 8787 };

  it("returns the parsed value when it is usable", () => {
    expect(parseHostJsonOr('{"port":9123}', isObj, fallback, "the row")).toEqual({ port: 9123 });
  });

  it("falls back on malformed JSON", () => {
    expect(parseHostJsonOr("{not json", isObj, fallback, "the row")).toEqual(fallback);
  });

  it("falls back on a wrong shape", () => {
    expect(parseHostJsonOr("[1,2]", isObj, fallback, "the row")).toEqual(fallback);
  });
});

describe("expectShape / expectShapeOr", () => {
  it("expectShape returns a validated value and throws otherwise", () => {
    expect(expectShape({ ok: true }, isObj, "POST /x")).toEqual({ ok: true });
    expect(() => expectShape([], isObj, "POST /x")).toThrow(/POST \/x/);
  });

  it("expectShapeOr substitutes the fallback instead of throwing", () => {
    // The policy for flag reads: a missing field is already the safe answer, so a shape this build
    // does not recognise must degrade rather than turn a working default into a crash.
    expect(expectShapeOr(undefined, shape<{ ok: boolean }>({ ok: isBool }), { ok: false })).toEqual({
      ok: false,
    });
  });

  it("isBool is what makes a truthy non-boolean fail rather than pass", () => {
    const g = shape<{ ok: boolean }>({ ok: isBool });
    expect(g({ ok: 1 })).toBe(false);
    expect(g({ ok: "true" })).toBe(false);
  });
});

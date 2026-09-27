/**
 * The boundary between untrusted host JSON and this app's domain types.
 *
 * Every `/admin/*` response arrives as `unknown`: the host is a separate process and TypeScript
 * cannot check its shape. This repo has been *asserting* those responses into domain types instead
 * (`as Promise<HostProviderRow[]>`), which converts a host-side shape change into an `undefined`
 * read deep inside rendering rather than an error at the boundary.
 *
 * **Two policies, because one of them would be wrong.**
 *
 * - `parseHostJson` / `expectShape` **throw** a `HostShapeError`. For a read that feeds rendering, a
 *   shape this build does not understand is a real fault and belongs named where it happened.
 * - `parseHostJsonOr` / `expectShapeOr` **default**. For a boolean flag or an optional settings blob,
 *   a missing field is *already* the safe answer (`undefined` is falsy), so throwing would replace a
 *   working default with a crash. Converting those to throws would be a regression, not a fix.
 *
 * **`HostShapeError` extends `Error`, deliberately not `TypeError`.** `store.ts`'s `isUnreachable`
 * is `e instanceof TypeError` and decides whether the boot degrades or fails. A shape mismatch is
 * not "the gateway is not listening", and must not be laundered into a silent degradation — the
 * whole point is that it surfaces as the real fault it is.
 *
 * **This module imports nothing.** `gateway-client.ts` needs `parseHostJsonOr`, so it must not be
 * imported back from here or the two would form a cycle.
 */

/** A predicate that narrows `unknown` to `T`. */
export type Guard<T> = (v: unknown) => v is T;

/** A host payload this build does not understand. Never a `TypeError` — see the module note. */
export class HostShapeError extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: the host sent ${detail}`);
    this.name = "HostShapeError";
  }
}

// ---------- primitives ----------

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isStr = (v: unknown): v is string => typeof v === "string";

/** Finite only: `NaN` and `Infinity` are not values a row carries, and both survive `typeof`. */
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

/** For a `T | null` field. */
export const nullable =
  <T>(g: Guard<T>): Guard<T | null> =>
  (v): v is T | null =>
    v === null || g(v);

/** For an optional field, which the host may send absent or as an explicit `null`. */
export const maybe =
  <T>(g: Guard<T>): Guard<T | undefined> =>
  (v): v is T | undefined =>
    v === undefined || v === null || g(v);

/** For a string-literal union: `isStr` alone would accept a layer this UI has never heard of. */
export const oneOf =
  <T extends string>(...allowed: readonly T[]): Guard<T> =>
  (v): v is T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v);

export function arrayOf<T>(g: Guard<T>): Guard<T[]> {
  return (v): v is T[] => isArr(v) && v.every(g);
}

/**
 * Build a guard from a field table. Every listed field is checked, so a row missing one — or
 * carrying the wrong type for it — is rejected. Fields the host sends *beyond* the table are
 * ignored: this checks the contract the app reads, not the whole row, so a host that adds a column
 * does not break the UI.
 *
 * The mapped type is load-bearing. It ties each guard to its field's declared type, so
 * `shape<HostKeyRow>({ priority: isStr })` is a compile error rather than a boundary that quietly
 * checks the wrong thing. For an optional field `score?: number`, `T[K]` is `number | undefined`,
 * which is exactly what `maybe(isNum)` returns.
 */
export function shape<T>(fields: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> {
  const keys = Object.keys(fields) as (keyof T)[];
  return (v): v is T => isObj(v) && keys.every((k) => (fields[k] as Guard<unknown>)(v[k as string]));
}

// ---------- raw JSON, for a value held as a string ----------

/** Parse and validate `raw`, or throw a `HostShapeError` naming what was expected. */
export function parseHostJson<T>(raw: string, guard: Guard<T>, what: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HostShapeError(what, `malformed JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!guard(parsed)) throw new HostShapeError(what, "a shape this build does not understand");
  return parsed;
}

/** Parse and validate `raw`, falling back when the payload is unusable. For flag/settings reads. */
export function parseHostJsonOr<T>(raw: string, guard: Guard<T>, fallback: T, what: string): T {
  try {
    return parseHostJson(raw, guard, what);
  } catch {
    return fallback;
  }
}

// ---------- an already-parsed value, for a `fetchAdmin` result ----------

/** Validate an already-parsed value, or throw a `HostShapeError` naming what was expected. */
export function expectShape<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (!guard(value)) throw new HostShapeError(what, "a shape this build does not understand");
  return value;
}

/** Validate an already-parsed value, falling back when it is unusable. */
export function expectShapeOr<T>(value: unknown, guard: Guard<T>, fallback: T): T {
  return guard(value) ? value : fallback;
}

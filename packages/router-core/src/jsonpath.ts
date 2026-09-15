/**
 * The deliberately tiny JSONPath subset used by manifests (§2.6):
 *   $                       root
 *   .field                 child
 *   [0]                    array index
 *   [*]                    wildcard (array/object) — yields a collection
 *   .. is NOT supported. No filters, no expressions, no functions.
 *
 * Returns the first match as `selectOne`, all matches as `selectAll`.
 * Safe by construction: pure traversal, nothing evaluated.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function parsePath(path: string): (string | number | "*")[] {
  if (!path.startsWith("$")) throw new Error(`jsonpath must start with $: ${path}`);
  const steps: (string | number | "*")[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      i++;
      let name = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") name += path[i++];
      if (!name) throw new Error(`empty step in ${path}`);
      steps.push(name);
    } else if (c === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) throw new Error(`unclosed [ in ${path}`);
      const inner = path.slice(i + 1, end);
      steps.push(inner === "*" ? "*" : /^\d+$/.test(inner) ? Number(inner) : parseQuoted(inner, path));
      i = end + 1;
    } else {
      throw new Error(`unexpected char ${c} in ${path}`);
    }
  }
  return steps;
}

function parseQuoted(inner: string, path: string): string {
  if (/^"(.*)"$/.test(inner) || /^'(.*)'$/.test(inner)) return inner.slice(1, -1);
  throw new Error(`unsupported bracket selector ${inner} in ${path}`);
}

function children(v: Json): [string | number, Json][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x] as [number, Json]);
  if (v && typeof v === "object") return Object.entries(v);
  return [];
}

function walk(node: Json, steps: (string | number | "*")[]): Json[] {
  if (steps.length === 0) return [node];
  const [step, ...rest] = steps as [(string | number | "*"), ...(string | number | "*")[]];
  if (step === "*") {
    return children(node).flatMap(([, v]) => walk(v, rest));
  }
  if (typeof step === "number") {
    if (!Array.isArray(node)) return [];
    const v = node[step];
    return v === undefined ? [] : walk(v, rest);
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const v = (node as Record<string, Json>)[step];
    return v === undefined ? [] : walk(v, rest);
  }
  return [];
}

export function selectAll(json: unknown, path: string): unknown[] {
  return walk(json as Json, parsePath(path));
}

export function selectOne(json: unknown, path: string): unknown {
  const all = selectAll(json, path);
  return all.length ? all[0] : undefined;
}

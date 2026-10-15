/**
 * What an outgoing request body *looks like*, recorded at the moment a provider refuses it.
 *
 * **Rust twin: `apps/desktop/src-tauri/src/core/body_shape.rs`.** The two are kept in step by hand,
 * the way `tool-shaping.ts`/`dialect_shaping.rs` are, and the test names below are the Rust test
 * names so a divergence is visible by diffing the two files.
 *
 * **Why this exists.** Four refusals in a row reached the ledger as
 * `500 … "invalid_request_error"` and nothing else — D107, D108, D109 and D110. Nothing about the
 * request survives a failure: no outgoing body is persisted anywhere, `failure_detail` is written
 * as `None` on every row, and the refusal text describes the *response*, never the request that
 * caused it. So each one was diagnosed by archaeology — reading `agent_steps`, replays of a session
 * transcript through the real shaping pipeline, and hand probes against the upstream — and **D110 is
 * still unexplained, because its request was never written down at all.**
 *
 * A body a provider calls invalid is invalid *structurally*: an unanswered `tool_use`, a duplicated
 * id, a part type that is not a part, a `tool_use` naming a tool that was never declared. Every one
 * of those is visible in the request the instant it is sent.
 *
 * **Structural only, by design.** Ids, counts, roles and part types — never message text, never an
 * image's bytes. That is what makes it safe to attach to an error: it can say *"`call_2` at message
 * 1 is unanswered"* without carrying the conversation.
 */

/** How many ids of a kind are named before the remainder are counted instead. */
const MAX_NAMED = 5;

/** Part types this router renders for at least one dialect. Anything else is reported. */
const KNOWN_PART_TYPES = [
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
];

/**
 * Whether a status is one where the *body* is what the provider is objecting to.
 *
 * The gate exists so the report lands only where it can be true. A `401`/`402`/`403`/`404`/`429` is
 * about the key, the balance, the route or the pace — the request's shape is not in question, and a
 * line about it there is noise that trains the reader to skip the line that matters. `400`/`422` are
 * the schema statuses proper; a `5xx` is included because the case this was built for arrived as
 * `500`: the aggregator reports a refusal past its own edge as a server error, with `tokens_in = 0`,
 * because the request never reached the model.
 */
export function isShapeRefusal(status: number): boolean {
  return status === 400 || status === 422 || status >= 500;
}

type Json = Record<string, unknown>;

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asObject(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A tool's name, from Anthropic's flat `{name}` or OpenAI's nested `{function:{name}}`. */
function declaredToolName(t: unknown): string | undefined {
  const o = asObject(t);
  if (!o) return undefined;
  const flat = str(o.name);
  if (flat !== undefined) return flat;
  return str(asObject(o.function)?.name);
}

/** The `tool_use` ids a part-array message declares. */
function toolUseIds(m: Json): string[] {
  return (asArray(m.content) ?? [])
    .map(asObject)
    .filter((p): p is Json => Boolean(p))
    .filter((p) => p.type === "tool_use")
    .map((p) => str(p.id))
    .filter((id): id is string => id !== undefined);
}

/**
 * The ids a message answers: `tool_result` parts, plus a bare `tool_call_id` so a `role:"tool"`
 * message counts as an answer too. Tolerating both keeps the check from reporting a violation for a
 * body that mixes the two shapes — a false accusation is the failure mode worth avoiding here.
 */
function toolResultIds(m: Json | undefined): Set<string> {
  const out = new Set<string>();
  if (m) {
    for (const p of (asArray(m.content) ?? []).map(asObject)) {
      if (p && p.type === "tool_result") {
        const id = str(p.tool_use_id);
        if (id !== undefined) out.add(id);
      }
    }
    const bare = str(m.tool_call_id);
    if (bare !== undefined) out.add(bare);
  }
  return out;
}

/** The ids an OpenAI-shaped turn calls. */
function toolCallIds(m: Json): string[] {
  return (asArray(m.tool_calls) ?? [])
    .map(asObject)
    .filter((c): c is Json => Boolean(c))
    .map((c) => str(c.id))
    .filter((id): id is string => id !== undefined);
}

function histogram(counts: Map<string, number>): string {
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(",");
}

/**
 * The named items, or the first {@link MAX_NAMED} and a count of the rest — a body can carry
 * thousands of ids and the line has to stay a line.
 */
function capped(items: string[]): string {
  const quoted = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  if (items.length <= MAX_NAMED) return quoted(items);
  return `${quoted(items.slice(0, MAX_NAMED))}+${items.length - MAX_NAMED}more`;
}

/**
 * A one-line structural description of an outgoing request body.
 *
 * `bytes` is the serialized length, passed in rather than recomputed: the caller has just serialized
 * the body to send it, and re-serializing a multi-megabyte request on the failure path would double
 * the memory cost of the failure for a number it already knows.
 */
export function describeRequest(body: Json, bytes: number): string {
  const messages = asArray(body.messages);
  if (!messages) return `request ${bytes}B messages=absent`;

  const objs = messages.map(asObject);

  // **Which pairing rule applies is decided by the body, once.** The part-array shape (Anthropic,
  // Gemini) answers a `tool_use` with a `tool_result` in the message immediately after it. The
  // OpenAI shape answers a `tool_calls` entry with a `role:"tool"` message. Applying the array rule
  // to an OpenAI body would accuse every turn it has, which is worse than saying nothing — a
  // diagnostic that cries wolf is one nobody reads.
  const arrayShape = objs.some((m) =>
    (asArray(m?.content) ?? [])
      .map(asObject)
      .some((p) => p?.type === "tool_use" || p?.type === "tool_result"),
  );

  const declared = (asArray(body.tools) ?? [])
    .map(declaredToolName)
    .filter((n): n is string => n !== undefined);

  const roles = new Map<string, number>();
  const parts = new Map<string, number>();
  const emptyContent: string[] = [];
  const unknownParts: string[] = [];
  const undeclaredTools: string[] = [];
  const unanswered: string[] = [];
  const orphanResults: string[] = [];
  const duplicateIds: string[] = [];
  const declaredIds = new Set<string>();
  let emptyTextParts = 0;

  objs.forEach((m, i) => {
    if (!m) return;
    const role = str(m.role) ?? "<no-role>";
    roles.set(role, (roles.get(role) ?? 0) + 1);

    // An assistant turn with empty content is legal for a tool call (it is *required*, for OpenAI)
    // and is still worth counting: it is the message a naive reader calls "blank". (`m0` spelled as
    // a JSON string, so that a text part whose text reads "m0" is never mistaken for a message id.)
    if (m.content === "" || (Array.isArray(m.content) && m.content.length === 0)) {
      emptyContent.push(`m${i}`);
    }

    // The OpenAI shape's pairing, on its own terms: the `tool` messages that follow must answer
    // every id this turn called.
    if (!arrayShape) {
      const calls = toolCallIds(m);
      if (calls.length > 0) {
        const answered = new Set<string>();
        for (let n = i + 1; n < objs.length; n++) {
          if (objs[n]?.role !== "tool") break;
          const id = str(objs[n]?.tool_call_id);
          if (id !== undefined) answered.add(id);
        }
        for (const id of calls) if (!answered.has(id)) unanswered.push(`${id}@m${i}`);
      }
    }

    const arr = asArray(m.content);
    if (arr) {
      arr.forEach((raw) => {
        const part = asObject(raw);
        if (!part) {
          unknownParts.push(`<non-object>@m${i}`);
          return;
        }
        const ty = str(part.type) ?? "<no-type>";
        parts.set(ty, (parts.get(ty) ?? 0) + 1);
        if (!KNOWN_PART_TYPES.includes(ty)) unknownParts.push(`${ty}@m${i}`);
        if (ty === "text") {
          if (!str(part.text)) emptyTextParts++;
        } else if (ty === "tool_use") {
          const id = str(part.id);
          if (id !== undefined) {
            if (declaredIds.has(id)) duplicateIds.push(id);
            declaredIds.add(id);
          }
          // A call to a tool the request never declared has no schema to validate against, which
          // strict providers refuse. Only checked when `tools` is present: a body with no `tools` at
          // all is a different question.
          const name = str(part.name);
          if (name !== undefined && declared.length > 0 && !declared.includes(name)) {
            undeclaredTools.push(`${name}@m${i}`);
          }
        } else if (ty === "tool_result") {
          const id = str(part.tool_use_id);
          if (id !== undefined && !declaredIds.has(id)) orphanResults.push(`${id}@m${i}`);
        }
      });
    }

    // **The check that would have named D109 on sight.** Every `tool_use` of this message must be
    // answered by a `tool_result` in the message immediately after it; the provider's own words for
    // a violation are quoted in that row's entry.
    if (arrayShape) {
      const uses = toolUseIds(m);
      if (uses.length > 0) {
        const answered = toolResultIds(objs[i + 1]);
        for (const id of uses) if (!answered.has(id)) unanswered.push(`${id}@m${i}`);
      }
    }
  });

  let out = `request ${bytes}B messages=${messages.length}`;
  out += ` roles{${histogram(roles)}}`;
  if (parts.size > 0) out += ` parts{${histogram(parts)}}`;
  if (declared.length > 0) out += ` tools=${declared.length}`;
  if (emptyContent.length > 0) out += ` empty_content=${capped(emptyContent)}`;
  if (emptyTextParts > 0) out += ` empty_text_parts=${emptyTextParts}`;
  if (unknownParts.length > 0) out += ` unknown_parts=${capped(unknownParts)}`;
  // Capitalised, and first among the findings, because these four are the ones that make a body
  // *invalid* rather than merely unusual.
  if (unanswered.length > 0) out += ` UNANSWERED_TOOL_USE=${capped(unanswered)}`;
  if (orphanResults.length > 0) out += ` ORPHAN_TOOL_RESULT=${capped(orphanResults)}`;
  if (duplicateIds.length > 0) out += ` DUPLICATE_TOOL_USE_ID=${capped(duplicateIds)}`;
  if (undeclaredTools.length > 0) out += ` UNDECLARED_TOOL=${capped(undeclaredTools)}`;
  // Said out loud, because "nothing to see" is itself an answer: it rules the shape out and sends
  // the next investigation to the content, which is what D110 still needs.
  const clean =
    unanswered.length === 0 &&
    orphanResults.length === 0 &&
    duplicateIds.length === 0 &&
    undeclaredTools.length === 0 &&
    unknownParts.length === 0 &&
    emptyContent.length === 0 &&
    emptyTextParts === 0;
  if (clean) out += " shape=clean";
  return out;
}

/**
 * The shape to attach to a refusal, or `undefined` when the status is not about the body.
 *
 * One call so the gate and the description cannot drift apart at the call site.
 */
export function refusalShape(
  status: number,
  body: Json,
  bytes: number,
): string | undefined {
  return isShapeRefusal(status) ? describeRequest(body, bytes) : undefined;
}

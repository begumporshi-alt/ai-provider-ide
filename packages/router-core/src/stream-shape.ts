/**
 * What a stream actually carried when it produced no text — the evidence a `PARSE_ERROR` row is
 * made of.
 *
 * Why this exists, in one measured case. On 2026-10-02 the ledger held:
 *
 *   stream carried 8198 SSE event(s), none matched the manifest's delta selector;
 *   first: {"type":"message_start","content_block":null,"delta":null,"error":null,"index":0…
 *
 * Both halves of that were misleading, and together they sent a diagnosis to the wrong file:
 *
 *  1. The sample was the **first event**, and on every Anthropic stream the first event is
 *     `message_start` — a lifecycle event, never representative of the deltas. The 8198 events it
 *     stood in for were all `thinking_delta`.
 *  2. Nothing separated a stream whose every delta was **model reasoning** from one whose shape the
 *     manifest genuinely cannot read. The first is the provider behaving correctly and a model that
 *     never emitted a text block; the second is a manifest to go and fix. Different owners — and the
 *     row named neither, so the manifest got the blame.
 *
 * `delta.text` versus `delta.thinking` is the same distinction `anthropic-text-blocks.test.ts`
 * records for the unary path; the two are told apart by field name, so a reasoning delta never
 * reaches `chunkMap.delta` and its absence is not a defect anywhere.
 */

export type DeltaKind = "text" | "reasoning" | "tool" | "lifecycle" | "other";

export interface DeltaVerdict {
  kind: DeltaKind;
  /**
   * The field the payload carried its content in, named for the ledger. `delta.thinking` versus
   * `delta.reasoning_content` is the difference between an Anthropic reasoning model and an
   * OpenAI-compatible one, and it is what an operator needs to judge the finding.
   */
  field?: string;
  /**
   * True when this payload carried the delta itself, false for a `content_block_start` that only
   * announces a block. The distinction matters only for naming: an announcement has no field yet,
   * so letting it name the reasoning sends the reader to a key that is still null.
   */
  carried?: boolean;
}

/**
 * Anthropic's lifecycle events. They legitimately carry no delta, so a stream of only these is "the
 * provider answered and had nothing to say" rather than a shape failure.
 */
const LIFECYCLE_TYPES = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "ping",
  "content_block_start",
  "content_block_stop",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The delta object, wherever this dialect puts it: top level for Anthropic and for an already
 * unwrapped body, `choices[0].delta` for a raw OpenAI chunk.
 */
function deltaOf(json: unknown): { delta: Record<string, unknown>; path: string } | undefined {
  if (!isRecord(json)) return undefined;
  if (isRecord(json.delta)) return { delta: json.delta, path: "" };
  const choices = json.choices;
  if (Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0].delta)) {
    return { delta: choices[0].delta, path: "choices[0]." };
  }
  return undefined;
}

/**
 * One SSE payload, classified. Never throws: a payload the provider sent is evidence even when it
 * is not JSON, and a classifier that threw would replace the finding with a second failure.
 */
export function classifyDelta(payload: string): DeltaVerdict {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { kind: "other", field: "not JSON" };
  }
  const found = deltaOf(json);
  if (!found) {
    if (isRecord(json)) {
      // `content_block_start` announcing a thinking block: the reasoning is real before its deltas
      // arrive, and reporting it as a lifecycle event that carried nothing would hide that.
      const cb = json.content_block;
      if (isRecord(cb) && cb.type === "thinking") {
        return { kind: "reasoning", field: "content_block.thinking" };
      }
      const type = json.type;
      if (typeof type === "string" && LIFECYCLE_TYPES.has(type)) return { kind: "lifecycle" };
    }
    return { kind: "other" };
  }
  const { delta, path } = found;
  const type = typeof delta.type === "string" ? delta.type : "";
  // Text first: `text` is Anthropic's field, `content` is OpenAI's, `text_delta` the declared
  // discriminator. Any of the three means this event carried the answer.
  if (type === "text_delta" || typeof delta.text === "string" || typeof delta.content === "string") {
    return {
      kind: "text",
      field: `${path}delta.${typeof delta.text === "string" ? "text" : "content"}`,
      carried: true,
    };
  }
  if (type === "thinking_delta" || typeof delta.thinking === "string") {
    return { kind: "reasoning", field: `${path}delta.thinking`, carried: true };
  }
  // OpenAI-compatible reasoning models: DeepSeek, and the `reasoning_content` several gateways add.
  if (typeof delta.reasoning_content === "string" || type === "reasoning") {
    return { kind: "reasoning", field: `${path}delta.reasoning_content`, carried: true };
  }
  if (type === "input_json_delta" || typeof delta.partial_json === "string" || Array.isArray(delta.tool_calls)) {
    return {
      kind: "tool",
      field: `${path}delta.${Array.isArray(delta.tool_calls) ? "tool_calls" : "partial_json"}`,
      carried: true,
    };
  }
  return { kind: "other", field: type || undefined };
}

/**
 * The reasoning text one SSE payload carried, or `undefined`.
 *
 * The streaming twin of what `selectText` already does for the unary path
 * (`manifest-interpreter.ts`): there, a `thinking` block that leads the `content` array is read
 * past so the answer behind it still arrives. Streaming had no equivalent — `chunkMap.delta` is
 * `$.delta.text`, so every `thinking_delta` was dropped on the floor and a model that reasons
 * past its output budget delivered **nothing at all** to the caller.
 *
 * Keyed on the payload's own field names rather than on a manifest selector, for the same reason
 * `classifyDelta` is: the two dialects put reasoning in two different places (`delta.thinking` for
 * Anthropic, `delta.reasoning_content` for the OpenAI-compatible gateways and DeepSeek), and a
 * provider wired up before this existed has no selector to add — measured on the live
 * `agent-router` manifest, whose persisted `chunkMap` is `{delta}` alone. A field-name read fixes
 * every configured provider at once, including the ones already in the database.
 *
 * Only a non-empty string counts. Some gateways send `thinking: ""` on the block announcement and
 * some send an object (OpenRouter's `reasoning_details`); neither is text to show a reader.
 */
export function reasoningDeltaOf(payload: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const found = deltaOf(json);
  if (!found) return undefined;
  const { delta } = found;
  if (typeof delta.thinking === "string" && delta.thinking) return delta.thinking;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  // A third spelling some compatible gateways use. Checked last so the two named in the manifest
  // vocabulary win when a provider sends more than one.
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  return undefined;
}

export interface StreamTally {
  events: number;
  text: number;
  reasoning: number;
  tool: number;
  lifecycle: number;
  /** Parsed but unrecognised, or not JSON at all. */
  other: number;
  /** The very first payload, whatever it was. Only quoted when no delta arrived at all. */
  firstEvent?: string;
  /**
   * The first payload that carried a **delta**, which is the representative sample. On Anthropic
   * every stream opens with `message_start`, so sampling positionally quoted a lifecycle event
   * while the deltas — the actual evidence — went unsaid.
   */
  firstDelta?: string;
  /** The first reasoning field seen, so the wording can name it. */
  reasoningField?: string;
}

export function emptyTally(): StreamTally {
  return { events: 0, text: 0, reasoning: 0, tool: 0, lifecycle: 0, other: 0 };
}

function sample(payload: string, cap: number): string {
  // Code-point safe, deliberately not `slice`: a UTF-16 cut can land between a surrogate pair and
  // leave a lone half in the ledger. The streaming twin of the char-boundary rule the Rust
  // `StreamObservation` follows, applied at the capture point.
  const points = Array.from(payload);
  return points.length <= cap ? payload : `${points.slice(0, cap).join("")}…`;
}

/** Record one `data:` payload. Called for every event, before any selector runs. */
export function noteStreamEvent(tally: StreamTally, payload: string, sampleChars = 240): void {
  tally.events++;
  const verdict = classifyDelta(payload);
  switch (verdict.kind) {
    case "text":
      tally.text++;
      break;
    case "reasoning":
      tally.reasoning++;
      // Only a payload that carried the delta names the field the reasoning streamed in. An
      // announcement would name a key that is still null, which is worse than naming none.
      if (verdict.carried && verdict.field) tally.reasoningField ??= verdict.field;
      break;
    case "tool":
      tally.tool++;
      break;
    case "lifecycle":
      tally.lifecycle++;
      break;
    default:
      tally.other++;
      break;
  }
  tally.firstEvent ??= sample(payload, sampleChars);
  // Gated on `carried`, so this is the first payload that actually held a delta. A
  // `content_block_start` announcement is not one, and quoting it would put a lifecycle-shaped
  // event back into the row — the defect this module exists to remove.
  if (tally.firstDelta === undefined && verdict.carried) {
    tally.firstDelta = sample(payload, sampleChars);
  }
}

/**
 * Why a reasoning-only stream stopped, and what the operator can do about it. Appended to the
 * finding rather than replacing any of it: the facts (8197 events, all `delta.thinking`) are what
 * a reader needs to trust the diagnosis, and the advice is what they need to act on it.
 */
function reasoningAdvice(finish: string | undefined): string {
  if (finish === "length") {
    // The measured case: `deepseek-v4-flash` on `agentrouter.org` enables extended thinking by
    // default, `max_tokens` covers thinking **and** answer, and the thinking consumed all 8192 —
    // so `stop_reason` arrived as `max_tokens` with no text block ever opened. Probed 2026-10-02:
    // the same prompt answers at `max_tokens: 64000`, and answers in 9 s with
    // `thinking: {"type":"disabled"}`.
    return (
      "; the model spent its entire output budget reasoning and stopped at the limit before " +
      "answering a word — raise this provider's max output tokens, or turn thinking off for it"
    );
  }
  return "; the model stopped before answering";
}

/**
 * The ledger wording for a stream that yielded nothing. Three findings, which a reader acts on
 * differently — the reason the tally is kept rather than just a count:
 *
 *  - nothing at all → the provider sent no events
 *  - every delta reasoning → the provider behaved correctly and the model never emitted text, so
 *    there is no manifest to fix and the selector is not at fault
 *  - otherwise → a shape the manifest does not select, with a representative delta quoted
 *
 * `finish` is the dialect's finish reason (`"length"` when the output cap was reached), optional
 * because a provider need not send one. It changes only the advice, never the finding.
 */
export function describeSilentStream(tally: StreamTally, finish?: string): string {
  if (tally.events === 0) return "stream carried no SSE events at all";
  const quoted = tally.firstDelta ?? tally.firstEvent;
  if (quoted === undefined) {
    return `stream carried ${tally.events} SSE event(s) with no readable payload`;
  }
  const head = `stream carried ${tally.events} SSE event(s), none matched the manifest's delta selector`;
  if (tally.text === 0 && tally.tool === 0 && tally.reasoning > 0) {
    return (
      `${head}; every delta was model reasoning (${tally.reasoningField ?? "reasoning"}) and no text ` +
      `was sent, so the selector is not at fault${reasoningAdvice(finish)}; first delta: ${quoted}`
    );
  }
  return `${head}; first: ${quoted}`;
}

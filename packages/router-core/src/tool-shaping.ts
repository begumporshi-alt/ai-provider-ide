/**
 * Tool shaping (2026-10-01).
 *
 * Until this module existed, "tools" existed in the grammar only as three request placeholders
 * (`{{tools}}`, `{{toolChoice}}`) and two response selectors. Everything between them — what a
 * dialect's *declaration* of a tool looks like, how a past call and its result are replayed back
 * into a conversation, and how a provider's own tool-call block is read — was OpenAI's shape,
 * hardcoded. A dialect that disagreed could not be described:
 *
 *   - OpenAI wants `{type:"function", function:{name, description, parameters}}` and, on replay, a
 *     sibling `tool_calls` array plus `role:"tool"` results.
 *   - Anthropic wants `{name, description, input_schema}` and, on replay, `tool_use` / `tool_result`
 *     content *blocks*.
 *   - Gemini wants `{name, description, parameters}` nested under `functionDeclarations`, and, on
 *     replay, `functionCall` / `functionResponse` *parts*.
 *
 * The consequence measured here: **gemini-compat declared no tool field at all**, so a Gemini
 * request went out with no tool declarations, and a Gemini response's `functionCall` parts were
 * never reported — the model's tool call was simply lost, and no tool ever ran. Agent mode against
 * a Gemini model could not work, and nothing in the log said why.
 *
 * The fix follows the precedent set for multimodal content (`content-parts.ts`): the dialect
 * declares its shapes, and one shaper renders them. Three declarations cover it —
 * `toolDeclarationTemplates`, the `toolCall`/`toolResult` keys of `contentPartTemplates`, and
 * `responseMap.toolCallShape` — and a dialect that declares none of them gets exactly the
 * behaviour it had before.
 */
import type { ToolCall } from "./ports.js";

/** `JSON.stringify` that cannot throw. Dialect blocks come from a provider's response, so a
 *  cyclic or otherwise unserialisable value is possible and must not take the request down. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Read a dotted field out of one tool-call block (`"function.name"`, `"functionCall.args"`).
 *
 * Deliberately NOT the `$`-selector language used elsewhere in a manifest. Those selectors pick
 * *where in the response* the blocks are; this picks a field *inside one already-selected block*,
 * and it has no reason to support filters, wildcards or indexing — a shape that could address more
 * than one value would make "which name?" a question the shaper cannot answer.
 *
 * A missing field is `undefined`, never an error: reading a shape off a response must not throw on
 * a provider that omitted an optional piece.
 */
export function blockField(block: unknown, path: string): unknown {
  let cur: unknown = block;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** How to recognize a tool call among the blocks `responseMap.toolCalls` selects. */
export interface ToolCallDiscriminator {
  /** Dotted path within the block. */
  path: string;
  /** Matches when the field strictly equals this value (OpenAI `type:"function"`, Anthropic
   *  `type:"tool_use"`). */
  equals?: string | number | boolean | null;
  /**
   * Matches when the field is present at all — the check Gemini needs, and the reason this is a
   * separate arm rather than an `equals` against something.
   *
   * Gemini's parts carry **no `type`**: the shape itself is the discriminator, so a function call
   * is `{functionCall:{…}}` and a text part is `{text:…}`. There is no value to compare against and
   * no key that holds one, which is exactly why the earlier assumption ("a tool call is a block
   * with type tool_use or function") could not be extended to it.
   */
  present?: boolean;
}

export interface ToolCallShape {
  /** Absent = every selected block is a candidate. */
  discriminator?: ToolCallDiscriminator;
  id?: string;
  name: string;
  arguments: string;
  /**
   * `json-string` (default) — the value is JSON *text* to be carried through as-is. OpenAI's
   * `function.arguments`, which is a string by protocol, and which streams as string fragments.
   * `object` — the value is already the arguments object (Gemini's `args`, Anthropic's `input`).
   *
   * The distinction is not cosmetic: the internal `ToolCall.arguments` is JSON text (that is what
   * every consumer parses), so an object has to be serialised on the way in.
   */
  argumentsFormat?: "json-string" | "object";
  /**
   * How the dialect delivers a tool call **in a stream**.
   *
   * `fragments` (default) — successive events carry pieces of one JSON string that must be
   * concatenated (OpenAI's `delta.tool_calls[].function.arguments`).
   * `whole` — each event carries a complete call (Gemini). There is no fragmenting to do.
   *
   * The rule is declared rather than inferred, but it is worth noting why it is *derivable*: a
   * streamed call can only be fragmented when its arguments are a string, because fragments of an
   * object are not a thing a wire format can carry. `argumentsFormat` and `streamedAs` therefore
   * cannot disagree in practice — and if a future dialect declares the impossible pair, the
   * explicit field is what decides.
   */
  streamedAs?: "fragments" | "whole";
}

/** Does this block look like a tool call under the dialect's declared shape? */
export function isToolCallBlock(block: unknown, shape: ToolCallShape): boolean {
  const d = shape.discriminator;
  if (!d) return true;
  const v = blockField(block, d.path);
  if (d.present !== undefined) return d.present ? v !== undefined && v !== null : v === undefined || v === null;
  if (d.equals === undefined) return true;
  return v === d.equals;
}

/**
 * Read one block as a tool call, or `null` when it is not one.
 *
 * `null` rather than a call with empty fields: a nameless tool call is not a degraded call, it is
 * not a call at all. (Before this, an unrecognised block produced exactly that — a `ToolCall` with
 * no name and no arguments — which the loop then handed to a host that could only refuse it.)
 */
export function readToolCall(block: unknown, shape: ToolCallShape): ToolCall | null {
  if (!block || typeof block !== "object") return null;
  if (!isToolCallBlock(block, shape)) return null;
  const name = blockField(block, shape.name);
  if (typeof name !== "string" || name === "") return null;

  const rawArgs = blockField(block, shape.arguments);
  const args =
    shape.argumentsFormat === "object"
      ? rawArgs === undefined || rawArgs === null
        ? ""
        : stringify(rawArgs)
      : typeof rawArgs === "string"
        ? rawArgs
        : rawArgs === undefined || rawArgs === null
          ? ""
          : stringify(rawArgs);

  const id = shape.id ? blockField(block, shape.id) : undefined;
  return {
    ...(typeof id === "string" && id ? { id } : {}),
    name,
    arguments: args,
    raw: block,
  };
}

/** Read every tool call out of an already-selected array of blocks. */
export function readToolCalls(blocks: unknown, shape: ToolCallShape): ToolCall[] {
  if (!Array.isArray(blocks)) {
    const one = readToolCall(blocks, shape);
    return one ? [one] : [];
  }
  const out: ToolCall[] = [];
  for (const b of blocks) {
    const call = readToolCall(b, shape);
    if (call) out.push(call);
  }
  return out;
}

/** A dialect's declaration template, keyed by the internal tool type (today only `"function"`). */
export type ToolDeclarationTemplates = Record<string, Record<string, unknown>>;

/**
 * Reshape the caller's OpenAI-shaped `tools` array into the dialect's own declaration shape.
 *
 * A dialect that declares nothing gets the array back untouched, which is what keeps every
 * manifest written before this module working exactly as it did.
 *
 * `parameters` is defaulted rather than passed through as `undefined`: a declaration without a
 * parameter schema is rejected by Gemini, and the repo already carries the same default in the
 * other direction (`declaration_to_openai` in `gateway_gemini.rs` fills in the empty object schema
 * when *reading* a Gemini declaration). One default, stated once on each side.
 */
export function shapeToolDeclarations(
  tools: unknown,
  templates: ToolDeclarationTemplates | undefined,
  render: (template: Record<string, unknown>, values: Record<string, unknown>) => unknown,
  wrapper?: Record<string, unknown>,
): unknown {
  if (!templates || !Array.isArray(tools)) return tools;
  const declarations = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const t = tool as Record<string, unknown>;
    const type = typeof t.type === "string" ? t.type : "function";
    const template = templates[type];
    if (!template) return tool;
    const fn = (t.function && typeof t.function === "object" ? t.function : {}) as Record<string, unknown>;
    return render(template, {
      name: fn.name ?? "",
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  });
  // The container goes on LAST and only when declarations exist — see the note on
  // `toolDeclarationWrapper`. `tools` is the value substituted for `{{tools}}`, so a wrapper
  // declared here is what makes a dialect's nested array expressible at all.
  if (!wrapper || declarations.length === 0) return declarations;
  return [render(wrapper, { declarations })];
}

/** The `contentPartTemplates` keys that carry replayed tool traffic. Internal names — a dialect's
 *  own block type (`tool_use`) must NOT be used as a key here, or `renderContentParts` would render
 *  the already-rendered block a second time. */
export interface ToolPartTemplates {
  toolCall?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
}

/** Our internal content as an array of parts. Mirrors what `shapeMessageContent` does for a
 *  dialect content field, but on the neutral side: this runs *before* the rename. */
function asParts(content: unknown): unknown[] {
  if (Array.isArray(content)) return [...content];
  if (typeof content === "string" && content !== "") return [{ type: "text", text: content }];
  return [];
}

function callId(call: unknown): string | undefined {
  const id = blockField(call, "id");
  return typeof id === "string" && id ? id : undefined;
}

function callName(call: unknown): string {
  // Both stored shapes: the internal one (`name`) and OpenAI's nested one (`function.name`), the
  // same tolerance `lib/tools/render.ts` applies on the UI side.
  const name = blockField(call, "name") ?? blockField(call, "function.name");
  return typeof name === "string" ? name : "";
}

function callArguments(call: unknown): string {
  const args = blockField(call, "arguments") ?? blockField(call, "function.arguments");
  return typeof args === "string" ? args : args === undefined || args === null ? "" : stringify(args);
}

/** `JSON.parse` that cannot throw, for turning a call's argument text back into an object. */
function parseArguments(text: string): unknown {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v ?? {};
  } catch {
    // The model's problem, and the host will report it: a malformed argument string still has to
    // reach the dialect as *something*, because dropping the call would lose the turn entirely.
    return {};
  }
}

/**
 * Move replayed tool traffic out of the OpenAI fields and into the dialect's content parts.
 *
 * Runs **before** `normalizeDialectMessages`, and that order is load-bearing twice over:
 *
 *  - the tool result's `tool_call_id` is what names the call, and the role map deletes it for a
 *    dialect that has no `tool` role (Gemini maps `tool -> user`), so the pairing has to happen
 *    while the id is still there;
 *  - deleting `tool_calls` from the assistant turn is what stops the field being forwarded to a
 *    provider that does not read it. Gemini rejects unknown fields outright, so an assistant turn
 *    that kept `tool_calls` and gained `parts` would fail the whole request — a replay that
 *    "worked" for OpenAI would 400 for Gemini.
 *
 * One structural change beyond renaming: a run of consecutive `tool` messages collapses into a
 * single message holding one part per result. Both non-OpenAI dialects require it (Anthropic: all
 * `tool_result`s of a turn in the one user message that follows; Gemini: all `functionResponse`
 * parts in one user turn), and it is measured, not theoretical — see the note in the body.
 *
 * A dialect that declares neither template gets its messages back untouched.
 */
export function attachToolParts(
  messages: readonly unknown[],
  templates: ToolPartTemplates,
  render: (template: Record<string, unknown>, values: Record<string, unknown>) => unknown,
): unknown[] {
  if (!templates.toolCall && !templates.toolResult) return [...messages];

  // Which call each result answers. Gemini's `functionResponse` names the *tool*, and the internal
  // shape carries only `tool_call_id` — so the name is resolved by looking back at the assistant
  // turn that declared the call. This is the one step a manifest cannot express: it is a relation
  // between two messages, and a template language that could walk the conversation would be a
  // program, not a mapping.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const tcs = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const c of tcs) {
      const id = callId(c);
      if (id) nameById.set(id, callName(c));
    }
  }

  // Not `map`: a run of consecutive tool messages has to COLLAPSE into one message. OpenAI's
  // grammar carries each result as its own `role:"tool"` message, and a turn that made N calls
  // produces N of them back to back. Anthropic requires every `tool_result` of one assistant
  // turn to sit in the *single* user message that follows it — measured on agentrouter
  // (2026-10-01): a second user message whose `tool_use_id` names a call from two messages back
  // is rejected as `unexpected … found in tool_result blocks`. Gemini wants the same grouping,
  // one user turn with N `functionResponse` parts.
  const pass1: unknown[] = [];
  let merged: { role: string; content: unknown[] } | null = null;
  for (const m of messages) {
    if (m && typeof m === "object" && (m as Record<string, unknown>).role === "tool" && templates.toolResult) {
      const msg = m as Record<string, unknown>;
      const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
      const text = typeof msg.content === "string" ? msg.content : "";
      // A `tool_result` is only a legal block when the call it answers is declared in THIS request,
      // because the dialect validates that relation and rejects the whole turn when it fails —
      // `unexpected \`messages.N.content.0: tool_use_id\` found in \`tool_result\` blocks`. The block
      // used to be rendered regardless, so a result naming a call that is not here (including the
      // `""` a missing `tool_call_id` became) produced a 400 whose message names the block and whose
      // id list is *empty*, which is exactly the evidence that is missing when you need it.
      //
      // Left as an ordinary message instead, the role map turns it into a user turn and the output
      // still reaches the model. Dropping it would be the other 400: a declared call with no result.
      if (!id || !nameById.has(id)) {
        merged = null;
        pass1.push(m);
        continue;
      }
      const block = render(templates.toolResult, {
        id,
        name: nameById.get(id) ?? "",
        text,
        // Gemini's `functionResponse.response` must be a Struct. A bare string is rejected, so
        // the text is wrapped rather than passed through — `result` is our field name inside that
        // Struct, and nothing reads it back out, so it exists only to satisfy the shape.
        response: { result: text },
      });
      if (merged) {
        merged.content.push(block);
        continue;
      }
      // Replaced, not appended: the result *is* the message. Its text is carried inside the
      // rendered block (`content`), so keeping the original text part beside it would send the
      // same output to the model twice — and for a dialect whose parts have no place for a bare
      // text on a user role, once as something it cannot read.
      merged = { role: "tool", content: [block] };
      pass1.push(merged);
      continue;
    }
    merged = null;
    pass1.push(m);
  }

  return pass1.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as Record<string, unknown>;
    const tcs = msg.tool_calls;

    if (Array.isArray(tcs) && tcs.length > 0 && templates.toolCall) {
      const parts = asParts(msg.content);
      for (const c of tcs) {
        const name = callName(c);
        const argsText = callArguments(c);
        parts.push(
          render(templates.toolCall, {
            id: callId(c) ?? "",
            name,
            arguments: argsText,
            // Both spellings, because the dialects disagree on which they carry: OpenAI replays a
            // string, Gemini and Anthropic want the object. Offering one would force a dialect to
            // parse JSON inside a template it cannot execute.
            argumentsObject: parseArguments(argsText),
          }),
        );
      }
      // Typed explicitly: an object literal spread from an index-signature type infers as
      // `{content: unknown[]}`, and the `delete` below then has no such property to remove.
      const out: Record<string, unknown> = { ...msg, content: parts };
      delete out.tool_calls;
      return out;
    }

    return msg;
  });
}

/**
 * Gateway SSE parser (Phase 2 of gateway-flexibility plan).
 *
 * Parses raw upstream SSE into structured OpenAI-compatible chunks, reassembling
 * tool calls from delta fragments.
 *
 * ⚠️ NOT WIRED UP — no production code calls this. Read the rest before using it.
 *
 * The header used to claim "the gateway bridge feeds raw SSE lines into this parser".
 * It never did, and it cannot: adapters resolve the provider's SSE themselves and yield
 * decoded `delta` strings (`manifest-interpreter`: `yield delta`), and tool calls do not
 * travel in chunks at all — the interpreter reports them on `onToolCall` once the stream
 * ends. So the bridge receives text, not wire frames.
 *
 * That false premise shipped as a real bug: the bridge called
 * `JSON.parse(rawChunk)` on every chunk, which threw on every chunk, and the
 * `catch { continue }` around it silently dropped the entire answer — the gateway
 * returned empty completions. See DECISIONS.md (2026-09-18).
 *
 * Wire this up only if the bridge is changed to receive genuinely raw upstream SSE.
 * Until then it is dead code kept for the dialect work described below, and nothing
 * should be written against the assumption that chunks are JSON.
 *
 * Three parser variants correspond to the three upstream formats our adapters may return:
 * - parseOpenAIChatDelta — OpenAI Chat Completions stream
 * - parseClaudeDelta — Anthropic Messages stream
 * - parseResponsesDelta — OpenAI Responses stream
 *
 * Currently only OpenAI Chat Completions is wired through our adapters (the common case).
 * Claude/Responses parsers are provided for future native dialect adapters.
 */

// ── Types ───────────────────────────────────────────────────────────────────────────

/** One parsed chunk from the upstream SSE stream. */
export interface ParsedChunk {
  /** Text delta (may be empty string for tool-only chunks) */
  text?: string;
  /** Reasoning content delta (for thinking models) */
  reasoning?: string;
  /** Accumulated tool calls — complete when finishReason === 'tool_calls' */
  toolCalls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  /** Finish reason if this is the terminal chunk */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  /** Token usage if present on terminal chunk */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Whether this is the terminal chunk */
  done?: boolean;
}

/** Per-request accumulator state for reassembling multi-chunk tool calls. */
export interface AccumulatorState {
  messageId: string | null;
  model: string | null;
  textBuf: string;
  reasoningBuf: string;
  /** Keyed by numeric index — tool call fragments arrive per-index. */
  toolCalls: Map<number, {
    id?: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  finishReason: string | null;
  usage: unknown;
  /** Claude-specific: content blocks keyed by index. */
  contentBlocks: Map<number, {
    type: string;
    text?: string;
    thinking?: string;
    inputJson?: string;
    id?: string;
    name?: string;
  }>;
  /** Responses-specific: output items keyed by output_index. */
  outputItems: Map<number, unknown>;
  /** Buffer for accumulating JSON arguments across fragments. */
  funcArgsBuf: Record<string, string>;
}

/** Initialise fresh accumulator state for one request. */
export function initAccumulatorState(): AccumulatorState {
  return {
    messageId: null,
    model: null,
    textBuf: "",
    reasoningBuf: "",
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    contentBlocks: new Map(),
    outputItems: new Map(),
    funcArgsBuf: {},
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse a single SSE data line from an OpenAI Chat Completions stream.
 *
 * OpenAI stream shape (each `data:` line is a JSON object):
 *   { id, object, choices: [{ index, delta: { content?, tool_calls? }, finish_reason?, usage? }] }
 *
 * Tool calls arrive as delta.tool_calls[] — each entry carries an `index` to identify
 * which call it belongs to, plus fragments of id / name / arguments.
 */
export function parseOpenAIChatDelta(json: unknown, state: AccumulatorState): ParsedChunk | null {
  if (!isPlainObject(json)) return null;
  const o = json as Record<string, unknown>;

  // Capture top-level metadata on the first chunk.
  if (state.messageId === null && typeof o.id === "string") state.messageId = o.id;
  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown>;
  if (!isPlainObject(choice)) return null;

  const delta = choice.delta;
  if (isPlainObject(delta)) {
    // Text delta.
    const text = safeStr(delta.content);
    if (text) {
      state.textBuf += text;
    }

    // Reasoning delta (DeepSeek/Kimi/Qwen thinking models).
    const reasoning = safeStr((delta as Record<string, unknown>)["reasoning_content"]);
    if (reasoning) {
      state.reasoningBuf += reasoning;
    }

    // Tool call deltas — the core of the fix.
    const rawToolCalls = delta.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        if (!isPlainObject(tc)) continue;
        const idxRaw = tc.index;
        const idx = typeof idxRaw === "number" ? idxRaw : 0;
        const existing = state.toolCalls.get(idx) ?? {
          type: "function",
          function: { name: "", arguments: "" },
        };
        // Fill in id if absent on first fragment.
        if (typeof tc.id === "string" && tc.id) {
          existing.id = tc.id;
        }
        const fn = tc.function;
        if (isPlainObject(fn)) {
          if (typeof fn.name === "string" && fn.name) {
            existing.function.name = fn.name;
          }
          if (typeof fn.arguments === "string") {
            existing.function.arguments += fn.arguments;
          }
        }
        state.toolCalls.set(idx, existing);
      }
    }
  }

  // Finish reason signals terminal chunk.
  const finishReason = choice.finish_reason as string | undefined;
  if (finishReason) {
    state.finishReason = finishReason;
  }

  // Usage on the final chunk.
  if (o.usage && isPlainObject(o.usage)) {
    state.usage = o.usage;
  }

  // Build the parsed chunk.
  const chunk: ParsedChunk = { text: state.textBuf, reasoning: state.reasoningBuf };

  // If this is the terminal chunk and we have accumulated tool calls, emit them.
  if (finishReason) {
    chunk.done = true;
    if (finishReason === "tool_calls" || finishReason === "length") {
      const calls = Array.from(state.toolCalls.values());
      if (calls.length > 0) {
        chunk.toolCalls = calls.map((c) => ({
          id: c.id ?? "",
          type: c.type,
          function: c.function,
        }));
        chunk.finishReason = finishReason;
      }
    } else {
      chunk.finishReason = finishReason as ParsedChunk["finishReason"];
    }
    if (state.usage) {
      chunk.usage = state.usage as ParsedChunk["usage"];
    }
  }

  return chunk;
}

/**
 * Parse a single SSE data line from an Anthropic Messages stream.
 *
 * Anthropic stream events:
 *   event: message_start       -> { type: "message_start", message: { id, model, ... } }
 *   event: content_block_start -> { type: "content_block_start", index, content_block: { type, id, name } }
 *   event: content_block_delta -> { type: "content_block_delta", index, delta: { type: "text_delta", text } | { type: "input_json_delta", partial_json } }
 *   event: content_block_stop  -> { type: "content_block_stop", index }
 *   event: message_delta       -> { type: "message_delta", delta: { stop_reason }, usage }
 *   event: message_stop        -> { type: "message_stop" }
 *   event: error               -> { type: "error", error: { ... } }
 */
export function parseClaudeDelta(json: unknown, state: AccumulatorState): ParsedChunk | null {
  if (!isPlainObject(json)) return null;
  const o = json as Record<string, unknown>;
  const eventType = safeStr(o.type);

  if (eventType === "message_start") {
    const msg = o.message;
    if (isPlainObject(msg)) {
      state.messageId = safeStr(msg.id);
      state.model = safeStr(msg.model);
    }
    return null;
  }

  if (eventType === "content_block_start") {
    const idx = typeof o.index === "number" ? o.index : 0;
    const block = o.content_block;
    if (isPlainObject(block)) {
      state.contentBlocks.set(idx, {
        type: safeStr(block.type),
        id: safeStr(block.id),
        name: safeStr(block.name),
      });
    }
    return null;
  }

  if (eventType === "content_block_delta") {
    const idx = typeof o.index === "number" ? o.index : 0;
    const delta = o.delta;
    if (!isPlainObject(delta)) return null;
    const blockType = safeStr(delta.type);
    const block = state.contentBlocks.get(idx);
    if (!block) return null;

    if (blockType === "text_delta" && typeof delta.text === "string") {
      state.textBuf += delta.text;
      return { text: delta.text };
    }

    if (blockType === "input_json_delta" && typeof delta.partial_json === "string") {
      // Accumulate tool-call arguments.
      const argsKey = block.id ?? String(idx);
      state.funcArgsBuf[argsKey] = (state.funcArgsBuf[argsKey] ?? "") + delta.partial_json;
      return null;
    }

    return null;
  }

  if (eventType === "content_block_stop") {
    const idx = typeof o.index === "number" ? o.index : 0;
    const block = state.contentBlocks.get(idx);
    if (block && block.type === "tool_use" && block.id) {
      // Finalise one tool call.
      const args = state.funcArgsBuf[block.id] ?? "{}";
      state.toolCalls.set(idx, {
        id: block.id,
        type: "function",
        function: { name: block.name ?? "", arguments: args },
      });
    }
    return null;
  }

  if (eventType === "message_delta") {
    const delta = o.delta;
    if (isPlainObject(delta)) {
      const stopReason = safeStr(delta.stop_reason);
      if (stopReason) {
        state.finishReason = stopReason;
      }
      const usage = delta.usage;
      if (usage && isPlainObject(usage)) {
        state.usage = usage;
      }
    }
    // Terminal — build the final chunk with reassembled tool calls.
    const chunk: ParsedChunk = {};
    if (state.textBuf) chunk.text = state.textBuf;
    if (state.finishReason) {
      chunk.finishReason = state.finishReason === "tool_use" ? "tool_calls" : "stop";
      if (state.toolCalls.size > 0) {
        chunk.toolCalls = Array.from(state.toolCalls.values()).map((c) => ({
          id: c.id ?? "",
          type: c.type,
          function: c.function,
        }));
      }
    }
    chunk.done = true;
    return chunk;
  }

  if (eventType === "message_stop") {
    return { done: true };
  }

  if (eventType === "error") {
    return null; // Errors are handled elsewhere
  }

  return null;
}

/**
 * Parse a single SSE data line from an OpenAI Responses stream.
 *
 * Responses API events:
 *   response.created, response.completed, response.failed
 *   response.output_item.added, response.output_item.done
 *   response.content_part.added, response.content_part.done
 *   response.output_text.delta, response.output_text.done
 *   response.function_call_arguments.delta, response.function_call_arguments.done
 *
 * This parser accumulates text and tool calls, then emits a ParsedChunk that maps to
 * the OpenAI Chat Completions shape that the gateway client expects.
 */
export function parseResponsesDelta(json: unknown, state: AccumulatorState): ParsedChunk | null {
  if (!isPlainObject(json)) return null;
  const o = json as Record<string, unknown>;
  const eventType = safeStr(o.type);

  if (eventType === "response.created") {
    const resp = o.response;
    if (isPlainObject(resp)) {
      state.messageId = safeStr(resp.id);
      state.model = safeStr(resp.model as unknown);
    }
    return null;
  }

  if (eventType === "response.output_text.delta") {
    const delta = safeStr(o.delta);
    if (delta) {
      state.textBuf += delta;
      return { text: delta };
    }
    return null;
  }

  if (eventType === "response.output_text.done") {
    return { text: state.textBuf };
  }

  if (eventType === "response.function_call_arguments.delta") {
    const itemId = safeStr(o.item_id);
    const delta = safeStr(o.delta);
    if (itemId && delta) {
      state.funcArgsBuf[itemId] = (state.funcArgsBuf[itemId] ?? "") + delta;
    }
    return null;
  }

  if (eventType === "response.function_call_arguments.done") {
    const itemId = safeStr(o.item_id);
    if (itemId) {
      // Find the corresponding output item to get call_id and name.
      for (const [idx, item] of state.outputItems) {
        if (isPlainObject(item) && safeStr(item.id) === itemId && safeStr(item.type) === "function_call") {
          const callId = safeStr((item as Record<string, unknown>)["call_id"]);
          const name = safeStr((item as Record<string, unknown>)["name"]);
          state.toolCalls.set(idx, {
            id: callId,
            type: "function",
            function: { name, arguments: state.funcArgsBuf[itemId] ?? "{}" },
          });
        }
      }
    }
    return null;
  }

  if (eventType === "response.output_item.added") {
    const idx = typeof o.output_index === "number" ? o.output_index : 0;
    const item = o.item;
    if (isPlainObject(item)) {
      state.outputItems.set(idx, item);
    }
    return null;
  }

  if (eventType === "response.completed") {
    const resp = o.response;
    if (isPlainObject(resp)) {
      state.finishReason = "stop";
      const usage = resp.usage;
      if (usage && isPlainObject(usage)) {
        state.usage = usage;
      }
    }
    const chunk: ParsedChunk = {};
    if (state.textBuf) chunk.text = state.textBuf;
    chunk.done = true;
    if (state.toolCalls.size > 0) {
      chunk.toolCalls = Array.from(state.toolCalls.values()).map((c) => ({
        id: c.id ?? "",
        type: c.type,
        function: c.function,
      }));
      chunk.finishReason = "tool_calls";
    } else {
      chunk.finishReason = "stop";
    }
    if (state.usage) {
      chunk.usage = state.usage as ParsedChunk["usage"];
    }
    return chunk;
  }

  if (eventType === "response.failed") {
    return null;
  }

  return null;
}

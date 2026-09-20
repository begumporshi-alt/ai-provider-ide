/**
 * assistant-stream — keeps provider protocol syntax out of the chat transcript.
 *
 * Why this exists (2026-09-17, mercury-2.5 incident): the router forwards `tools` only when a
 * caller supplies them, and Assistant supplies none. A model that was trained on agentic
 * transcripts but is handed a toolless request will often *role-play* a tool call instead —
 * emitting a pseudo-token dialect inline:
 *
 *   <|tool_call_start|> <function=Bash> <parameter=command> mkdir -p … </parameter> <|tool_call_end|>
 *
 * That is model text, not a real OpenAI `tool_calls` object, so nothing upstream intercepts it
 * and it used to land verbatim in the transcript.
 *
 * Design constraints:
 *  - Streaming: the end marker arrives seconds after the start marker, so a half-emitted block
 *    must render as "nothing yet", never as half a token.
 *  - Partial markers: a tail like `<|tool_call_st` must be held back, not painted.
 *  - Lossless: the raw segment is kept so a future tool-execution layer can act on it.
 *  - Narrow: only markers are recognised. Ordinary prose (including `<` in `a < b`) is untouched.
 */

/** Marker families seen across models that imitate tool calls in-band. */
const MARKERS: ReadonlyArray<{ start: string; end: string }> = [
  { start: "<|tool_call_start|>", end: "<|tool_call_end|>" },
  { start: "<|tool_calls_section_start|>", end: "<|tool_calls_section_end|>" },
  { start: "<|tool_call|>", end: "</|tool_call|>" },
  { start: "<tool_call>", end: "</tool_call>" },
  { start: "<|function_call|>", end: "</|function_call|>" },
  { start: "<function_call>", end: "</function_call>" },
  { start: "<|tool_call_begin|>", end: "<|tool_call_end|>" },
];

const START_TOKENS = MARKERS.map((m) => m.start);

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface ToolSegment {
  kind: "tool";
  /** Function name if it could be recovered from the block, else undefined. */
  name?: string;
  /** Recovered parameters, keyed by name. Values are raw strings. */
  params: Record<string, string>;
  /** False while the closing marker has not arrived yet. */
  complete: boolean;
  /** The verbatim block body, kept for a future execution layer. */
  raw: string;
}

export type Segment = TextSegment | ToolSegment;

/** Longest marker prefix the string ends with, if any (length >= 2 so `a < b` survives). */
function partialMarkerTailLength(s: string): number {
  let best = 0;
  for (const token of START_TOKENS) {
    for (let n = Math.min(token.length - 1, s.length); n >= 2; n--) {
      if (s.endsWith(token.slice(0, n))) {
        best = Math.max(best, n);
        break;
      }
    }
  }
  return best;
}

const FUNCTION_RE = /<\|?\s*function\s*=\s*([^\s>|]+)\s*\|?>/i;
const PARAM_OPEN_RE = /<\|?\s*parameter\s*=\s*([^\s>|]+)\s*\|?>/gi;
const PARAM_CLOSE_RE = /<\/\s*parameter\s*>\s*$/i;

/**
 * Best-effort recovery of the function name and parameters from an in-band block.
 *
 * Two dialects occur in the wild. Well-formed blocks close each parameter:
 *   <parameter=command>ls</parameter>
 * The mercury-2.5 output did not — a parameter simply runs until the next `<parameter=`
 * (or the end of the block), so a closing tag must not be required:
 *   <parameter=command> mkdir -p /x <parameter=description> Create skill directory
 */
function parseBlock(body: string): { name?: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const opens = [...body.matchAll(PARAM_OPEN_RE)];
  opens.forEach((m, idx) => {
    const valueStart = (m.index ?? 0) + m[0].length;
    const valueEnd = opens[idx + 1]?.index ?? body.length;
    params[m[1]] = body.slice(valueStart, valueEnd).replace(PARAM_CLOSE_RE, "").trim();
  });
  const fn = FUNCTION_RE.exec(body);
  return { name: fn?.[1], params };
}

/**
 * Split raw assistant output into prose and tool-call segments.
 *
 * Streaming-safe: an unterminated block yields `complete: false` and is the last segment, so
 * callers can hide it until the closing marker arrives.
 */
export function parseAssistantStream(src: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let text = "";

  const flushText = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };

  while (i < src.length) {
    // Earliest start marker at or after the cursor.
    let startIdx = -1;
    let startLen = 0;
    let endToken = "";
    for (const m of MARKERS) {
      const at = src.indexOf(m.start, i);
      if (at !== -1 && (startIdx === -1 || at < startIdx)) {
        startIdx = at;
        startLen = m.start.length;
        endToken = m.end;
      }
    }

    if (startIdx === -1) {
      text += src.slice(i);
      break;
    }

    text += src.slice(i, startIdx);
    flushText();

    const bodyStart = startIdx + startLen;
    const endIdx = src.indexOf(endToken, bodyStart);
    if (endIdx === -1) {
      const raw = src.slice(bodyStart);
      out.push({ kind: "tool", ...parseBlock(raw), complete: false, raw });
      i = src.length;
    } else {
      const raw = src.slice(bodyStart, endIdx);
      out.push({ kind: "tool", ...parseBlock(raw), complete: true, raw });
      i = endIdx + endToken.length;
    }
  }

  flushText();

  // Hold back a half-typed marker at the very end of the stream.
  const last = out[out.length - 1];
  if (last?.kind === "text") {
    const n = partialMarkerTailLength(last.text);
    if (n > 0) {
      last.text = last.text.slice(0, last.text.length - n);
      if (!last.text) out.pop();
    }
  }

  return out;
}

/** Prose only: what belongs in the transcript. */
export function visibleText(src: string): string {
  return parseAssistantStream(src)
    .filter((s): s is TextSegment => s.kind === "text")
    .map((s) => s.text)
    .join("")
    .trim();
}

/** Every recognised tool call, complete or not. */
export function toolSegments(src: string): ToolSegment[] {
  return parseAssistantStream(src).filter((s): s is ToolSegment => s.kind === "tool");
}

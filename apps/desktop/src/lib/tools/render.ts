/**
 * How a tool call and its result should be presented (Phase 2).
 *
 * The transcript's `tool` turns carry only the result text — the arguments live on the assistant
 * turn that declared the call, and the two are joined by `tool_call_id`. These helpers do the
 * joining and decide what kind of view a call deserves, kept pure so they are unit-testable and so
 * `Assistant` and `History` cannot disagree about what an `edit_file` is.
 */
import type { ChatMessage } from "@aiprovider/router-core";
import { toolCallName } from "./wire";

export interface ToolCallRef {
  name: string;
  args: Record<string, unknown>;
}

/** A call's arguments, read tolerantly from either the flat internal shape or OpenAI's nested one. */
export function toolCallArgs(call: unknown): Record<string, unknown> {
  const o = call as { arguments?: unknown; function?: { arguments?: unknown } } | null | undefined;
  const raw =
    typeof o?.arguments === "string"
      ? o.arguments
      : typeof o?.function?.arguments === "string"
        ? o.function.arguments
        : undefined;
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // Malformed arguments are the model's problem, not a reason to blank the transcript — the
    // host already returned a clear error as the tool result.
    return {};
  }
}

export function toolCallId(call: unknown): string | undefined {
  const o = call as { id?: unknown } | null | undefined;
  return typeof o?.id === "string" && o.id ? o.id : undefined;
}

/**
 * Join every assistant turn's `tool_calls` into a `tool_call_id → call` map, so a tool result can
 * be rendered with the arguments that produced it. Both stored shapes are accepted (a transcript
 * written before the wire normalisation is flat), matching `toolCallName`'s tolerance.
 */
export function indexToolCalls(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "tool_calls">>,
): Map<string, ToolCallRef> {
  const out = new Map<string, ToolCallRef>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const id = toolCallId(c);
      if (id) out.set(id, { name: toolCallName(c), args: toolCallArgs(c) });
    }
  }
  return out;
}

export interface FileChange {
  path: string;
  oldText: string;
  newText: string;
  kind: "edit" | "write";
  /** A caveat worth showing the user, e.g. that a `write_file` overwrote unknown contents. */
  note?: string;
}

/** One step of a turn: a call, plus the result that answered it when one did. */
export interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  call: ToolCallRef;
  result?: string;
}

/** A transcript turn, as much of it as grouping needs. Content is read tolerantly: the Assistant
 *  transcript stores text, and anything else (a parts array) is not a tool output we can show. */
interface TurnLike {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : "";
}

/**
 * Group a transcript's tool traffic by the turn that requested it.
 *
 * The transcript is a flat message list — an assistant turn declaring `tool_calls`, then one
 * `role:"tool"` turn per call — and rendering it message by message produced the flat run of
 * anonymous "tool result" bubbles this replaces: the call's *name* was never shown on a result, and
 * a turn that made three calls read as three separate blocks. Grouping restores the turn's shape.
 *
 * Returns the steps per assistant-message index, and the indices of the tool turns **consumed** into
 * a group, so a renderer can draw one card per turn and skip the turns it has already drawn.
 *
 * A tool turn whose call is not found on the immediately preceding assistant turn (a truncated,
 * edited or replayed transcript) still yields a step, under the name `tool`: dropping it would lose
 * a tool's output, which is worse than an unlabelled row.
 */
export function groupToolRuns(messages: readonly TurnLike[]): { byAssistant: Map<number, ToolStep[]>; consumed: Set<number> } {
  const byAssistant = new Map<number, ToolStep[]>();
  const consumed = new Set<number>();
  messages.forEach((m, i) => {
    const tcs = m.tool_calls;
    if (m.role !== "assistant" || !Array.isArray(tcs) || tcs.length === 0) return;
    const steps: ToolStep[] = tcs.map((c) => {
      const name = toolCallName(c);
      const args = toolCallArgs(c);
      return { name, args, call: { name, args } };
    });
    const byId = new Map<string, ToolStep>();
    tcs.forEach((c, k) => {
      const id = toolCallId(c);
      if (id) byId.set(id, steps[k]!);
    });
    // Runs to a fixed point on the first non-tool turn: consecutive results are one turn's answers,
    // and a later turn's results belong to the assistant turn that precedes them.
    for (let j = i + 1; j < messages.length && messages[j]!.role === "tool"; j++) {
      consumed.add(j);
      const id = messages[j]!.tool_call_id;
      const step = id ? byId.get(id) : undefined;
      const text = textOf(messages[j]!.content);
      if (step) step.result = text;
      else steps.push({ name: "tool", args: {}, call: { name: "tool", args: {} }, result: text });
    }
    byAssistant.set(i, steps);
  });
  return { byAssistant, consumed };
}

/**
 * The file change a call represents, or null when it is not a file mutation.
 *
 * Only `edit_file` and `write_file` qualify. `write_file` has no "before" — the previous contents
 * were never read — so it is presented as an all-additions diff with a note, rather than claiming a
 * diff against content nobody saw.
 */
export function fileChangeFor(name: string, args: Record<string, unknown>): FileChange | null {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return null;
  if (name === "edit_file") {
    return {
      path,
      kind: "edit",
      oldText: typeof args.old === "string" ? args.old : "",
      newText: typeof args.new === "string" ? args.new : "",
      ...(args.replace_all === true ? { note: "replace_all — every occurrence was replaced" } : {}),
    };
  }
  if (name === "write_file") {
    return {
      path,
      kind: "write",
      oldText: "",
      newText: typeof args.content === "string" ? args.content : "",
      note: "whole-file write — any previous contents are not shown",
    };
  }
  return null;
}

/** Tools whose result is a list of `path:line: text` matches, rendered grouped by file. */
export function isSearchResult(name: string): boolean {
  return name === "search_files";
}

/**
 * Parse a `tool_calls` JSON array as persisted on a transcript node (the History timeline stores it
 * as a string on the assistant entry). Returns id→ref pairs, so a `tool` entry can be joined to the
 * call that produced it — the same join `indexToolCalls` does for live messages.
 */
export function parseStoredToolCalls(json: string | null | undefined): { id: string; ref: ToolCallRef }[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: { id: string; ref: ToolCallRef }[] = [];
  for (const c of arr) {
    const id = toolCallId(c);
    if (id) out.push({ id, ref: { name: toolCallName(c), args: toolCallArgs(c) } });
  }
  return out;
}

/** Group `search_files` output (`path:line: text`) by file, preserving first-seen order. */
export function groupSearchMatches(result: string): { file: string; hits: string[] }[] {
  const groups: { file: string; hits: string[] }[] = [];
  const byFile = new Map<string, string[]>();
  for (const line of result.split("\n")) {
    const m = /^(.+?):\d+:/.exec(line);
    if (!m) continue;
    const file = m[1]!;
    let hits = byFile.get(file);
    if (!hits) {
      hits = [];
      byFile.set(file, hits);
      groups.push({ file, hits });
    }
    hits.push(line);
  }
  return groups;
}

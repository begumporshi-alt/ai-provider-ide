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

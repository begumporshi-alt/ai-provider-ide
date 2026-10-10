/**
 * Transcript message shape and the history replay both turn paths share.
 *
 * Extracted from the Assistant screen (turn-engine phase 1) so the engine modules and the screen
 * read one definition — the screen keeps transcript ownership between turns; this module owns the
 * shape and the replay rules.
 */
import { userContent, type ChatMessage, type ContentPart } from "@aiprovider/router-core";
import { imageContextBlock } from "../vision";
import type { Attachment, InlinedText } from "../../../components/Composer";

export interface Msg {
  /** Stable identity. The transcript is truncated, re-run and forked by position, so rendering
   *  must key on something that survives an edit — an array index does not. */
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * The model's own reasoning for this turn, when it produced any. Kept beside `content` rather
   * than spliced into it: reasoning is the model's notes, not its answer, and a transcript that
   * merged the two would quote the notes as the reply.
   *
   * It is kept even when the turn produced **no answer at all**, which is the case it exists for.
   * Measured 2026-10-02 on `agentrouter.org` (`deepseek-v4-flash`): extended thinking is on by
   * default, `max_tokens` covers reasoning *and* answer, and a turn whose reasoning outran the
   * 8192-token budget streamed 25 000 characters of thinking, no text, and left the user staring
   * at an empty bubble for 46 seconds. The reasoning was there the whole time; nothing was
   * listening for it.
   */
  reasoning?: string;
  /** Set on an assistant turn that requested tool calls, so the next turn can replay them. */
  tool_calls?: unknown;
  /** Set on a tool result turn, linking it to its originating call. */
  tool_call_id?: string;
  /**
   * Images this user turn was sent with (P3). Kept on the transcript, not only on the request,
   * because a follow-up turn has to replay them: "what about the second one?" is unanswerable if the
   * picture vanished from history the moment it was sent. The bytes are already in memory (they came
   * from the composer), so this costs no extra read.
   */
  attachments?: Attachment[];
  /**
   * What a vision model saw in this turn's images, when the model that ANSWERED cannot see them.
   *
   * Stored on the message, not passed alongside it, because history replay is where it matters: an
   * image stays on its turn, so every later turn re-sends it. A model that cannot see must receive
   * the reading on every one of those turns — and only the message itself survives to the second
   * turn. `attachments` still carries the thumbnails, which is what the transcript shows.
   */
  imageReadings?: { name: string; description: string }[];
  /** The model that produced `imageReadings`, named for the model that reads them. */
  imagesReadBy?: string;
  /** Names of workspace files inlined into this turn, for the transcript's own labelling. */
  inlined?: InlinedText[];
}

/** Monotonic within a session; combined with a timestamp so a resumed transcript cannot collide
 *  with ids minted in this run. */
let msgSeq = 0;
export function newMsgId(): string {
  msgSeq += 1;
  return `m-${Date.now().toString(36)}-${msgSeq}`;
}

/** Assign ids to messages that arrived without them (a resumed transcript from History). */
export function withIds(msgs: ReadonlyArray<Omit<Msg, "id">>): Msg[] {
  return msgs.map((m) => ({ ...m, id: newMsgId() }));
}

/**
 * Replay prior turns for a follow-up request — the one place both the agent and the plain-chat
 * paths build history from.
 *
 * `tool_calls` and `tool_call_id` have to survive the replay, not just `role` and `content`. A
 * tool-result message without its `tool_call_id` is rejected by every OpenAI-compatible provider
 * with HTTP 400, and the assistant turn that asked for it is meaningless without `tool_calls`.
 *
 * These were two separate mappings and only the agent's kept the tool fields, so any session that
 * had used agent mode failed on the *next plain message* with `BAD_REQUEST_SCHEMA` — the request
 * was refused for replaying a tool result the provider could not match to a call. Keeping one
 * mapping is the point: the bug was the divergence, not either version of the filter.
 *
 * The filter also drops the empty assistant bubble a stopped or failed turn leaves behind —
 * `{ role: "assistant", content: "" }` is rejected with 400 by most providers too.
 */
/**
 * A user turn's content on the wire: image parts, or the reading of them.
 *
 * One function for every place a stored message becomes a request message (the replay here, the
 * plain path's current turn, the agent path's), because the alternative is three copies of a rule
 * that decides whether image bytes go out — and a copy that missed the reading would hand a blind
 * model an image part it cannot use.
 *
 * The reading wins when present and the bytes are then omitted entirely: sending both would be
 * wasteful, and sending the image to a model that cannot see it is the failure this exists to stop.
 */
export function userWireContent(m: Pick<Msg, "content" | "attachments" | "imageReadings" | "imagesReadBy">): string | ContentPart[] {
  if (m.imageReadings?.length && m.imagesReadBy) {
    const block = imageContextBlock(m.imageReadings, m.imagesReadBy);
    return m.content.trim() ? `${m.content}\n\n${block}` : block;
  }
  // `userContent` returns a plain string when there are no attachments, which is what keeps an
  // ordinary turn a string.
  return userContent(m.content, (m.attachments ?? []).map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 })));
}

export function replayHistory(msgs: Msg[]): ChatMessage[] {
  return msgs
    // A turn carrying an image has text too (the question), so the filter's usual test still holds;
    // an image-only turn is kept by the second clause rather than dropped as "empty".
    .filter((m) => m.content.trim().length > 0 || (m.role === "assistant" && m.tool_calls) || (m.attachments?.length ?? 0) > 0)
    .map((m) => ({
      role: m.role,
      content: userWireContent(m),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })) as ChatMessage[];
}

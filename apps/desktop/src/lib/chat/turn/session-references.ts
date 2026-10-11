/**
 * Session references — the source links a conversation has gathered, kept where every reply can
 * see them.
 *
 * A link's relevance does not end with the turn that introduced it: a URL the user pasted in
 * turn one is still the spec in turn ten, and a model that no longer sees it answers from
 * impression instead of source. So the session keeps one reference list, derived from the
 * transcript itself — URLs in the user's messages are the user's sources, URLs the agent fetched
 * or named (web_fetch/web_ask/web_search results included) are the agent's — plus the ones the
 * user pinned by hand through the drawer.
 *
 * Two consumers share this module, exactly as `session-skills` does for skills: the drawer that
 * shows and curates the list, and the system-turn builder (`buildAgentSystem` / the plain path)
 * that appends the block every reply reads.
 */
import type { Msg } from "./messages";

/** Where a reference came from — the drawer badges it, and the block explains it. */
export type ReferenceOrigin = "user" | "agent" | "manual";

export interface SessionReference {
  url: string;
  origin: ReferenceOrigin;
}

/**
 * Clean up a URL harvested from prose: trim whitespace and the punctuation a sentence hangs on
 * it (`.`, `,`, `)`, `>`, closing quotes). Only http(s) counts — a bare domain is a mention, not
 * a reference, and `javascript:` or `data:` have no business in a source list.
 */
export function normalizeUrl(raw: string): string | null {
  let u = raw.trim().replace(/[.,;:!?)\]}>”’"']+$/, "");
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Every http(s) URL in a text, normalized and in first-seen order, duplicates dropped. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  for (const raw of text.match(re) ?? []) {
    const u = normalizeUrl(raw);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * The tool calls whose `url` argument is itself a reference: the agent fetched the page, so the
 * session has read it whether or not its text mentions the address. `tool_calls` is typed
 * `unknown` on a stored message, so the parse is defensive — a shape from another provider or a
 * truncated record yields nothing rather than a throw.
 */
export function toolCallUrl(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const call of toolCalls) {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (typeof fn?.name !== "string" || typeof fn.arguments !== "string") continue;
    if (fn.name !== "web_fetch" && fn.name !== "web_ask") continue;
    try {
      const args = JSON.parse(fn.arguments) as { url?: unknown };
      if (typeof args.url === "string") {
        const u = normalizeUrl(args.url);
        if (u) return u;
      }
    } catch {
      // an unparseable argument blob is not a reference
    }
  }
  return null;
}

/**
 * Scan the transcript. The user's own turns are the user's sources; anything the assistant or a
 * tool turn carries (a fetched page, a search result, a link the model named) is the agent's.
 * Order follows the transcript, so the block reads in the order the session met them.
 */
export function refsFromMessages(msgs: ReadonlyArray<Msg>): SessionReference[] {
  const out: SessionReference[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const origin: ReferenceOrigin = m.role === "user" ? "user" : "agent";
    const urls = [...extractUrls(m.content), ...(m.tool_calls ? [toolCallUrl(m.tool_calls)].filter((u): u is string => u !== null) : [])];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, origin });
    }
  }
  return out;
}

/** Merge more references in, first origin wins — a URL the user pasted stays theirs even after
 *  the agent also fetches it. Dedupe is by normalized URL. */
export function addReferences(
  existing: ReadonlyArray<SessionReference>,
  incoming: ReadonlyArray<SessionReference>,
): SessionReference[] {
  const seen = new Set(existing.map((r) => r.url));
  const out = [...existing];
  for (const r of incoming) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/** The block never grows without bound: 40 links is already more context than most turns need. */
export const MAX_REFERENCES = 40;

/**
 * The system-turn block listing this session's sources. Newline-prefixed like `skillsBlock`;
 * empty in, empty out — a session with no references must add nothing to the prompt.
 */
export function referencesBlock(refs: ReadonlyArray<SessionReference>): string {
  if (refs.length === 0) return "";
  const shown = refs.slice(0, MAX_REFERENCES);
  const lines = shown.map((r) => {
    const how = r.origin === "user" ? "shared by the user" : r.origin === "manual" ? "added by the user" : "read during the session";
    return `- ${r.url} (${how})`;
  });
  const overflow = refs.length - shown.length;
  if (overflow > 0) lines.push(`- …and ${overflow} more from earlier in the session`);
  return (
    "\n\nReferences gathered in this session — the conversation's sources. Prefer them and cite " +
    "them when they are relevant; do not substitute links you were not given:\n" +
    lines.join("\n")
  );
}

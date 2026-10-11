/**
 * session-references.test.ts — the session's source list, derived from the transcript.
 *
 * The rules pinned here are the ones the drawer and the system block both depend on: origin
 * attribution (the user's pastes are theirs, the agent's fetches are its), normalization that
 * survives prose punctuation, dedupe by URL with first origin winning, and a block that adds
 * nothing when the session has no references.
 */
import { describe, expect, it } from "vitest";
import type { Msg } from "./messages";
import {
  addReferences,
  extractUrls,
  normalizeUrl,
  referencesBlock,
  refsFromMessages,
  toolCallUrl,
} from "./session-references";

function userMsg(content: string): Msg {
  return { id: "u", role: "user", content };
}
function assistantMsg(content: string, toolCalls?: unknown): Msg {
  return { id: "a", role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}
function toolMsg(content: string): Msg {
  return { id: "t", role: "tool", content };
}

describe("normalizeUrl", () => {
  it("accepts http(s) and keeps the address intact", () => {
    expect(normalizeUrl("https://example.com/docs?v=2")).toBe("https://example.com/docs?v=2");
    expect(normalizeUrl("http://localhost:1420/web-test/")).toBe("http://localhost:1420/web-test/");
  });

  it("strips the punctuation a sentence hangs on it", () => {
    expect(normalizeUrl("https://example.com/spec.")).toBe("https://example.com/spec");
    // Through the extractor, the way the transcript reaches it: the comma after the link is
    // prose, not path. Punctuation *inside* a URL is kept — parentheses are legal in real URLs.
    expect(extractUrls("see https://example.com/a, and also")).toEqual(["https://example.com/a"]);
  });

  it("refuses anything that is not an http(s) URL", () => {
    expect(normalizeUrl("example.com/page")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("finds URLs in prose, deduped, first-seen order", () => {
    const text = "see https://a.dev/x and https://b.dev/y. Again https://a.dev/x — done.";
    expect(extractUrls(text)).toEqual(["https://a.dev/x", "https://b.dev/y"]);
  });

  it("returns nothing for text without links", () => {
    expect(extractUrls("no links here, just words")).toEqual([]);
  });
});

describe("toolCallUrl", () => {
  const fetchCall = [
    { id: "c1", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://a.dev/page" }) } },
  ];

  it("reads the url argument of a web_fetch call", () => {
    expect(toolCallUrl(fetchCall)).toBe("https://a.dev/page");
  });

  it("reads web_ask too, and skips other tools", () => {
    const ask = [{ function: { name: "web_ask", arguments: JSON.stringify({ url: "https://b.dev/", question: "q" }) } }];
    const read = [{ function: { name: "read_file", arguments: JSON.stringify({ path: "https://c.dev/" }) } }];
    expect(toolCallUrl(ask)).toBe("https://b.dev/");
    expect(toolCallUrl(read)).toBeNull();
  });

  it("answers null for shapes it cannot parse, never throws", () => {
    expect(toolCallUrl(undefined)).toBeNull();
    expect(toolCallUrl("nope")).toBeNull();
    expect(toolCallUrl([{ function: { name: "web_fetch", arguments: "{broken" } }])).toBeNull();
  });
});

describe("refsFromMessages", () => {
  it("attributes the user's pastes to the user and everything else to the agent", () => {
    const msgs = [
      userMsg("start from https://spec.dev/x please"),
      assistantMsg("Reading it now.", fetchCallsFor("https://spec.dev/x")),
      toolMsg('{"content": "also relevant: https://related.dev/notes"}'),
    ];
    expect(refsFromMessages(msgs)).toEqual([
      { url: "https://spec.dev/x", origin: "user" },
      { url: "https://related.dev/notes", origin: "agent" },
    ]);
  });

  it("a URL the user pasted first stays theirs even after the agent fetches it", () => {
    const msgs = [
      userMsg("https://spec.dev/x — what does this say?"),
      assistantMsg("", fetchCallsFor("https://spec.dev/x")),
    ];
    expect(refsFromMessages(msgs)).toEqual([{ url: "https://spec.dev/x", origin: "user" }]);
  });
});

function fetchCallsFor(url: string): unknown {
  return [{ id: "c", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }];
}

describe("addReferences", () => {
  it("appends only the URLs not already present", () => {
    const existing = [{ url: "https://a.dev/", origin: "user" as const }];
    const merged = addReferences(existing, [
      { url: "https://a.dev/", origin: "agent" },
      { url: "https://b.dev/", origin: "manual" },
    ]);
    expect(merged).toEqual([
      { url: "https://a.dev/", origin: "user" },
      { url: "https://b.dev/", origin: "manual" },
    ]);
  });
});

describe("referencesBlock", () => {
  it("is empty when the session has no references", () => {
    expect(referencesBlock([])).toBe("");
  });

  it("lists each reference with how it arrived", () => {
    const block = referencesBlock([
      { url: "https://a.dev/", origin: "user" },
      { url: "https://b.dev/", origin: "agent" },
      { url: "https://c.dev/", origin: "manual" },
    ]);
    expect(block).toContain("References gathered in this session");
    expect(block).toContain("- https://a.dev/ (shared by the user)");
    expect(block).toContain("- https://b.dev/ (read during the session)");
    expect(block).toContain("- https://c.dev/ (added by the user)");
  });

  it("caps the list and says how many it left out", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ url: `https://h${i}.dev/`, origin: "user" as const }));
    const block = referencesBlock(many);
    expect(block).toContain("https://h39.dev/");
    expect(block).not.toContain("https://h40.dev/");
    expect(block).toContain("…and 5 more");
  });
});

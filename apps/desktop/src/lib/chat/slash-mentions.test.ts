/**
 * Slash commands and @-mentions: the parsing rules, which are where both features actually live.
 *
 * Both are "the draft means something other than a message", so the interesting failures are about
 * *when* they are active, not about what they do once active: a command recognised inside a real
 * prompt, a mention inserted into an email address, a mention expanded to nothing while the model is
 * told it has context. Every case below is one of those.
 */
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, matchSlashCommands, parseSlash } from "./slash";
import {
  INLINE_LIMIT_BYTES,
  activeMention,
  applyMention,
  expandMentions,
  matchMentions,
  mentionedPaths,
  parseListing,
} from "./mentions";

describe("parseSlash decides whether a draft is a command at all", () => {
  it("parses a bare command and one with arguments", () => {
    expect(parseSlash("/clear")?.command.id).toBe("clear");
    expect(parseSlash("  /model")?.command.id).toBe("model");
    expect(parseSlash("/compact now please")?.args).toBe("now please");
  });

  it("refuses a name that only starts like a command", () => {
    // The failure this prevents: `/clearer is a word` silently clearing the transcript.
    expect(parseSlash("/clearer")).toBeNull();
    expect(parseSlash("/clearing the cache")).toBeNull();
  });

  it("refuses an unknown name, so the draft stays a message", () => {
    expect(parseSlash("/nope")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });

  it("refuses anything on a second line", () => {
    // A user who wrote two lines is writing a prompt. Swallowing it because the first line looked
    // like a command is the worst version of this feature.
    expect(parseSlash("/clear\nand also explain this code")).toBeNull();
    expect(parseSlash("/compact\n\nmore text")).toBeNull();
  });

  it("is not confused by a slash that is not at the start", () => {
    expect(parseSlash("explain src/main.rs /clear")).toBeNull();
    expect(parseSlash("a/b")).toBeNull();
  });

  it("lower-cases the name but keeps the arguments as typed", () => {
    expect(parseSlash("/CLEAR")?.command.id).toBe("clear");
    expect(parseSlash("/model Gpt-4o")?.args).toBe("Gpt-4o");
  });
});

describe("matchSlashCommands is a prefix prediction of what Enter will do", () => {
  it("offers everything on a bare slash", () => {
    expect(matchSlashCommands("/").length).toBe(SLASH_COMMANDS.length);
  });

  it("narrows by prefix", () => {
    expect(matchSlashCommands("/c").map((c) => c.name)).toEqual(["clear", "compact"]);
    expect(matchSlashCommands("/cl").map((c) => c.name)).toEqual(["clear"]);
    expect(matchSlashCommands("/z")).toEqual([]);
  });

  it("closes once the user has moved on to arguments", () => {
    // A menu floating over a command that is already complete would cover the transcript for a
    // decision the user has already made.
    expect(matchSlashCommands("/clear ")).toEqual([]);
    expect(matchSlashCommands("/compact the history")).toEqual([]);
  });

  it("stays closed for ordinary text", () => {
    expect(matchSlashCommands("hello")).toEqual([]);
    expect(matchSlashCommands("/clear\nmore")).toEqual([]);
  });
});

describe("activeMention finds the reference under the caret", () => {
  it("finds a mention at the end and in the middle", () => {
    expect(activeMention("look at @read", 13)).toEqual({ start: 8, fragment: "read" });
    // Caret 15 is just past the "e" of "readme", so the whole token is the fragment; caret 14 stops
    // one short of it and the word is "readm". The caret is what decides, not the token.
    expect(activeMention("look at @readme now", 15)).toEqual({ start: 8, fragment: "readme" });
    expect(activeMention("look at @readme now", 14)).toEqual({ start: 8, fragment: "readm" });
  });

  it("requires the @ to start the word", () => {
    // `user@example.com` typed into a prompt must not become a file picker.
    expect(activeMention("mail me at user@exa", 18)).toBeNull();
    expect(activeMention("no mention here", 6)).toBeNull();
  });

  it("closes once the caret leaves the token", () => {
    expect(activeMention("look at @readme now", 10)).toEqual({ start: 8, fragment: "r" });
    // Caret after a space: the token is done, so the menu stays shut.
    expect(activeMention("@readme and then", 16)).toBeNull();
  });

  it("handles an empty fragment and a caret past the end", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, fragment: "" });
    expect(activeMention("@readme", 99)).toEqual({ start: 0, fragment: "readme" });
    expect(activeMention("@readme", -5)).toBeNull();
  });
});

describe("matchMentions ranks the file the user meant first", () => {
  const files = [
    { path: "README.md" },
    { path: "src/readme-helper.ts" },
    { path: "docs/guide.md" },
    { path: "src/deep/nested/READ.md" },
  ];

  it("prefers a basename prefix over a deeper substring", () => {
    expect(matchMentions(files, "read")[0]!.path).toBe("README.md");
    expect(matchMentions(files, "read").map((f) => f.path)).toContain("src/readme-helper.ts");
  });

  it("prefers a shorter path inside the same band", () => {
    const band = matchMentions([{ path: "a/b/read.md" }, { path: "read.md" }], "read");
    expect(band[0]!.path).toBe("read.md");
  });

  it("returns the first N when nothing is typed, and nothing when nothing matches", () => {
    expect(matchMentions(files, "").length).toBe(4);
    expect(matchMentions(files, "zzz")).toEqual([]);
    expect(matchMentions(files, "read", 1)).toHaveLength(1);
  });
});

describe("applyMention rewrites only the active token", () => {
  it("inserts the path and leaves the caret after it", () => {
    const { text, caret } = applyMention("look at @read now", 8, 13, "README.md");
    expect(text).toBe("look at @README.md  now");
    expect(text.slice(0, caret)).toBe("look at @README.md ");
  });

  it("keeps the text after the caret", () => {
    const { text } = applyMention("see @src", 4, 8, "src/main.rs");
    expect(text).toBe("see @src/main.rs ");
  });
});

describe("expandMentions turns references into context, and admits what it could not read", () => {
  it("finds every referenced path once", () => {
    expect(mentionedPaths("@a.txt and @b/c.rs and @a.txt")).toEqual(["a.txt", "b/c.rs"]);
    expect(mentionedPaths("no mentions")).toEqual([]);
  });

  it("appends a fenced block per file and keeps the prose", () => {
    const files = new Map([["readme.md", { content: "# Hi" }]]);
    const r = expandMentions("summarise @readme.md", files);
    expect(r.text).toContain("summarise @readme.md");
    expect(r.text).toContain("--- readme.md ---");
    expect(r.text).toContain("# Hi");
    expect(r.inlined.map((f) => f.path)).toEqual(["readme.md"]);
    expect(r.skipped).toEqual([]);
  });

  it("reports a reference it could not resolve instead of silently sending nothing", () => {
    // The load-bearing case: a user who typed `@config.json` and got an answer about nothing would
    // conclude the model ignored them, when in fact the file never made it into the request.
    const r = expandMentions("read @config.json", new Map());
    expect(r.inlined).toEqual([]);
    expect(r.skipped).toEqual(["config.json"]);
    expect(r.text).toBe("read @config.json");
  });

  it("marks a truncated file in the block itself", () => {
    const files = new Map([["big.txt", { content: "start…", truncated: true }]]);
    const r = expandMentions("see @big.txt", files);
    expect(r.text).toContain("--- big.txt (truncated) ---");
    expect(r.inlined[0]!.truncated).toBe(true);
  });

  it("leaves a message with no references exactly as it was", () => {
    const r = expandMentions("just a question", new Map());
    expect(r.text).toBe("just a question");
    expect(r.inlined).toEqual([]);
  });

  it("has a limit that is small enough to protect the context window", () => {
    // Not an assertion about a number for its own sake: inlining a 1 MB file would consume the whole
    // window and the model would answer about the file instead of the question.
    expect(INLINE_LIMIT_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("parseListing reads the host's formatted listing", () => {
  it("takes files and drops directories", () => {
    // The exact shape Rust emits, pinned by its own tests: `dir  sub` (two spaces) and
    // `file sub/deep/x.txt`. Splitting on whitespace and taking the last token would have produced
    // a "path" of "README.md" here only by luck; a path with a space would break it outright.
    const out = parseListing("dir  src\nfile README.md\nfile src/main.rs");
    expect(out.map((f) => f.path)).toEqual(["README.md", "src/main.rs"]);
  });

  it("survives a path containing a space", () => {
    expect(parseListing("file my notes.md").map((f) => f.path)).toEqual(["my notes.md"]);
  });

  it("ignores anything that is not a listing line", () => {
    expect(parseListing("")).toEqual([]);
    expect(parseListing("\n\n")).toEqual([]);
    // An error message that reached here by mistake must not become a filename.
    expect(parseListing("path escapes the workspace")).toEqual([]);
  });

  it("does not confuse 'dir' with a file called dir", () => {
    expect(parseListing("file dir")).toEqual([{ path: "dir" }]);
  });
});

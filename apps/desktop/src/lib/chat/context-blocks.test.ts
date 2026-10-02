/**
 * The blocks "Add context" writes, and the one rule that matters most: a file the composer cannot
 * read must be refused, never inlined.
 *
 * That rule is the reason this file exists. `readAsText` does not fail on a PDF — it succeeds and
 * returns garbage — so the failure mode is not an error the user notices, it is a plausible-looking
 * draft containing bytes the model will read as nonsense. Every classification case below is a
 * version of that: what the browser says a file is, versus what reading it would actually do.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_INSTRUCTION_CHARS,
  binaryRefusal,
  clampInstruction,
  contextSummary,
  documentRefusal,
  fileKind,
  instructionSystemText,
  looksBinary,
  previousResultBlock,
  previousResultMarkerCount,
} from "./context-blocks";

describe("fileKind decides by name before type", () => {
  it("calls the images the composer can carry as parts images", () => {
    expect(fileKind("shot.png", "image/png")).toBe("image");
    expect(fileKind("shot.jpg", "image/jpeg")).toBe("image");
    expect(fileKind("anim.webp", "image/webp")).toBe("image");
    // A GIF the provider may reject is still an image part, not a text file: the gate for whether
    // the model can see is the model's declared vision, and that decision belongs in one place.
    expect(fileKind("anim.gif", "image/gif")).toBe("image");
  });

  it("calls containers documents, so they are refused rather than mangled", () => {
    expect(fileKind("paper.pdf", "application/pdf")).toBe("document");
    expect(fileKind("report.docx", "application/octet-stream")).toBe("document");
    expect(fileKind("slides.pptx", "application/octet-stream")).toBe("document");
    expect(fileKind("sheet.xlsx", "application/octet-stream")).toBe("document");
  });

  it("treats a container extension as decisive over a text-ish type", () => {
    // The trap this closes: `.rtf` and `.doc` report as text-ish types and are containers in fact.
    // Believing the type here appends control words to the draft and calls it success.
    expect(fileKind("notes.rtf", "text/rtf")).toBe("document");
    expect(fileKind("old.doc", "application/msword")).toBe("document");
    expect(fileKind("thing.epub", "text/plain")).toBe("document");
  });

  it("calls known source and data extensions text, type or no type", () => {
    // Drag-and-drop from some file managers reports no type at all; the name is all there is.
    expect(fileKind("main.rs", "")).toBe("text");
    expect(fileKind("notes.md", "")).toBe("text");
    expect(fileKind("data.json", "application/json")).toBe("text");
    expect(fileKind("config.yaml", "application/octet-stream")).toBe("text");
    expect(fileKind("run.log", "")).toBe("text");
    expect(fileKind("query.sql", "")).toBe("text");
  });

  it("leaves anything unrecognised for inspection, not for guessing", () => {
    // "unknown" is a real answer: it means read a chunk and look, rather than assume text and be
    // wrong on a disk image someone dropped.
    expect(fileKind("blob.bin", "")).toBe("unknown");
    expect(fileKind("archive.tar", "application/x-tar")).toBe("unknown");
    expect(fileKind("clip.mp4", "video/mp4")).toBe("unknown");
  });
});

describe("looksBinary spots a container by its bytes", () => {
  it("flags a NUL byte", () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x00, 0x04]))).toBe(true);
    expect(looksBinary(new Uint8Array([0x00]))).toBe(true);
  });

  it("passes ordinary text, including multi-byte characters", () => {
    expect(looksBinary(new TextEncoder().encode("hello\nworld\n"))).toBe(false);
    // UTF-8 for "café — naïve" has no NUL, and must not be mistaken for a binary.
    expect(looksBinary(new TextEncoder().encode("café — naïve\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([]))).toBe(false);
  });
});

describe("the refusals name the path that works", () => {
  it("tells the user how to send a document instead of just saying no", () => {
    const msg = documentRefusal("paper.pdf");
    expect(msg).toContain("paper.pdf");
    // Both working routes, because a refusal with no alternative is a dead end.
    expect(msg).toContain("@");
    expect(msg).toContain("read_document");
  });

  it("says what is wrong with a binary rather than what it is not", () => {
    expect(binaryRefusal("blob.bin")).toContain("binary");
    expect(binaryRefusal("blob.bin")).toContain("blob.bin");
  });
});

describe("instructionSystemText shapes a per-turn constraint", () => {
  it("produces a system message that separates the constraint from the user's words", () => {
    const text = instructionSystemText("Reply in Bangla.");
    expect(text).toContain("Reply in Bangla.");
    // The model must not read the constraint as the user's message; that distinction is the whole
    // reason this goes in a system turn instead of being prepended to the draft.
    expect(text).toMatch(/not treat them as the user's message/i);
  });

  it("returns nothing for a blank instruction, so no empty system turn is sent", () => {
    expect(instructionSystemText("")).toBe("");
    expect(instructionSystemText("   \n  ")).toBe("");
  });

  it("trims, so trailing whitespace does not become a message of its own", () => {
    expect(instructionSystemText("  be brief  \n")).toContain("be brief");
    expect(instructionSystemText("  be brief  \n").endsWith("be brief")).toBe(true);
  });
});

describe("clampInstruction stops the instruction becoming a second prompt", () => {
  it("leaves a normal instruction alone", () => {
    expect(clampInstruction("be brief")).toBe("be brief");
  });

  it("cuts at the limit", () => {
    const long = "x".repeat(MAX_INSTRUCTION_CHARS + 500);
    expect(clampInstruction(long).length).toBe(MAX_INSTRUCTION_CHARS);
  });
});

describe("previousResultBlock caps what a reused answer costs", () => {
  it("labels the block so it is countable and visible in the draft", () => {
    const { block, truncated } = previousResultBlock("answer 1", "the whole answer", 1000);
    expect(block).toContain("Previous result — answer 1");
    expect(block).toContain("the whole answer");
    expect(truncated).toBe(false);
  });

  it("says in-band that it truncated, so neither reader has to guess", () => {
    const { block, truncated } = previousResultBlock("answer 1", "y".repeat(300), 100);
    expect(truncated).toBe(true);
    expect(block).toContain("(truncated)");
    // The body is the cap, not the original: a reused output must not cost the whole window.
    expect(block).toContain("y".repeat(100));
    expect(block).not.toContain("y".repeat(101));
  });
});

describe("the button's summary is derived from the draft, not from click history", () => {
  const none = { attachments: 0, references: 0, results: 0, instruction: "" };

  it("shows no badge when nothing is attached", () => {
    const { badge, title } = contextSummary(none);
    expect(badge).toBeNull();
    expect(title).toMatch(/Add an image/);
  });

  it("counts every kind, and pluralises honestly", () => {
    expect(contextSummary({ ...none, attachments: 1 }).badge).toBe("· 1");
    expect(contextSummary({ ...none, attachments: 2, references: 1 }).badge).toBe("· 3");
    expect(contextSummary({ ...none, instruction: "be brief" }).badge).toBe("· 1");
  });

  it("ignores a whitespace-only instruction, which would send no system turn anyway", () => {
    expect(contextSummary({ ...none, instruction: "   " }).badge).toBeNull();
  });

  it("names what is attached, so the count is not a mystery number", () => {
    const { title } = contextSummary({ attachments: 1, references: 2, results: 1, instruction: "x" });
    expect(title).toContain("1 image");
    expect(title).toContain("2 file references");
    expect(title).toContain("1 reused result");
    expect(title).toContain("instruction");
  });
});

describe("previousResultMarkerCount reads the blocks back out of a draft", () => {
  it("counts blocks that survive in the text", () => {
    // Derived from the draft so deleting a block takes the count down with it — the badge cannot
    // claim context the user has since removed.
    const draft = [
      previousResultBlock("answer 1", "one", 100).block,
      "and now explain this",
      previousResultBlock("answer 2", "two", 100).block,
    ].join("\n\n");
    expect(previousResultMarkerCount(draft)).toBe(2);
  });

  it("does not count a mention of the phrase inside prose", () => {
    expect(previousResultMarkerCount("here is a Previous result — but inline")).toBe(0);
  });

  it("is zero for an empty draft", () => {
    expect(previousResultMarkerCount("")).toBe(0);
  });
});

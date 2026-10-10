/**
 * splitDocTitle.test.ts — how the plan card finds its title line.
 */
import { describe, expect, it } from "vitest";
import { splitDocTitle } from "../../components/DocCard";

describe("splitDocTitle", () => {
  it("peels an h1 title and drops the line from the body", () => {
    const src = "# Subagent System Upgrade — Two Phases\n\nBring the card up to ZCode's bar.\n\n1. Step one";
    expect(splitDocTitle(src)).toEqual({
      title: "Subagent System Upgrade — Two Phases",
      // Just the title LINE goes; the blank line that separated it from the body stays.
      body: "\nBring the card up to ZCode's bar.\n\n1. Step one",
    });
  });

  it("accepts an h2 title", () => {
    expect(splitDocTitle("## Plan\nbody")!.title).toBe("Plan");
  });

  it("strips inline markdown from the title", () => {
    expect(splitDocTitle("# **Bold** and `code`\nbody")!.title).toBe("Bold and code");
  });

  it("keeps prose-only documents whole — no title, body unchanged", () => {
    const src = "A plan written in plain paragraphs.";
    expect(splitDocTitle(src)).toEqual({ title: null, body: src });
  });

  it("ignores deeper headings — an h3 section is not a title", () => {
    const src = "intro\n\n### Phase 1\nsteps";
    expect(splitDocTitle(src)).toEqual({ title: null, body: src });
  });
});

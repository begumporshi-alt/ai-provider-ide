/**
 * session-skills.test.ts — the per-conversation visibility rule.
 *
 * The rule has three consumers that must agree (the prompt index, the load_skill resolver, the
 * drawer), so the tests pin each branch of it: the override wins over the global flag in both
 * directions, a slug the map omits falls through, and the resolver matches name and slug but
 * never a globally- or session-disabled skill.
 */
import { describe, expect, it } from "vitest";
import {
  filterSessionSkills,
  recordSkillUse,
  resolveSessionSkill,
  sessionVisible,
  skillsIndexBlock,
  type SessionSkill,
} from "./session-skills";

const skills: SessionSkill[] = [
  { slug: "code-review", name: "Code review", enabled: true },
  { slug: "commit-message", name: "Commit message", enabled: false },
];

describe("sessionVisible", () => {
  it("falls through to the global flag when the slug is not overridden", () => {
    expect(sessionVisible(skills[0], {})).toBe(true);
    expect(sessionVisible(skills[1], {})).toBe(false);
  });

  it("the session override wins over the global flag in both directions", () => {
    expect(sessionVisible(skills[0], { "code-review": false })).toBe(false);
    expect(sessionVisible(skills[1], { "commit-message": true })).toBe(true);
  });
});

describe("filterSessionSkills", () => {
  it("keeps only the skills the conversation can see", () => {
    expect(filterSessionSkills(skills, {}).map((s) => s.slug)).toEqual(["code-review"]);
    expect(filterSessionSkills(skills, { "commit-message": true, "code-review": false }).map((s) => s.slug))
      .toEqual(["commit-message"]);
  });
});

describe("resolveSessionSkill", () => {
  it("matches by name", () => {
    expect(resolveSessionSkill(skills, {}, "Code review")?.slug).toBe("code-review");
  });

  it("matches by slug", () => {
    expect(resolveSessionSkill(skills, {}, "code-review")?.slug).toBe("code-review");
  });

  it("refuses a skill the session turned off, even though it is globally enabled", () => {
    expect(resolveSessionSkill(skills, { "code-review": false }, "Code review")).toBeNull();
  });

  it("refuses a globally-disabled skill the session did not pull back in", () => {
    expect(resolveSessionSkill(skills, {}, "Commit message")).toBeNull();
    expect(resolveSessionSkill(skills, { "commit-message": true }, "Commit message")?.slug)
      .toBe("commit-message");
  });

  it("answers null for an unknown name", () => {
    expect(resolveSessionSkill(skills, {}, "nope")).toBeNull();
  });
});

describe("skillsIndexBlock", () => {
  it("is empty when nothing is visible", () => {
    expect(skillsIndexBlock([])).toBe("");
  });

  it("indexes each visible skill by name and summary", () => {
    const block = skillsIndexBlock([{ name: "Code review", description: "Review a change." }]);
    expect(block).toContain("load_skill");
    expect(block).toContain("- Code review: Review a change.");
  });
});

describe("recordSkillUse", () => {
  it("appends a first use with its timestamp", () => {
    const used = recordSkillUse([], { slug: "code-review", name: "Code review" }, 100);
    expect(used).toEqual([{ slug: "code-review", name: "Code review", at: 100 }]);
  });

  it("keeps the first use — a second load of the same skill adds no row", () => {
    const first = recordSkillUse([], { slug: "code-review", name: "Code review" }, 100);
    expect(recordSkillUse(first, { slug: "code-review", name: "Code review" }, 200)).toBe(first);
  });
});

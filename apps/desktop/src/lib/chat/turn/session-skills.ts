/**
 * Session-scoped skill visibility — the shared rule for which skills a conversation can reach.
 *
 * The Skills screen's enable/disable is global: it rewrites what every conversation sees. This
 * module adds the per-conversation layer on top: a session override map (slug -> on/off) that a
 * turn consults before the global flag, so the user can remove a noisy skill from the current
 * chat — or pull a globally-disabled one back in for exactly one task — without touching what any
 * other session gets.
 *
 * Three consumers must agree on the rule, so it lives here once: the prompt's skill index (what
 * the model is told exists), the `load_skill` resolver (what a call can actually fetch), and the
 * session-skills drawer (what the toggles show).
 */

/** slug -> on/off for this conversation. A slug the map omits falls back to the global flag. */
export type SkillOverride = Record<string, boolean>;

/** The slice of `Skill` the rule needs — enough for tests to pass plain fixtures. */
export interface SessionSkill {
  slug: string;
  name: string;
  enabled: boolean;
}

/** One `load_skill` hit in this conversation, newest-first by first load. */
export interface UsedSkill {
  slug: string;
  name: string;
  at: number;
}

/** The session override wins; its absence falls through to the global flag. */
export function sessionVisible(s: SessionSkill, overrides: SkillOverride): boolean {
  return overrides[s.slug] ?? s.enabled;
}

/** The skills this conversation can see, in the list's own order. */
export function filterSessionSkills<T extends SessionSkill>(all: T[], overrides: SkillOverride): T[] {
  return all.filter((s) => sessionVisible(s, overrides));
}

/** Resolve a `load_skill` request by name or slug, among the skills this conversation can see. */
export function resolveSessionSkill<T extends SessionSkill>(
  all: T[],
  overrides: SkillOverride,
  name: string,
): T | null {
  return all.find((s) => sessionVisible(s, overrides) && (s.name === name || s.slug === name)) ?? null;
}

/** The prompt block that indexes the visible skills for the model. Empty when there are none. */
export function skillsIndexBlock(active: Array<{ name: string; description: string }>): string {
  return active.length === 0
    ? ""
    : "\n\nInstalled skills — when the task matches one, load it with the load_skill tool and follow its procedure:\n\n"
      + active.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** Record a load, keeping the FIRST use's timestamp — one row per skill, not per call. */
export function recordSkillUse(used: UsedSkill[], hit: { slug: string; name: string }, at: number): UsedSkill[] {
  if (used.some((u) => u.slug === hit.slug)) return used;
  return [...used, { slug: hit.slug, name: hit.name, at }];
}

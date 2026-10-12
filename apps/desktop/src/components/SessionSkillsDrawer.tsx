/**
 * Session-skills drawer — which skills this conversation can see, and which it actually loaded.
 *
 * Two sections, one rule (lib/chat/turn/session-skills): the used log is what the model already
 * fetched through `load_skill` in this conversation; the toggle list is the session-visibility
 * view over the installed catalog, where the session override — not the Skills screen's global
 * flag — decides what the current chat's turns may reach. Nothing here writes the global flag:
 * the Skills screen owns that, and the footer says so.
 *
 * Pinned to the transcript's right edge, the same mount point as the SubagentsDrawer. Unlike that
 * drawer — which renders nothing before the first delegation — the rail here stays visible once
 * any skill is installed: there is always something true to say (the "N on · M used" counts), and
 * a control that exists to be found must be findable.
 */
import { useEffect, useState } from "react";
import { listSkills, type Skill } from "../store";
import { sessionVisible, type SkillOverride, type UsedSkill } from "../lib/chat/turn/session-skills";
import { useUi } from "../ui-state";

export function SessionSkillsDrawer({
  overrides,
  used,
  onToggle,
  onResetOverrides,
}: {
  overrides: SkillOverride;
  used: UsedSkill[];
  /** Flip one skill's session visibility. `next` is what the row should read afterwards. */
  onToggle: (slug: string, next: boolean) => void;
  /** Drop every session override, back to the global flags. */
  onResetOverrides: () => void;
}) {
  const tick = useUi((s) => s.tick);
  // The runs drawer's open state is read only for the offset — two expanded panels would
  // otherwise overlap, and the subagents one does not move for anyone.
  const runsDrawerOpen = useUi((s) => s.runsDrawerOpen);
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);

  // Same read-late rule as the prompt's skills block: re-read on every tick so an install or a
  // Skills-screen toggle is reflected without a restart. The session overrides arrive as props,
  // so a toggle re-renders the rows through the parent.
  useEffect(() => {
    listSkills().then(setSkills).catch(() => undefined);
  }, [tick]);

  const visible = skills.filter((s) => sessionVisible(s, overrides));
  const overridden = skills.filter((s) => s.slug in overrides && overrides[s.slug] !== s.enabled);

  if (skills.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open session skills drawer"
        data-testid="session-skills-rail"
        // top-10: below the runs drawer's rail, which owns top-2 on the same edge.
        className="absolute right-2 top-10 z-30 flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-opacity hover:opacity-90"
        style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}
        title="Which skills this session can use, and which it loaded"
      >
        {used.length > 0 && (
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <span className="mono">
          {visible.length} on{used.length > 0 ? ` · ${used.length} used` : ""}
          {overridden.length > 0 ? " · session" : ""}
        </span>
      </button>
    );
  }

  return (
    <aside
      className={`absolute bottom-2 top-2 z-30 flex w-72 flex-col overflow-hidden rounded-xl border shadow-xl ${
        // The offset is the runs drawer's width (w-72) plus its inset: when both are open the
        // two panels sit side by side instead of painting over each other.
        runsDrawerOpen ? "right-[19rem]" : "right-2"
      }`}
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="session-skills-drawer"
      aria-label="Session skills"
    >
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Session skills
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close session skills drawer"
          className="rounded px-1 text-[11px] transition-opacity hover:opacity-80"
          style={{ color: "var(--text-faint)" }}
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Used this session
        </p>
        {used.length === 0 ? (
          <p className="px-1 pb-2 text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="session-skills-empty-used">
            Nothing loaded yet — the agent loads a skill when the task matches one.
          </p>
        ) : (
          used.map((u) => {
            const desc = skills.find((s) => s.slug === u.slug)?.description ?? "";
            return (
              <div
                key={u.slug}
                data-testid="session-skills-used-row"
                className="mb-1 rounded-md border px-2 py-1.5"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{u.name}</span>
                  <span className="mono shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {new Date(u.at).toLocaleTimeString()}
                  </span>
                </span>
                {desc && (
                  <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: "var(--text-dim)" }}>
                    {desc}
                  </span>
                )}
              </div>
            );
          })
        )}

        <div className="my-2 flex items-center justify-between border-t px-1 pt-2" style={{ borderColor: "var(--border)" }}>
          <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
            For this conversation
          </p>
          {overridden.length > 0 && (
            <button
              type="button"
              onClick={onResetOverrides}
              data-testid="session-skills-reset"
              className="shrink-0 whitespace-nowrap text-[10px] transition-opacity hover:opacity-80"
              style={{ color: "var(--accent)" }}
            >
              reset to global
            </button>
          )}
        </div>
        {visible.length === 0 && (
          <p className="px-1 pb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
            Every skill is off for this conversation.
          </p>
        )}
        {skills.map((s) => {
          const on = visible.includes(s);
          const differs = s.slug in overrides && overrides[s.slug] !== s.enabled;
          return (
            <label
              key={s.slug}
              data-testid="session-skills-row"
              className="mb-0.5 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => onToggle(s.slug, e.target.checked)}
                aria-label={`${s.name} — available this session`}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[12px]">{s.name}</span>
                  {differs && (
                    <span
                      data-testid="session-skills-override-mark"
                      className="shrink-0 text-[10px]"
                      style={{ color: "var(--accent)" }}
                    >
                      this session only
                    </span>
                  )}
                </span>
                {s.description && (
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {s.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <p className="shrink-0 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
        Toggles apply to this conversation only — the Skills screen changes every session.
      </p>
    </aside>
  );
}

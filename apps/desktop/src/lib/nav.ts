/**
 * The app's screens, in sidebar order — the single list the sidebar and the command palette both
 * render.
 *
 * It lives here rather than in `Shell.tsx` because two consumers now exist, and the second one was
 * the point: a palette that lists screens has to list the *same* screens. A copy would go stale the
 * first time a screen was added, and the failure would be silent in both directions — the sidebar
 * would show a screen the palette could not reach, or the palette would offer one that no longer
 * exists. `web-test/smoke.spec.ts` walks this same list, so "every screen renders" is checked
 * against the list the UI actually uses rather than a hand-kept mirror of it.
 *
 * Pure data with a type-only import, so the Playwright specs can import it without pulling React or
 * zustand into the test process.
 */
import type { ScreenId } from "../ui-state";

export interface NavItem {
  id: ScreenId;
  label: string;
  /**
   * A key into the shell's icon set, rendered left of the label. A plain string rather than a
   * component so this file stays pure data — the Playwright specs import it without pulling
   * React in, and the icon set stays a presentation concern of `Shell`.
   */
  icon: string;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * Workspace / Knowledge / System, in the order a user reaches for them: what they work in,
 * what the router has learned, and what runs underneath. The labels are load-bearing — the
 * specs click them by exact accessible name — so "AI Providers" stays "AI Providers".
 */
export const NAV: readonly NavGroup[] = [
  {
    group: "Workspace",
    items: [
      { id: "assistant", label: "Assistant", icon: "chat" },
      { id: "models", label: "Model Browser", icon: "cube" },
      { id: "activity", label: "Activity", icon: "clock" },
    ],
  },
  {
    group: "Knowledge",
    items: [
      { id: "context", label: "Context", icon: "file" },
      { id: "history", label: "History", icon: "history" },
      { id: "memory", label: "Memory", icon: "memory" },
      { id: "skills", label: "Skills", icon: "star" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "providers", label: "AI Providers", icon: "cloud" },
      { id: "agents", label: "Agents", icon: "agents" },
      { id: "control", label: "Control", icon: "sliders" },
      { id: "settings", label: "Router Settings", icon: "nodes" },
      { id: "gateway", label: "Local Gateway", icon: "gateway" },
      { id: "onboarding", label: "Auto setup", icon: "sparkle" },
    ],
  },
];

/** Every screen id, flattened — the set a command palette's "go to" entries covers. */
export const SCREEN_IDS: readonly ScreenId[] = NAV.flatMap((g) => g.items.map((i) => i.id));

/** The label a screen is known by, for a palette row or a title. */
export function screenLabel(id: ScreenId): string {
  for (const g of NAV) for (const it of g.items) if (it.id === id) return it.label;
  return id;
}

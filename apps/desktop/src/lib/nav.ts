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
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const NAV: readonly NavGroup[] = [
  {
    group: "Providers",
    items: [
      { id: "providers", label: "AI Providers" },
      { id: "onboarding", label: "Auto setup" },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "models", label: "Model Browser" },
      { id: "assistant", label: "Assistant" },
      { id: "activity", label: "Activity" },
      { id: "context", label: "Context" },
      { id: "history", label: "History" },
      { id: "skills", label: "Skills" },
      { id: "agents", label: "Agents" },
      { id: "memory", label: "Memory" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "control", label: "Control" },
      { id: "settings", label: "Router Settings" },
      { id: "gateway", label: "Local Gateway" },
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

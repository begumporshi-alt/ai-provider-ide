/**
 * ui-shell state: current screen + a global "tick". router-core owns the real state; the UI
 * re-reads it whenever an action bumps the tick (no duplicated truth, no dirty-checking).
 */
import { create } from "zustand";

export type ScreenId = "providers" | "models" | "playground" | "activity" | "settings" | "gateway";

interface UiState {
  screen: ScreenId;
  tick: number;
  go: (s: ScreenId) => void;
  bump: () => void;
}

export const useUi = create<UiState>((set) => ({
  screen: "providers",
  tick: 0,
  go: (screen) => set({ screen }),
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));

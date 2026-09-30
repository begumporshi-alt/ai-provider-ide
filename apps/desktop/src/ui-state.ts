/**
 * ui-shell state: current screen + a global "tick". router-core owns the real state; the UI
 * re-reads it whenever an action bumps the tick (no duplicated truth, no dirty-checking).
 */
import { create } from "zustand";

export type ScreenId = "providers" | "models" | "assistant" | "activity" | "context" | "history" | "skills" | "agents" | "memory" | "settings" | "gateway" | "control" | "onboarding";

export interface OnboardingPrefill {
  name: string;
  baseUrl: string;
  docsUrl?: string;
}

interface UiState {
  screen: ScreenId;
  tick: number;
  /** One-shot Connect-form prefill for the auto-setup wizard (e.g. "re-run setup against a new URL"). */
  onboardingPrefill?: OnboardingPrefill;
  /** One-shot session transcript to seed the Assistant with on navigation (from History → Assistant). */
  resumeTranscript?: ResumeMsg[];
  go: (s: ScreenId) => void;
  bump: () => void;
  setOnboardingPrefill: (p?: OnboardingPrefill) => void;
  setResumeTranscript: (m?: ResumeMsg[]) => void;
}

export type ResumeMsg = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
};

export const useUi = create<UiState>((set) => ({
  screen: "providers",
  tick: 0,
  go: (screen) => set({ screen }),
  bump: () => set((s) => ({ tick: s.tick + 1 })),
  setOnboardingPrefill: (onboardingPrefill) => set({ onboardingPrefill }),
  setResumeTranscript: (resumeTranscript) => set({ resumeTranscript }),
}));

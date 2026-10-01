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

/**
 * Cross-screen one-shots, addressed at whatever component owns the target.
 *
 * **Pending and consumed, not a counter.** The first version kept a counter per intent and the
 * consumer reacted to a change — which failed exactly where it mattered: the palette's "Focus the
 * composer" navigates to the Assistant and *then* fires, so the component that has to act on it
 * mounts after the increment. A consumer that records the value it saw at mount treats that as
 * "already handled" and does nothing, which is a command that visibly does not work.
 *
 * So the shape is a single pending request that the target claims with `consumeIntent`. It survives
 * a mount (the command works from another screen), it does not replay (the consumer clears it), and
 * firing twice leaves one pending request rather than a queue of them — for "start a new chat" and
 * "focus the composer" the latest request is the only one that means anything.
 */
export type UiIntent = "new-chat" | "focus-composer" | "focus-history-search";

/** The two keyboard overlays the shell can open. */
export type OverlayKind = "palette" | "sheet";

/**
 * Whether the sidebar is folded to an icon rail.
 *
 * Persisted to localStorage rather than to the host's settings store: it is window chrome, not
 * app data, and a cold start should restore the width the user last chose without a gateway
 * round-trip — the same reason the OS remembers a window's size.
 */
const SIDEBAR_KEY = "aip.sidebarCollapsed";

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false; // no storage (or a blocked one) is the expanded default, not an error
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // fire-and-forget: a failed write just means the fold resets next launch
  }
}

interface UiState {
  screen: ScreenId;
  tick: number;
  /** One-shot Connect-form prefill for the auto-setup wizard (e.g. "re-run setup against a new URL"). */
  onboardingPrefill?: OnboardingPrefill;
  /** One-shot session transcript to seed the Assistant with on navigation (from History → Assistant). */
  resumeTranscript?: ResumeMsg[];
  /** The unclaimed one-shot request, if any; see `UiIntent`. */
  pendingIntent?: { kind: UiIntent; nonce: number };
  /**
   * The open keyboard overlay, or null.
   *
   * In the store rather than in a component because it is read from two places that must agree:
   * the host that renders it, and the Assistant's Escape handler — which must NOT stop the running
   * turn when the user is only dismissing the palette.
   */
  overlay: OverlayKind | null;
  /**
   * Whether an Assistant turn is in flight, published by `Chat`.
   *
   * Published because the palette offers "New chat", and that action is refused while a turn runs
   * (`Chat`'s own New button is disabled for the same reason: re-entering the loop mid-stream would
   * interleave two runs into one transcript). Without this the palette would offer an action that
   * is silently a no-op. Nothing else reads it.
   */
  assistantBusy: boolean;
  /** Whether the sidebar is folded to an icon rail; see `SIDEBAR_KEY`. */
  sidebarCollapsed: boolean;
  /**
   * Requests the intent be dropped, so a stale one cannot fire on an unrelated mount later.
   * Called by the target once it has acted — or once it has decided the request is not for it.
   */
  consumeIntent: () => void;
  go: (s: ScreenId) => void;
  bump: () => void;
  setOnboardingPrefill: (p?: OnboardingPrefill) => void;
  setResumeTranscript: (m?: ResumeMsg[]) => void;
  fire: (k: UiIntent) => void;
  setOverlay: (o: OverlayKind | null) => void;
  setAssistantBusy: (b: boolean) => void;
  toggleSidebar: () => void;
}

export const useUi = create<UiState>((set) => ({
  screen: "providers",
  tick: 0,
  overlay: null,
  assistantBusy: false,
  sidebarCollapsed: loadSidebarCollapsed(),
  go: (screen) => set({ screen }),
  bump: () => set((s) => ({ tick: s.tick + 1 })),
  setOnboardingPrefill: (onboardingPrefill) => set({ onboardingPrefill }),
  setResumeTranscript: (resumeTranscript) => set({ resumeTranscript }),
  consumeIntent: () => set({ pendingIntent: undefined }),
  // The nonce is not read by anything today: the kind is what the consumer matches on. It is there
  // so that two `fire`s in a row are distinguishable in a trace, which is the only way to tell
  // "the second request was dropped" from "the first request was handled twice".
  fire: (k) => set((s) => ({ pendingIntent: { kind: k, nonce: (s.pendingIntent?.nonce ?? 0) + 1 } })),
  setOverlay: (overlay) => set({ overlay }),
  setAssistantBusy: (assistantBusy) => set({ assistantBusy }),
  toggleSidebar: () =>
    set((s) => {
      saveSidebarCollapsed(!s.sidebarCollapsed);
      return { sidebarCollapsed: !s.sidebarCollapsed };
    }),
}));

/**
 * Sidebar shell (UI_UX_PLAN.md): a 224px rail that folds to a 64px icon strip, grouped nav
 * Workspace / Knowledge / System, and the persistent `● Router healthy` chip.
 *
 * The fold is a width transition on the `<aside>` plus an opacity fade on the labels (`.side-rail`
 * / `.side-label` in index.css): the text disappears *into* the narrowing rail instead of being
 * clipped by it, and the choice persists across launches via `ui-state`'s localStorage flag.
 * ⌘B / Ctrl+B toggles it, and the chevron in the top bar is the discoverable form of the same
 * action — the shortcut is registered here rather than in `ShortcutHost` because it is window
 * chrome, not a screen command.
 *
 * The nav list itself lives in `lib/nav.ts` — the command palette renders the same screens, and the
 * shortcut host lives in this component's tree — so this file is only the chrome.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useUi } from "../ui-state";
import { bootDegradedReason, registry, router } from "../store";
import { StatusDot } from "./atoms";
import { ShortcutHost } from "./ShortcutHost";
import { NAV, screenLabel } from "../lib/nav";

/**
 * The top bar's per-screen slot. A screen portals its own header content here — the Assistant
 * puts its session controls and the Chat/Image/Root tabs — instead of spending a second title
 * row under the chrome. `null` until the header has committed, the same shape the Assistant's
 * own session slot uses; screens render nothing into it until it exists.
 */
const HeaderSlotContext = createContext<HTMLDivElement | null>(null);

export function useHeaderSlot(): HTMLDivElement | null {
  return useContext(HeaderSlotContext);
}

/** 15px stroke icons keyed by the `icon` strings in `nav.ts`. Stroke inherits currentColor. */
const ICON_PATHS: Record<string, ReactNode> = {
  chat: <path d="M4 5.5h16v10H9.5L4 19.5v-14Z" />,
  compare: (
    <>
      <rect x="4" y="5.5" width="6.5" height="13" rx="1" />
      <rect x="13.5" y="5.5" width="6.5" height="13" rx="1" />
    </>
  ),
  cube: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v9m8-4.5L12 12 4 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  file: <path d="M7 3.5h7l4 4V20.5H7v-17Zm7 0v4h4" />,
  history: <path d="M4 12a8.5 8.5 0 1 1 2.6 6.1M4 5.5v4.5h4.5M12 8.5V12l2.8 1.8" />,
  memory: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
      <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
    </>
  ),
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8L12 3.5Z" />,
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18.2 9a3.9 3.9 0 0 1-.7 9.5H7Z" />,
  agents: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M3.5 20v-.5a5 5 0 0 1 5-5h1a5 5 0 0 1 5 5v.5M16 5.6a3.5 3.5 0 0 1 0 5.8M18.5 14.8a5 5 0 0 1 2 4.2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9m4.5 0H20M4 17h3m4.5 0H20" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  nodes: (
    <>
      <circle cx="17.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="12" r="2.2" />
      <circle cx="17.5" cy="18.5" r="2.2" />
      <path d="m8.6 11 6.9-4.2M8.6 13l6.9 4.2" />
    </>
  ),
  gateway: (
    <>
      <rect x="4" y="4.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.5" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </>
  ),
  sparkle: <path d="m12 4 1.8 4.7L18.5 10.5l-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8L12 4Zm6.5 9.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />,
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[15px] w-[15px] shrink-0"
      aria-hidden="true"
    >
      {ICON_PATHS[name] ?? ICON_PATHS.cube}
    </svg>
  );
}

/** The hexagon mark — a blue gradient core inside a tinted hull, legible on the navy rail. */
function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-[26px] w-[26px] shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id="aip-mark" x1="4" y1="4" x2="20" y2="20">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.8 21.2 7v10L12 22.2 2.8 17V7L12 1.8Z"
        fill="var(--accent)"
        opacity="0.14"
      />
      <path d="M12 6.2 17.6 9.4v6.4L12 19 6.4 15.8V9.4L12 6.2Z" fill="url(#aip-mark)" />
      <path d="M12 9.4l2.6 1.5v3L12 15.4l-2.6-1.5v-3L12 9.4Z" fill="#fff" opacity="0.85" />
    </svg>
  );
}

function PanelToggleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="m3.5 11 8.5-7.5L20.5 11M6 9.5V20h12V9.5" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  // `tick` is destructured and voided on purpose: reading it here subscribes the shell to every
  // store bump, which is what keeps the Router-health chip honest without a separate effect.
  const {
    screen,
    go,
    tick,
    fire,
    assistantBusy,
    sidebarCollapsed: collapsed,
    toggleSidebar,
  } = useUi();
  void tick;

  const providers = registry.listProviders();
  const live = providers.some((p) => p.status === "enabled");
  // The header slot. State, not a ref: screens consume it through the context below, which has to
  // re-render once the node exists — the same pattern as the Assistant's session slot.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  // ⌘B / Ctrl+B folds the rail. Guarded on modifiers and key only — a text field holding focus
  // must not swallow it, but the browser's own find-bar uses ⌘F and bold uses ⌘B *inside inputs*,
  // so the default is suppressed here. Textarea/input hosts re-enable bold locally if they ever
  // need rich text; today nothing in the app binds B for editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const newChat = () => {
    go("assistant");
    // The command palette refuses "new chat" while a turn runs — re-entering the loop mid-stream
    // would interleave two runs into one transcript. The sidebar button carries the same guard:
    // it navigates either way (looking at the running transcript is safe) but only fires the
    // reset when the assistant is idle.
    if (!assistantBusy) fire("new-chat");
  };

  return (
    <div className="flex h-full" style={{ background: "var(--bg)" }}>
      <aside
        // `w-[64px]`, not `w-16`: the app sets html { font-size: 13px }, so rem-based spacing
        // utilities shrink with it (w-16 computes to 52px). The rail's two widths are design
        // decisions in px — 64 folded, 224 open — so they are written in px outright.
        className={`side-rail flex shrink-0 flex-col overflow-hidden border-r ${collapsed ? "w-[64px]" : "w-[224px]"}`}
        style={{ background: "var(--sidebar)", borderColor: "var(--border)" }}
      >
        {/* Logo + name. When folded only the mark remains, centered on the rail. */}
        <div
          className={`flex h-[54px] shrink-0 items-center gap-2.5 border-b ${collapsed ? "justify-center" : "px-4"}`}
          style={{ borderColor: "var(--border)" }}
        >
          <LogoMark />
          {!collapsed && (
            <span className="side-label truncate text-[13px] font-semibold tracking-tight">AI-Provider Router</span>
          )}
        </div>

        <div className={`shrink-0 px-3 pb-1 pt-3 ${collapsed ? "flex justify-center px-0" : ""}`}>
          <button
            type="button"
            onClick={newChat}
            aria-label="New Chat"
            title="New Chat"
            className={`nav-item flex h-9 items-center gap-2 rounded-lg text-[13px] font-semibold text-white shadow-[0_1px_8px_rgba(59,130,246,0.35)] transition-transform enabled:active:scale-[0.98] ${
              collapsed ? "w-9 justify-center" : "w-full justify-center"
            }`}
            style={{ background: "linear-gradient(180deg, #4d8df8, #2f6fe0)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-4 w-4 shrink-0"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {!collapsed && <span className="side-label">New Chat</span>}
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
          {NAV.map((g) => (
            <div key={g.group} className="mb-1">
              {!collapsed ? (
                <div
                  className="side-label px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest"
                  style={{ color: "var(--text-faint)" }}
                >
                  {g.group}
                </div>
              ) : (
                <div className="mx-auto my-2.5 h-px w-6 rounded" style={{ background: "var(--border)" }} />
              )}
              {g.items.map((it) => {
                const active = screen === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => go(it.id)}
                    title={it.label}
                    className={`nav-item relative mb-0.5 flex w-full items-center rounded-lg text-left text-[13px] transition-colors ${
                      collapsed ? "h-9 justify-center" : "gap-2.5 px-2.5 py-[7px]"
                    }`}
                    style={
                      active
                        ? { background: "var(--accent-soft)", color: "var(--text)" }
                        : { color: "var(--text-dim)" }
                    }
                  >
                    {/* The active marker is the 3px bar on the rail's left edge, inside the button
                        so the focus ring wraps it too. */}
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full"
                        style={{ background: "var(--accent)" }}
                      />
                    )}
                    <span className="flex w-5 justify-center" style={{ color: active ? "var(--accent)" : undefined }}>
                      <NavIcon name={it.icon} />
                    </span>
                    {!collapsed && <span className="side-label truncate">{it.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div
          className={`shrink-0 border-t px-3 py-2.5 text-[12px] ${collapsed ? "flex justify-center px-0" : ""}`}
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        >
          <span className="inline-flex items-center gap-1.5" title={live ? "At least one provider is enabled" : "No provider is enabled"}>
            <StatusDot health={live ? "healthy" : "unknown"} />
            {!collapsed && <span className="side-label">Router {live ? "healthy" : "idle"}</span>}
          </span>
        </div>
        {/* A boot that could not reach the gateway. Named here rather than left to read as an empty
            app: the reads that fill every screen are host calls, so "no providers" and "the gateway
            is not running" look identical on screen and have opposite fixes. See
            `bootDegradedReason`. */}
        {!collapsed && bootDegradedReason() !== null && (
          <div className="side-label px-3 pb-1 text-[11px]" style={{ color: "var(--danger)" }}>
            Gateway not running — start it in Control to load your data.
          </div>
        )}
        {!collapsed && (
          <div className="side-label px-3 pb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
            {router.systemAiAvailable().available ? "System AI ready" : "System AI locked"}
          </div>
        )}
      </aside>

      <HeaderSlotContext.Provider value={headerSlot}>
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Top bar 48-52px: the fold toggle, then the screen's own header. The Assistant portals
            its session controls and the Chat/Image/Root tabs into the slot; every other screen
            keeps the breadcrumb. The duplication this removes was real: the Assistant used to
            spend a second title row ("Assistant · untitled session … Chat | Image | Root") directly
            under a bar that already said "Workspace / Assistant". */}
        <header
          data-testid="app-header"
          className="flex h-[50px] shrink-0 items-center gap-2 border-b px-4"
          style={{ borderColor: "var(--border)" }}
        >
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            className="nav-icon-btn flex h-8 w-8 items-center justify-center rounded-md"
            style={{ color: "var(--text-dim)" }}
          >
            <PanelToggleIcon />
          </button>
          <span className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} aria-hidden="true" />
          {screen !== "assistant" && (
            <>
              <button
                type="button"
                onClick={() => go("assistant")}
                title="Workspace"
                className="nav-icon-btn flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px]"
                style={{ color: "var(--text-dim)" }}
              >
                <HomeIcon />
                <span>Workspace</span>
              </button>
              <span style={{ color: "var(--text-faint)" }} aria-hidden="true">/</span>
              <span className="text-[13px]">{screenLabel(screen)}</span>
            </>
          )}
          <div ref={setHeaderSlot} className="flex min-w-0 flex-1 items-center gap-3" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </main>
      </HeaderSlotContext.Provider>
      {/* Rendered here rather than in each screen: the palette navigates between screens, and its
          listener has to exist on all of them. `Shell` is the only component that is always
          mounted once the app is up. */}
      <ShortcutHost />
    </div>
  );
}

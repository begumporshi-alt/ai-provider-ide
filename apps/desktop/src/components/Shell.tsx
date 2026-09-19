/**
 * Sidebar shell (UI_UX_PLAN.md): grouped nav PROVIDERS / TOOLS / SYSTEM, 220px,
 * tonal elevation, and the persistent `● Router healthy` chip.
 */
import { type ReactNode } from "react";
import { useUi, type ScreenId } from "../ui-state";
import { registry, router } from "../store";
import { StatusDot } from "../components/atoms";

const NAV: { group: string; items: { id: ScreenId; label: string }[] }[] = [
  { group: "Providers", items: [{ id: "providers", label: "AI Providers" }] },
  {
    group: "Tools",
    items: [
      { id: "models", label: "Model Browser" },
      { id: "playground", label: "Playground" },
      { id: "activity", label: "Activity" },
      { id: "context", label: "Context" },
      { id: "skills", label: "Skills" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "settings", label: "Router Settings" },
      { id: "gateway", label: "Local Gateway" },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { screen, go, tick } = useUi();
  void tick;
  const providers = registry.listProviders();
  const live = providers.some((p) => p.status === "enabled");
  return (
    <div className="flex h-full" style={{ background: "var(--bg)" }}>
      <aside
        className="flex w-[220px] shrink-0 flex-col border-r"
        style={{ background: "var(--sidebar)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2 px-4 py-3.5">
          <span className="text-[13px] font-semibold tracking-tight">AI-Provider Router</span>
        </div>
        <nav className="flex-1 overflow-y-auto px-2">
          {NAV.map((g) => (
            <div key={g.group} className="mb-3">
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
                {g.group}
              </div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => go(it.id)}
                  className="mb-0.5 block w-full rounded px-2 py-1.5 text-left text-[13px]"
                  style={
                    screen === it.id
                      ? { background: "var(--surface-2)", color: "var(--text)" }
                      : { color: "var(--text-dim)" }
                  }
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t px-4 py-2.5 text-[12px]" style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}>
          <span className="mr-1.5 inline-flex items-center gap-1.5">
            <StatusDot health={live ? "healthy" : "unknown"} />
            Router {live ? "healthy" : "idle"}
          </span>
        </div>
        <div className="px-4 pb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          {router.systemAiAvailable().available ? "System AI ready" : "System AI locked"}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[50px] shrink-0 items-center border-b px-5" style={{ borderColor: "var(--border)" }}>
          {/* top bar 48-52px; page title rendered by the screens */}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </main>
    </div>
  );
}

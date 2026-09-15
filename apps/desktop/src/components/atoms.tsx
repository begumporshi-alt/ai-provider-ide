/**
 * Shared atoms (UI_UX_PLAN.md component inventory, Phase 2a subset): the single health
 * vocabulary, StatusDot/Badge, masked KeyFingerprint, EmptyState, Modal, buttons.
 */
import { type ReactNode } from "react";

export type Health =
  | "healthy" | "testing" | "degraded" | "rate-limited" | "cooling-down"
  | "auth-failed" | "unavailable" | "disabled" | "unknown";

/** Map core states -> the ONE vocabulary. Never three words for the same state. */
export function healthOf(s: { status: string }): Health {
  switch (s.status) {
    case "active":
    case "enabled": return "healthy";
    case "cooldown":
    case "rate-limited": return "rate-limited";
    case "invalid": return "auth-failed";
    case "disabled": return "disabled";
    case "pending": return "testing";
    case "repairing": return "degraded";
    case "draft": return "unknown";
    default: return "unknown";
  }
}

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: "Healthy", testing: "Testing", degraded: "Degraded", "rate-limited": "Rate Limited",
  "cooling-down": "Cooling Down", "auth-failed": "Auth Failed", unavailable: "Unavailable",
  disabled: "Disabled", unknown: "Unknown",
};

const DOT_CLASS: Record<Health, string> = {
  healthy: "dot-healthy", testing: "dot-testing", degraded: "dot-degraded",
  "rate-limited": "dot-cooldown", "cooling-down": "dot-cooldown", "auth-failed": "dot-auth",
  unavailable: "dot-unavailable", disabled: "dot-disabled", unknown: "dot-unknown",
};

export function StatusDot({ health, pulse }: { health: Health; pulse?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[health]} ${pulse ? "animate-pulse" : ""}`}
      title={HEALTH_LABEL[health]}
    />
  );
}

export function StatusBadge({ health }: { health: Health }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
    >
      {HEALTH_LABEL[health]}
    </span>
  );
}

/** Identity without secrets: masked display everywhere (invariant 6). */
export function KeyFingerprint({ hint }: { hint?: string }) {
  return <span className="mono text-[12px] text-zinc-400">••••{hint ?? "?????"}</span>;
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10" style={{ borderColor: "var(--border)" }}>
      <p className="text-sm text-zinc-400">{title}</p>
      {action}
    </div>
  );
}

export function Button({
  children, onClick, disabled, variant = "default", type = "button",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost"; type?: "button" | "submit";
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" },
    primary: { background: "var(--accent)", border: "1px solid var(--accent)", color: "#0b0d10", fontWeight: 600 },
    danger: { background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)" },
    ghost: { background: "transparent", border: "1px solid transparent", color: "var(--text-dim)" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={styles[variant]}
      className="rounded px-2.5 py-1 text-[12px] transition-opacity enabled:hover:opacity-85 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[440px] rounded-lg border p-4 shadow-2xl"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="text-zinc-500 hover:text-zinc-300" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded border px-2 py-1.5 text-[13px] outline-none focus:brightness-125";
export const inputStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" };

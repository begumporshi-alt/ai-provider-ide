/**
 * Shared atoms (UI_UX_PLAN.md component inventory, Phase 2a subset): the single health
 * vocabulary, StatusDot/Badge, masked KeyFingerprint, EmptyState, Modal, buttons.
 */
import { type ReactNode, useEffect, useRef } from "react";

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
      // The dot is colour + hover title otherwise: invisible to a screen reader and to anyone
      // who never hovers. The label is the accessible name, not decoration.
      role="img"
      aria-label={HEALTH_LABEL[health]}
    />
  );
}

/**
 * In-flight marker for wizard work (probing, identifying, generating, checking). A line of
 * `Spinner + text` is the whole pattern — the text names the phase, the spinner says it is
 * alive. Pulse is for the same job on a dot; a spinner is for a sentence.
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
      <span className="spinner" role="status" aria-label={label ? `${label} — in progress` : "in progress"} />
      {label}
    </span>
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
  return <span className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>••••{hint ?? "?????"}</span>;
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10" style={{ borderColor: "var(--border)" }}>
      <p className="text-sm" style={{ color: "var(--text-dim)" }}>{title}</p>
      {action}
    </div>
  );
}

export function Button({
  children, onClick, disabled, variant = "default", type = "button", ariaLabel,
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost"; type?: "button" | "submit";
  /**
   * Overrides the accessible name when the visible text is not unique on the screen.
   *
   * Two cards that each render a button reading "Refresh" are ambiguous to a screen reader, not only to
   * a test selector — the name is what a user hears with no way to see which card they are in. The label
   * must still *contain* the visible text (WCAG 2.5.3 Label in Name), so "Refresh drift history" rather
   * than "Reload".
   */
  ariaLabel?: string;
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" },
    primary: { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--bg)", fontWeight: 600 },
    danger: { background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)" },
    ghost: { background: "transparent", border: "1px solid transparent", color: "var(--text-dim)" },
  };
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      style={styles[variant]}
      className="rounded px-2.5 py-1 text-[12px] transition-opacity enabled:hover:opacity-85 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * `width` exists because a modal that lists models is not the same shape as one that asks for a
 * single field, and the previous fixed 440px made every wide one scroll internally. `max-h` and
 * `overflow` are on the panel rather than the caller so a long body scrolls inside the dialog
 * instead of pushing its footer off screen.
 */
export function Modal({
  title, onClose, children, width = 440,
}: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  // Escape closes, and the panel takes focus on open so Escape has somewhere to land. No focus
  // trap yet — the next consumer that needs one should add it with a noted decision, not silently.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[85vh] overflow-y-auto rounded-lg border p-4 shadow-2xl outline-none"
        style={{ width, background: "var(--surface)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            className="transition-opacity hover:opacity-80"
            style={{ color: "var(--text-faint)" }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded border px-2 py-1.5 text-[13px] outline-none focus:brightness-125";
export const inputStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" };

import type { ComposedManifest } from "../lib/memory/manifest";

/**
 * The user-facing half of the manifest: what the assistant was told it knows, with the ids it
 * can be asked to forget. Rendered once per session, above the transcript, not per turn.
 */
export function ManifestCard({
  manifest,
  onForget,
}: {
  manifest: ComposedManifest;
  onForget?: (id: string) => void;
}) {
  if (manifest.entries.length === 0) return null;
  const active = manifest.entries.filter((e) => e.included).length;
  const stale = manifest.entries.filter((e) => e.verified === "contradicted").length;
  return (
    <details
      className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
      style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
      data-testid="manifest-card"
    >
      <summary className="cursor-pointer select-none">
        Session manifest · {active} active
        {stale > 0 ? ` · ${stale} stale capabilit${stale === 1 ? "y" : "ies"}` : ""}
      </summary>
      <ul className="mt-2 space-y-1">
        {manifest.entries.map((e) => (
          <li key={e.id} className="flex items-start gap-2">
            <span
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
              style={{ background: "var(--surface-2)" }}
            >
              {e.kind}
            </span>
            <span className={e.verified === "contradicted" ? "line-through opacity-70" : ""}>
              {e.text}
            </span>
            <span
              className="ml-auto shrink-0 font-mono text-[10px]"
              style={{ color: "var(--text-faint)" }}
            >
              {e.id}
            </span>
            {onForget ? (
              <button
                type="button"
                aria-label={`Forget ${e.id}`}
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => onForget(e.id)}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

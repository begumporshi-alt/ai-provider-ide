/**
 * Where a memory may be injected. Every row starts `off`; nothing is injected until someone
 * scopes it on purpose.
 *
 * Shared by the Memory screen's list rows and the Mind Atlas detail card, so the two cannot
 * drift apart on the one control that decides injection.
 *
 * `project` is disabled when the host has no workspace root, because there is then no project to
 * bind to — offering it would produce a scope that can never match a request.
 */
import type { Memory } from "../store";

export type MemoryScopeChoice =
  | { kind: "project"; project: string }
  | { kind: "global" }
  | { kind: "unscoped" };

export function ScopeSelect({
  m,
  projectKey,
  onChange,
}: {
  m: Memory;
  projectKey: string | null;
  onChange: (m: Memory, scope: MemoryScopeChoice) => void;
}) {
  const value = m.scope.global ? "global" : m.scope.project ? "project" : "off";
  return (
    <select
      className="shrink-0 rounded border px-1 py-0.5 text-[10px]"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
      title={
        value === "off"
          ? "Capture-only. Never injected into any request."
          : value === "global"
            ? "Injected into every request, in every project."
            : "Injected into requests from this project."
      }
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "global") onChange(m, { kind: "global" });
        else if (v === "project" && projectKey) onChange(m, { kind: "project", project: projectKey });
        else onChange(m, { kind: "unscoped" });
      }}
    >
      <option value="off">capture only</option>
      <option value="project" disabled={!projectKey}>
        this project{projectKey ? "" : " (no root)"}
      </option>
      <option value="global">everywhere</option>
    </select>
  );
}

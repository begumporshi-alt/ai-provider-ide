/**
 * CodeCandidateReview (L4, §2.7): the human gate for a Tier-2 code adapter.
 *
 * A declarative manifest is inert data — lintable and safe by construction. A code adapter is
 * EXECUTABLE, produced by an AI, so it gets its own review surface instead of a candidate
 * card: the human reads the exact source that will run, sees the four-gate evidence (schema →
 * static lint → sandbox compile → free contract checks over real HTTP), reads what the
 * sandbox forbids, and only then approves registration. Nothing else in the app can turn a
 * kind:"code" manifest on; this component is the only door (ARCHITECTURE.md §2.7:
 * "never executed before passing the contract suite, always human-confirmed").
 */
import { useState } from "react";
import type { RankedCandidate } from "@aiprovider/router";
import { Button, inputCls, inputStyle } from "./atoms";

const SOURCE_LIMIT = 64_000; // grammar bound, mirrored from the sandbox (defense in depth)

const BUDGETS: Array<[string, string]> = [
  ["Wall clock", "45 s per operation"],
  ["HTTP calls", "20 per operation"],
  ["Emitted lines", "400 per operation"],
  ["Response body", "8 MB cap"],
  ["Sandbox heap", "32 MB"],
  ["Stack", "512 KB"],
];

const FORBIDDEN = [
  "no filesystem, DOM, Node or dynamic import — none exist in QuickJS",
  "no import( / require / eval / Function( / fetch / XMLHttpRequest / WebAssembly",
  "relative provider paths only — it cannot address any other host",
  "auth headers it sets are dropped; the host injects the credential itself",
  "the key is never readable: it sees only a {{secret}} sentinel",
];

function Gate({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const mark = ok === null ? "○" : ok ? "✓" : "✕";
  const color = ok === null ? "var(--text-faint)" : ok ? "var(--success)" : "var(--danger)";
  return (
    <li className="flex items-start gap-2">
      <span style={{ color }}>{mark}</span>
      <span className="text-[12px]">
        {label}
        {detail && <span className="block text-[11px]" style={{ color: ok ? "var(--text-faint)" : "var(--danger)" }}>{detail}</span>}
      </span>
    </li>
  );
}

export function CodeCandidateReview({
  candidate,
  generating,
  logs,
  busy,
  approved,
  error,
  onApprove,
  onReject,
  onRegenerate,
}: {
  candidate: RankedCandidate | null;
  generating: boolean;
  logs: string[];
  busy: boolean;
  approved: boolean;
  error: string | null;
  onApprove: (c: RankedCandidate) => void;
  onReject: () => void;
  onRegenerate: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [showSource, setShowSource] = useState(true);

  if (generating) {
    return (
      <div className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-2 text-[14px] font-semibold">Tier-2 code adapter</h2>
        <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          The System AI is writing a sandboxed JS module. The source is linted, compiled inside
          the QuickJS sandbox, and run against the live provider before you see it.
        </p>
        <ul className="mt-3 space-y-1">
          {["static lint (source never reaches the sandbox unlinted)", "sandbox compile", "free contract checks over real HTTP"].map((s) => (
            <li key={s} className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
              <span style={{ color: "var(--text-faint)" }}>○</span>
              {s}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!candidate) return null;

  const source = candidate.manifest?.code?.source ?? "";
  const gates = candidateGates(candidate);
  const usable = Boolean(candidate.manifest && candidate.freePasses > 0 && candidate.code?.compiled);

  return (
    <div className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Tier-2 code adapter — human review required</h2>
        {usable && !approved && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "var(--warn)", color: "#0b0d10" }}>
            executable — review before approving
          </span>
        )}
      </div>

      <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
        This is code the AI wrote, not data. It ran sandboxed to produce the evidence below — it
        listed your provider's models through the sandbox's own HTTP channel without ever seeing
        your key. Read it: approving registers exactly this source as the provider's adapter.
      </p>

      <ul className="mb-3 space-y-1">
        <Gate ok={gates.schema} label="schema — parses against the frozen manifest grammar" detail={candidate.schemaErrors[0]} />
        <Gate ok={gates.lint} label="static lint — size, shape, no import/eval/fetch constructs" detail={candidate.lintErrors[0]} />
        <Gate
          ok={gates.compile}
          label="sandbox compile — the module compiled inside QuickJS-WASM"
          detail={candidate.code?.compileError}
        />
        <Gate
          ok={gates.contract}
          label={`free contract checks over real HTTP — ${candidate.contract ? `${candidate.contract.checks.filter((c) => c.pass).length}/${candidate.contract.checks.length} passed` : "not reached"}`}
          detail={candidate.contract?.checks.find((c) => !c.pass)?.detail ?? candidate.rejectedReason}
        />
      </ul>

      {candidate.contract && (
        <ul className="mb-3 space-y-0.5">
          {candidate.contract.checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
              <span style={{ color: c.pass ? "var(--success)" : "var(--danger)" }}>{c.pass ? "✓" : "✕"}</span>
              <span>
                {c.name}
                {c.paid && <span className="ml-1 rounded px-1 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--warn)" }}>paid</span>}
                {c.detail && <span className="block" style={{ color: "var(--text-faint)" }}>{c.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {source && (
        <div className="mb-3">
          <button
            className="mb-1 text-[11px] underline"
            style={{ color: "var(--text-dim)" }}
            onClick={() => setShowSource((s) => !s)}
          >
            {showSource ? "hide" : "show"} generated source ({source.length.toLocaleString()} / {SOURCE_LIMIT.toLocaleString()} chars)
          </button>
          {showSource && (
            <pre
              className="mono max-h-72 overflow-auto rounded border p-2 text-[10.5px] leading-relaxed"
              style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            >
              {source}
            </pre>
          )}
        </div>
      )}

      <details className="mb-3">
        <summary className="cursor-pointer text-[11px]" style={{ color: "var(--text-dim)" }}>what the sandbox forbids</summary>
        <ul className="mt-2 space-y-0.5 pl-4">
          {FORBIDDEN.map((f) => (
            <li key={f} className="list-disc text-[11px]" style={{ color: "var(--text-faint)" }}>{f}</li>
          ))}
        </ul>
        <div className="mt-2 grid grid-cols-2 gap-1 pl-4 sm:grid-cols-3">
          {BUDGETS.map(([k, v]) => (
            <div key={k} className="text-[11px]" style={{ color: "var(--text-dim)" }}>
              <span style={{ color: "var(--text-faint)" }}>{k}:</span> {v}
            </div>
          ))}
        </div>
      </details>

      {logs.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-[11px]" style={{ color: "var(--text-dim)" }}>guest log ({logs.length} line(s))</summary>
          <pre className="mono mt-2 max-h-32 overflow-auto rounded border p-2 text-[10.5px]" style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-faint)" }}>
            {logs.join("\n")}
          </pre>
        </details>
      )}

      {error && <p className="mb-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!usable || busy || approved}
          onClick={() => onApprove(candidate)}
        >
          {approved ? "Approved" : "Approve & register this code adapter"}
        </Button>
        <Button variant="danger" disabled={busy || approved} onClick={onReject}>
          Discard
        </Button>
        <input
          className={`${inputCls} min-w-[12rem] flex-1`}
          style={inputStyle}
          placeholder="Optional: what should the next attempt do differently?"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <Button disabled={busy || approved} onClick={() => onRegenerate(feedback.trim() || "")}>
          Regenerate
        </Button>
      </div>

      <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        The module cannot see your key, cannot reach another host, and is rebuilt from this source
        on every use — a fault tears its sandbox down rather than carrying state forward.
      </p>
    </div>
  );
}

/** Derive the four gate states from a RankedCandidate (null = that gate was not reached). */
function candidateGates(c: RankedCandidate): { schema: boolean | null; lint: boolean | null; compile: boolean | null; contract: boolean | null } {
  if (c.schemaErrors.length) return { schema: false, lint: null, compile: null, contract: null };
  if (c.lintErrors.length) return { schema: true, lint: false, compile: null, contract: null };
  if (c.code && !c.code.compiled) return { schema: true, lint: true, compile: false, contract: null };
  if (!c.contract) return { schema: true, lint: true, compile: c.code ? true : null, contract: null };
  return { schema: true, lint: true, compile: true, contract: c.contract.freePassed };
}

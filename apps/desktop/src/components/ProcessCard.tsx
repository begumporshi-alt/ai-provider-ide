/**
 * Live view of one background `run_command` job.
 *
 * A background job outlives the tool call that started it: the call returns `bg-N` in a second and
 * the transcript row shows that one line while the actual work — a dev server, a long build —
 * runs invisibly for minutes. The model only sees the job when it chooses to poll
 * `process_output`; the person saw nothing at all. This card polls the same read-only sandbox
 * tool on the UI's own clock (2s) and shows the status head plus the output tail, so "is it
 * actually running?" is a glance instead of a guess.
 *
 * It renders nothing until the first poll answers, and disappears (without an error) when the
 * job is gone — a resumed transcript from an earlier app run references ids the sandbox no
 * longer holds, and a card that nagged about that would be noise, not information.
 *
 * A running job also carries a stop button. Without it, the only way to end a job was to ask the
 * assistant to call `process_kill` — the model was the only one holding the steering wheel for
 * work the user started. The button calls the same sandbox tool; the next poll reads the result.
 */
import { useEffect, useState } from "react";
import { fetchProcessOutput, killProcess } from "../lib/tools/host";
import { parseProcessOutput, type JobTail } from "../lib/tools/processJob";

const POLL_MS = 2000;
const TAIL_LINES = 12;

function statusColor(t: JobTail): string {
  if (t.running) return "var(--warn)";
  // The sandbox's own success shape is "exited (code 0)"; anything else — a non-zero exit or a
  // "failed to report an exit" — is what the reader is scanning for.
  return t.status === "exited (code 0)" ? "var(--success)" : "var(--danger)";
}

export function ProcessCard({
  jobId,
  root,
  testId = "process-card",
}: {
  jobId: string;
  root: string;
  testId?: string;
}) {
  const [tail, setTail] = useState<JobTail | null>(null);
  // Set when the job is known gone (evicted, app restarted, unparseable answer) — polling stops
  // and the card renders nothing from then on.
  const [gone, setGone] = useState(false);
  // Between the click and the next poll's confirmation. Kept separate from the poll state so a
  // bridge failure during the kill doesn't strand the button in a lie — it just comes back.
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    setStopping(true);
    try {
      await killProcess(root, jobId);
      // The poll decides what the card shows next: the sandbox's own status line is the truth,
      // not this call's prose.
    } catch {
      // The kill itself failed to go out — return the button so it can be tried again. The poll
      // keeps running and will still close the card if the job died some other way.
      setStopping(false);
    }
  };

  useEffect(() => {
    if (!root || !jobId) return;
    let alive = true;
    let finished = false;
    const poll = async () => {
      if (finished) return;
      try {
        const res = await fetchProcessOutput(root, jobId);
        if (!alive) return;
        if (!res.ok) {
          setGone(true);
          return;
        }
        const parsed = parseProcessOutput(res.output);
        if (!parsed) {
          setGone(true);
          return;
        }
        setTail(parsed);
        if (!parsed.running) finished = true;
      } catch {
        // A transient bridge failure is not evidence the job is gone — skip this tick, the next
        // one retries. Only the sandbox's own answer decides the card's fate.
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [jobId, root]);

  if (gone || !tail) return null;
  const lines = tail.body ? tail.body.replace(/\n$/, "").split("\n") : [];
  const shown = lines.slice(-TAIL_LINES).join("\n");
  return (
    <div
      data-testid={testId}
      className="mono ml-3.5 mt-1 rounded-md border px-2 py-1.5 text-[11px]"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0" style={{ color: statusColor(tail) }}>
          ⏺
        </span>
        <span style={{ color: "var(--text-dim)" }}>
          {jobId} — {tail.status}
        </span>
        {tail.running && <span className="spinner" role="status" aria-label={`${jobId} is running`} />}
        {tail.running && (
          <button
            type="button"
            className="mono ml-auto shrink-0 rounded border px-1.5 text-[10px]"
            style={{ color: "var(--danger)", borderColor: "var(--border)", background: "var(--surface-2)" }}
            onClick={() => void stop()}
            disabled={stopping}
            data-testid="process-stop"
            aria-label={`stop ${jobId}`}
          >
            {stopping ? "stopping…" : "stop job"}
          </button>
        )}
      </div>
      {shown && (
        <pre
          className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px]"
          style={{ color: "var(--text-faint)" }}
        >
          {shown}
        </pre>
      )}
    </div>
  );
}

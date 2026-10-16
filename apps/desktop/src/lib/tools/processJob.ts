/**
 * Background-job wire formats, parsed for the UI.
 *
 * The Rust sandbox owns two strings this app's interface reads back:
 *  - what `run_command {background:true}` returns when it starts ("started background job bg-N …");
 *  - what `process_output` returns for that job (a `[status]` head line, then the tail).
 *
 * Both are model-facing prose first. The ProcessCard needs the same facts the model gets, so the
 * parsing lives in one place rather than as a regex inside a component — and the day the Rust
 * wording changes, the test here reddens instead of a card silently vanishing.
 */

/** The job id a background `run_command` minted, from its own result text. `null` for anything
 *  else — a foreground run, a refusal, an empty result — which is how the UI knows a row has no
 *  job to watch. */
export function backgroundJobIdFromResult(text: string): string | null {
  // Anchored: the marker is only a job mint when it *is* the result, not when a job's output or a
  // model's summary merely mentions one.
  const m = /^started background job (bg-\d+)/.exec(text);
  return m ? m[1]! : null;
}

export interface JobTail {
  /** The sandbox's own label: `running`, `exited (code N)`, or a failure description. */
  status: string;
  /** True while the job's process group is still alive. */
  running: boolean;
  /** Everything after the status line — stdout tail, plus a `[stderr]` section when there is one. */
  body: string;
}

/** Split a `process_output` result into its status head and output body. `null` when the text is
 *  not that shape (an error string, a future format) — the caller treats that as "nothing to
 *  show" rather than rendering a mangled card. */
export function parseProcessOutput(text: string): JobTail | null {
  const nl = text.indexOf("\n");
  const head = nl === -1 ? text : text.slice(0, nl);
  const m = /^\[status\] (.+) · elapsed [\d.]+s · job (bg-\d+)$/.exec(head);
  if (!m) return null;
  const status = m[1]!;
  return { status, running: status === "running", body: nl === -1 ? "" : text.slice(nl + 1) };
}

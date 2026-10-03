/**
 * Turning an unknown throw into something a person can read.
 *
 * A render error used to unmount the tree and leave a blank window, and a blank window cannot be
 * told apart from a dev server that is down or a page that never loaded — which is exactly why the
 * crash that took the Assistant screen down produced a white screen and no explanation. Everything
 * here is pure so `vitest` reaches it with no DOM: the boundary component is the thin part.
 */

/** Longest message kept verbatim. A thrown object can stringify to something enormous. */
export const MAX_MESSAGE_CHARS = 1200;
/** Longest stack kept. A React component stack is long and the useful frame is at the top. */
export const MAX_STACK_CHARS = 4000;
/** Longest headline. It has to sit in a heading, not wrap a paragraph. */
export const MAX_HEADLINE_CHARS = 160;

export interface CrashReport {
  /** One line, always present, safe in a heading or a `title` attribute. */
  headline: string;
  /** The thrown value's own message, clipped — or its stringified form if it was not an Error. */
  message: string;
  /** Best-effort origin: the first stack frame that names a file, when the stack has one. */
  where?: string;
  /** The JS stack, clipped, for the details block. */
  stack?: string;
  /** React's component stack, clipped. Points at the component, which the JS stack often does not. */
  componentStack?: string;
}

/**
 * Code-point safe: `slice` counts UTF-16 units, so it can cut a surrogate pair in half and leave a
 * lone surrogate in the message. `Array.from` iterates code points instead.
 */
export function clipText(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : `${points.slice(0, max).join("")}…`;
}

/** Collapse every run of whitespace, so a multi-line message can be used as a heading. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * `throw` can carry anything, including `undefined`, so this never assumes an `Error`. Each branch
 * exists because the previous one cannot describe that value: `message` covers the normal case,
 * `String` covers a string or a symbol, and `JSON.stringify` is the only way to say anything
 * useful about a plain thrown object — with `String` as the last resort, because a circular
 * structure makes `JSON.stringify` throw.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const m = oneLine(error.message);
    if (m) return m;
    // An `Error` with no message is usually a bare `new Error()`; its `name` ("Error") says nothing,
    // but a subclass's name ("TypeError", "QuotaExceededError") is the whole diagnosis.
    return error.name && error.name !== "Error" ? error.name : "Error with no message";
  }
  if (error === null) return "A null value was thrown";
  if (error === undefined) return "An undefined value was thrown";
  if (typeof error === "string") return oneLine(error) || "An empty string was thrown";
  try {
    const json = JSON.stringify(error);
    // `undefined` for a function or a symbol, and `"{}"` for a class instance with no own fields;
    // both are less informative than `String` would be, so they fall through.
    if (json && json !== "{}") return oneLine(json);
  } catch {
    /* circular — String is the fallback, not a failure */
  }
  return oneLine(String(error)) || "An unrecognised value was thrown";
}

/**
 * The first frame that names a file. The stack's first line is the message itself, so it is
 * skipped; the frames after it are usually library internals, and the first `http://…`/`file://…`
 * frame is the one closest to the app's own code.
 */
export function whereOf(stack?: string): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim();
    if (frame.startsWith("at ")) return oneLine(frame);
  }
  return undefined;
}

/**
 * The report the boundary renders. `componentStack` is passed separately because React only
 * supplies it to `componentDidCatch`, not to `getDerivedStateFromError`, so the first render of the
 * fallback has the error alone and the second adds the component.
 */
export function crashReport(error: unknown, componentStack?: string): CrashReport {
  const message = clipText(messageOf(error), MAX_MESSAGE_CHARS);
  const stack = error instanceof Error && error.stack ? clipText(error.stack, MAX_STACK_CHARS) : undefined;
  const where = whereOf(stack);
  const components = componentStack ? clipText(componentStack.trim(), MAX_STACK_CHARS) : undefined;
  return {
    headline: clipText(message, MAX_HEADLINE_CHARS),
    message,
    ...(where ? { where } : {}),
    ...(stack ? { stack } : {}),
    ...(components ? { componentStack: components } : {}),
  };
}

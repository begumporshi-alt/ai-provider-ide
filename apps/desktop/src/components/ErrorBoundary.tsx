/**
 * The one place a render crash turns into a sentence.
 *
 * React unmounts the entire tree when a render throws, and there is no way to catch that from
 * inside a function component — a class with `getDerivedStateFromError` is the only mechanism. Its
 * absence is why this app had exactly one failure mode for any render error: a blank white window,
 * indistinguishable from a dev server that is down or a page that never loaded. The crash that took
 * the Assistant screen down presented as a white screen for that reason, not because anything
 * needed to be white.
 *
 * Deliberately narrow: it catches errors *during render*, in a lifecycle, and in a constructor.
 * It cannot catch an error thrown in an event handler or an async callback — those never reach a
 * boundary, and a click handler that throws leaves the app on screen rather than blank, so the
 * honest thing is to say so here rather than pretend otherwise.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashReport, type CrashReport } from "../lib/errors/crash";

interface Props {
  children: ReactNode;
}

interface State {
  report: CrashReport | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { report: null };

  /**
   * React reads this during the render that failed, so the fallback can be painted immediately.
   * `componentStack` is not passed here — React only supplies it to `componentDidCatch` — so the
   * report is rebuilt there with the component named.
   */
  static getDerivedStateFromError(error: unknown): State {
    return { report: crashReport(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The second half of the report, and the reason the fallback re-renders: the component stack
    // points at *which* component threw, which the JS stack usually answers only as a framework
    // frame. Kept rather than logged away, because the user is the one who has to report it.
    this.setState({ report: crashReport(error, info.componentStack ?? undefined) });
  }

  render(): ReactNode {
    const { report } = this.state;
    if (!report) return this.props.children;
    return (
      <div
        data-testid="error-boundary"
        className="flex min-h-screen items-start justify-center overflow-y-auto p-6"
        style={{ background: "var(--bg)", color: "var(--text)" }}
      >
        <div
          className="w-full max-w-[720px] rounded-lg border p-4"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          role="alert"
        >
          <h1 className="text-sm font-semibold" style={{ color: "var(--danger)" }}>
            The app stopped rendering
          </h1>
          <p className="mt-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
            Nothing was sent anywhere and your data is untouched — but the screen that failed cannot
            draw itself, so the window has to be reloaded to get back to a working state.
          </p>

          {/* The message, kept selectable and on its own line: it is the part a bug report needs. */}
          <p
            data-testid="error-boundary-headline"
            className="mono mt-3 break-words rounded border px-2 py-1.5 text-[12px]"
            style={{ background: "var(--bg)", borderColor: "var(--danger)", color: "var(--text)" }}
          >
            {report.headline}
          </p>

          {report.where ? (
            <p className="mono mt-2 break-all text-[11px]" style={{ color: "var(--text-faint)" }}>
              {report.where}
            </p>
          ) : null}

          {/* Collapsed by default: the first thing a person needs is the sentence, the second is
              the option to look. `<details>` needs no state and is keyboard-reachable for free. */}
          {(report.stack || report.componentStack) ? (
            <details className="mt-3" data-testid="error-boundary-details">
              <summary className="cursor-pointer text-[12px]" style={{ color: "var(--text-dim)" }}>
                Technical detail
              </summary>
              {report.componentStack ? (
                <>
                  <p className="mt-2 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                    Component
                  </p>
                  <pre className="mono mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-[11px]"
                    style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}>
                    {report.componentStack}
                  </pre>
                </>
              ) : null}
              {report.stack ? (
                <>
                  <p className="mt-2 text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                    Stack
                  </p>
                  <pre className="mono mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-[11px]"
                    style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}>
                    {report.stack}
                  </pre>
                </>
              ) : null}
            </details>
          ) : null}

          <button
            data-testid="error-boundary-reload"
            onClick={() => window.location.reload()}
            className="mt-3 rounded px-2.5 py-1 text-[12px] transition-opacity hover:opacity-85"
            style={{ background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--bg)", fontWeight: 600 }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

/**
 * UrlPreview — the URL half of the artifact story.
 *
 * A URL the model names is only previewable if the host will fetch it. `core/egress.rs::check_url`
 * permits `is_local(host) || allowlist`, so a dev server on localhost can be pulled in and shown,
 * while an arbitrary remote page CANNOT — the egress policy refuses it, and widening that policy
 * to make a preview work would trade a real boundary for a cosmetic one. For anything else the
 * card offers the one honest action: open it in the user's browser.
 *
 * The fetch goes through the host (`fetchUrlText`, no secret attached), never the renderer:
 * `connect-src 'self'` would refuse it, which is exactly why the host does the fetching.
 *
 * Only localhost gets a card, and the caller enforces that (`findLocalhostUrls`). A remote URL is
 * not previewable by policy, so a card for one would be a box whose only content is an apology —
 * a link the model names is already clickable, and a click now opens the browser (see `Markdown`).
 */
import { useCallback, useEffect, useState } from "react";
import { fetchUrlText, openExternal } from "../ipc-client";
import { isLocalhostUrl } from "../lib/chat/artifacts";
import { HtmlPreview } from "./HtmlPreview";

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** A real page — the frame renders it. */
  | { state: "page"; html: string }
  /** Something that is not a page (a JSON health probe, plain text) — shown as text, because a
   *  frame would render an unformatted blob nobody can read. */
  | { state: "text"; text: string };

/** A response is a page when it looks like one; anything else is shown as text. */
function looksLikeHtml(body: string): boolean {
  return /<!doctype|<html|<body|<div/i.test(body);
}

export function UrlPreview({ url }: { url: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const local = isLocalhostUrl(url);

  const load = useCallback(async () => {
    setLoaded({ state: "loading" });
    try {
      const res = await fetchUrlText(url);
      if (res.status < 200 || res.status >= 300) {
        setLoaded({ state: "error", message: `the server answered http ${res.status}` });
        return;
      }
      setLoaded(looksLikeHtml(res.body) ? { state: "page", html: res.body } : { state: "text", text: res.body });
    } catch (e) {
      setLoaded({ state: "error", message: String((e as Error)?.message ?? e) });
    }
  }, [url]);

  useEffect(() => {
    if (local) void load();
  }, [local, load, nonce]);

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw string */
  }

  const actions = (
    <div className="ml-auto flex items-center gap-2">
      <button
        type="button"
        className="card-icon-btn rounded px-1.5 py-0.5"
        onClick={() => setNonce((n) => n + 1)}
        title="Fetch it again"
        data-testid="url-preview-refresh"
      >
        Refresh
      </button>
      <button
        type="button"
        className="card-icon-btn rounded px-1.5 py-0.5"
        onClick={() => void openExternal(url)}
        title="Open in your browser"
        data-testid="url-preview-open"
      >
        Open
      </button>
    </div>
  );

  /*
   * A successful fetch renders THROUGH the shared frame, exactly as the artifact card does.
   *
   * The first version wrapped that frame in this component's own header and stripped the frame's
   * border to avoid a double edge — which left the card with a top-only outline, no bottom border,
   * and an iframe 1px wider than its header on each side (visual gate, 2026-10-09: "the outline
   * dies 28px down"). One component owns the frame, so there is exactly one header and one
   * complete border, and the two paths cannot drift apart again.
   */
  if (local && loaded.state === "page") {
    return (
      <div className="mt-1.5" data-testid="url-preview">
        <HtmlPreview
          code={loaded.html}
          label={host}
          subtitle={url}
          actions={actions}
        />
      </div>
    );
  }

  return (
    <div className="mt-1.5" data-testid="url-preview">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-md border border-b-0 px-3 py-1.5 text-[11px]"
        style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
      >
        <span className="mono break-all" style={{ color: "var(--text)" }} data-testid="url-preview-url">
          {url}
        </span>
        {actions}
      </div>
      <div
        className="rounded-b-md border border-t-0"
        style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--border)" }}
      >
        {loaded.state === "loading" ? (
          <div className="px-3 py-4 text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="url-preview-loading">
            Fetching {url}…
          </div>
        ) : loaded.state === "error" ? (
          <div className="px-3 py-3 text-[11px]" style={{ color: "var(--warn)" }} data-testid="url-preview-error">
            Could not fetch it — {loaded.message}. A server that is not running yet reads exactly
            like this.
          </div>
        ) : (
          <pre
            className="mono m-0 max-h-[420px] overflow-auto px-3 py-2 text-[11px] leading-relaxed"
            style={{ background: "rgba(0,0,0,0.42)", color: "var(--text-dim)" }}
            data-testid="url-preview-text"
          >
            {loaded.state === "text" ? loaded.text.slice(0, 50_000) : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

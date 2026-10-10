/**
 * ArtifactCard — a preview of a file the agent produced, right in the transcript.
 *
 * This is the file-path half of the artifact story (the URL half is `UrlPreview`). When a run
 * writes `dashboard.html`, `report.pdf` or `logo.png`, the transcript shows the thing itself
 * instead of only a diff: a rendered page, the PDF's pages, the image.
 *
 * Loading goes through `artifactRead`, which is workspace-root confined and extension-allowlisted
 * on the host side (`core/artifact.rs`), so a card can only ever show a file inside the root the
 * user chose. Nothing here decides that; it renders what the host agreed to hand back.
 */
import { useEffect, useState, type ReactNode } from "react";
import { artifactRead, base64ToBytes, revealPath } from "../ipc-client";
import { artifactKindForPath, baseName, mediaTypeForPath } from "../lib/chat/artifacts";
import type { ArtifactVersion } from "../lib/chat/artifact-versions";
import { HtmlPreview } from "./HtmlPreview";
import { PdfViewer } from "./PdfViewer";

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** HTML: text for the frame's `srcdoc`. */
  | { state: "html"; text: string; size: number }
  /** PDF and images: raw bytes. */
  | { state: "bytes"; bytes: Uint8Array; mediaType: string; size: number };

function kindLabel(path: string): string {
  const kind = artifactKindForPath(path);
  return kind === "pdf" ? "PDF" : kind === "html" ? "HTML page" : "Image";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The version control: `‹ v2 of 3 ›` plus a way back to the live file.
 *
 * Only rendered when there is more than one version — a single-write file has no history to walk,
 * and a disabled control would be furniture. The numbers are the versions in transcript order,
 * which is the order they were written in.
 */
function VersionBar({
  selected,
  count,
  exact,
  onSelect,
}: {
  /** 0-based index into the recorded versions, or null while showing the live file. */
  selected: number | null;
  count: number;
  /** False when the selected version could not be replayed exactly (see `artifact-versions`). */
  exact: boolean;
  onSelect: (index: number | null) => void;
}) {
  const at = selected ?? count - 1;
  const historical = selected !== null;
  /**
   * Real chrome on the arrows, not bare glyphs.
   *
   * The first version rendered `‹` and `›` as 4x7px text with no box at all — measured as "stray
   * punctuation" at 1.94:1 when disabled, so a reader could not tell a control was there, let
   * alone that it was unavailable (visual gate, 2026-10-10). A 24px box with its own fill and
   * border is the standard hit target, and the DISABLED state keeps the box while dimming only the
   * glyph — which is what says "unavailable" rather than "absent".
   */
  const arrow = (dir: "prev" | "next") => {
    const disabled = dir === "prev" ? at <= 0 : at >= count - 1;
    return (
      <button
        type="button"
        className="flex items-center justify-center rounded border text-[13px] leading-none"
        style={{
          // `--text-faint` for the EDGE, not `--border-strong`: the border is the only thing that
          // says a control is here, and `--border-strong` measured 1.44:1 — below the 3:1 non-text
          // minimum, and at 1x a reviewer could not see the box at all (visual gate, 2026-10-10).
          // `--text-faint` measures 3.22:1 on the card surface.
          borderColor: "var(--text-faint)",
          background: "rgba(255, 255, 255, 0.06)",
          width: 24,
          height: 24,
          cursor: disabled ? "default" : "pointer",
        }}
        onClick={() => onSelect(dir === "prev" ? Math.max(0, at - 1) : Math.min(count - 1, at + 1))}
        disabled={disabled}
        title={dir === "prev" ? "Previous version" : "Next version"}
        data-testid={dir === "prev" ? "artifact-version-prev" : "artifact-version-next"}
      >
        {/* The GLYPH dims when there is nowhere to go; the box does not. That is what reads as
            "unavailable" rather than "absent". */}
        <span
          style={{
            color: disabled ? "var(--text-faint)" : "var(--text)",
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {dir === "prev" ? "‹" : "›"}
        </span>
      </button>
    );
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="artifact-versions">
      {/*
       * Mounted first, and always mounted. Its reserved width sits against the header's flexible
       * gap rather than between the arrows and the metadata: as the LAST element the hidden slot
       * showed up as a measured 65px hole in the middle of the control cluster, 4–13x larger than
       * every real gap there.
       */}
      <button
        type="button"
        className="rounded border px-1.5 text-[11px] leading-none"
        style={{
          visibility: historical ? "visible" : "hidden",
          borderColor: "var(--text-faint)",
          background: "rgba(255, 255, 255, 0.06)",
          color: "var(--text-dim)",
          height: 24,
        }}
        aria-hidden={!historical}
        tabIndex={historical ? 0 : -1}
        onClick={() => onSelect(null)}
        title="Back to the file as it is now"
        data-testid="artifact-version-latest"
      >
        Current
      </button>
      {arrow("prev")}
      {/* `--text-dim` in the current state, not `--text-faint`: at 3.22:1 the faint tier failed AA
          for the ONE label that says which version you are looking at. Historical stays brighter
          (`--text`), which is also the signal that you have left the live file. */}
      <span
        className="mono text-[11px]"
        style={{ color: historical ? "var(--text)" : "var(--text-dim)" }}
        data-testid="artifact-version-label"
      >
        v{at + 1} of {count}
      </span>
      {arrow("next")}
      {historical && !exact && (
        // Never hidden: the page below it may not be what the file actually held.
        <span className="text-[10px]" style={{ color: "var(--warn)" }} data-testid="artifact-version-inexact">
          reconstructed — an edit could not be replayed
        </span>
      )}
    </div>
  );
}

/** The reveal affordance, shared by both card shapes. */
function RevealButton({ path, root }: { path: string; root: string }) {
  return (
    <button
      type="button"
      className="card-icon-btn rounded px-1.5 py-0.5"
      // `revealItemInDir` is granted without a path scope, while `openPath` needs one this app
      // deliberately does not carry. Revealing is also the more useful action for an artifact:
      // seeing the page is what the preview is for, finding the file is what comes next.
      onClick={() => void revealPath(path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`)}
      title="Show this file in the file manager"
      data-testid="artifact-reveal"
    >
      Reveal
    </button>
  );
}

/** A blob URL for image bytes, revoked when the card goes away or the bytes change. */
function useImageUrl(bytes: Uint8Array | null, mediaType: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    // `img-src blob:` is allowed by the app's CSP, and a blob URL beats a data URI here: building
    // a 5 MB data URI means a second full-size string plus a base64 pass in the render path.
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, mediaType]);
  return url;
}

export function ArtifactCard({
  path,
  root,
  versions,
  testId = "artifact-card",
}: {
  /** Workspace-relative path, exactly as the change set recorded it. */
  path: string;
  /** The workspace root the path resolves inside. */
  root: string;
  /**
   * The file's version history, oldest first, reconstructed from the transcript. Empty or absent
   * for a file with a single write — the card is then exactly what it was before versioning.
   */
  versions?: ArtifactVersion[];
  testId?: string;
}) {
  const kind = artifactKindForPath(path);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  /**
   * `null` means the LIVE file — read from disk through the host, as every version of this card has
   * done. A number selects a recorded version, whose content comes from the transcript instead.
   *
   * Live and newest-recorded are usually the same bytes, and they are still different claims: the
   * live read is the file as it is NOW (the user's editor may have touched it), while a recorded
   * version is what the agent wrote. Keeping `null` as the default means the common case costs no
   * extra state and no new failure mode.
   */
  const [selected, setSelected] = useState<number | null>(null);
  const recorded = versions ?? [];
  const historical = selected === null ? null : recorded[selected] ?? null;

  useEffect(() => {
    // A recorded version needs no host read: its bytes are already in the transcript.
    if (historical) return;
    let cancelled = false;
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        if (kind === "html") {
          // Text, not bytes: the page goes straight into the frame's `srcdoc`, and decoding on
          // the host side is what keeps a page with one bad byte from failing to preview.
          const res = await artifactRead(path, root, true);
          if (!cancelled) setLoaded({ state: "html", text: res.text ?? "", size: res.bytes });
          return;
        }
        const res = await artifactRead(path, root, false);
        if (!cancelled) {
          setLoaded({ state: "bytes", bytes: base64ToBytes(res.base64), mediaType: res.media_type, size: res.bytes });
        }
      } catch (e) {
        if (!cancelled) setLoaded({ state: "error", message: String((e as Error)?.message ?? e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, root, kind, historical]);

  /**
   * What the body renders: the recorded version when one is selected, otherwise whatever the host
   * handed back. A base64 version carries bytes for a PDF or an image; a utf-8 one carries text.
   */
  const view: Loaded = historical
    ? historical.encoding === "base64"
      ? {
          state: "bytes",
          bytes: base64ToBytes(historical.content),
          mediaType: mediaTypeForPath(path) ?? "application/octet-stream",
          size: historical.bytes,
        }
      : { state: "html", text: historical.content, size: historical.bytes }
    : loaded;

  const imageUrl = useImageUrl(view.state === "bytes" && kind === "image" ? view.bytes : null,
    view.state === "bytes" ? view.mediaType : "image/png");

  if (!kind) return null;
  const name = baseName(path);
  const size = view.state === "html" || view.state === "bytes" ? formatSize(view.size) : null;

  // The HTML path hands its header to `HtmlPreview`, which already renders one (icon, label,
  // Preview/Code toggle, copy). Giving it the file name and the Reveal action means one header,
  // not this card's header stacked above the frame's — and one frame implementation for both the
  // inline-HTML and the wrote-a-file path.
  if (kind === "html" && view.state !== "error") {
    const actions: ReactNode = (
      // No `ml-auto` here: the frame's toggle group already carries one, and a second auto margin
      // split the header into two voids with the toggle stranded mid-row (visual gate). One auto
      // margin puts every control in one right-hand cluster.
      <div className="flex items-center gap-2">
        {recorded.length > 1 && (
          <VersionBar
            selected={selected}
            count={recorded.length}
            exact={historical?.exact ?? true}
            onSelect={setSelected}
          />
        )}
        {/* Kind AND size: the other cards label the file type, and a bare "203 B" beside a file
            name reads as a stray number (visual gate, 2026-10-09). `--text-dim`, not
            `--text-faint`: the faint tier measured ≈2.9:1 against the card surface. */}
        <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
          {kindLabel(path)}
          {size ? ` · ${size}` : ""}
        </span>
        <RevealButton path={path} root={root} />
      </div>
    );
    return (
      <div className="mt-1.5" data-testid={testId}>
        {view.state === "loading" ? (
          <div
            className="rounded-md border px-3 py-3 text-[11px]"
            style={{ borderColor: "var(--border-strong)", color: "var(--text-faint)" }}
            data-testid="artifact-loading"
          >
            Loading {name}…
          </div>
        ) : (
          // Only the html variant reaches here — the error case returned above — so narrowing
          // the union is a cast-free `state === "html"` check the compiler can follow.
          <HtmlPreview code={view.state === "html" ? view.text : ""} label={name} actions={actions} />
        )}
      </div>
    );
  }

  /*
   * Rendered inside the tool row, so this card is indented with the diff it belongs to and reads
   * as that call's evidence. The URL card sits at message level and is therefore ~11px wider —
   * a deliberate difference between "belongs to this tool call" and "part of the reply", not a
   * width bug (visual gate, 2026-10-09, raised it as one; aligning them would misalign this card
   * from its own diff).
   */
  return (
    <div className="mt-1.5" data-testid={testId}>
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-md border border-b-0 px-3 py-1.5 text-[11px]"
        style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)", color: "var(--text-dim)" }}
      >
        <span className="mono" style={{ color: "var(--text)" }} data-testid="artifact-name">
          {name}
        </span>
        {/* `--text-dim`: the faint tier measured ≈3.2:1 here, and this is information rather than
            decoration — it says what the file is. */}
        <span style={{ color: "var(--text-dim)" }}>
          {kindLabel(path)}
          {size ? ` · ${size}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {recorded.length > 1 && (
            <VersionBar
              selected={selected}
              count={recorded.length}
              exact={historical?.exact ?? true}
              onSelect={setSelected}
            />
          )}
          <RevealButton path={path} root={root} />
        </div>
      </div>

      {loaded.state === "loading" && (
        <div
          className="rounded-b-md border border-t-0 px-3 py-4 text-[11px]"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-faint)" }}
          data-testid="artifact-loading"
        >
          Loading {name}…
        </div>
      )}

      {loaded.state === "error" && (
        <div
          className="rounded-b-md border border-t-0 px-3 py-3 text-[11px]"
          style={{ borderColor: "var(--border-strong)", color: "var(--warn)" }}
          data-testid="artifact-error"
        >
          {name} could not be previewed — {loaded.message}
        </div>
      )}

      {view.state === "bytes" && kind === "pdf" && (
        <div
          className="overflow-hidden rounded-b-md border border-t-0"
          // `borderTopColor` is the divider tone the frame uses between its header and its body;
          // without it these two cards had no header/body line while the other two did.
          style={{ borderColor: "var(--border-strong)", borderTopColor: "var(--border)" }}
        >
          <PdfViewer data={view.bytes} />
        </div>
      )}

      {view.state === "bytes" && kind === "image" && (
        <div
          className="flex justify-center overflow-hidden rounded-b-md border p-3"
          style={{
            borderColor: "var(--border-strong)",
            // The divider: the header carries `border-b-0` (where it has one), so the body's own
            // top edge is the single line between them. Setting only the COLOUR without a width
            // drew nothing — `border-t-0` used to sit in this class list.
            borderTopColor: "var(--border)",
            background: "rgba(0,0,0,0.22)",
          }}
        >
          {imageUrl ? (
            <img
              alt={name}
              data-testid="artifact-image"
              className="rounded border"
              style={{
                borderColor: "var(--border)",
                maxHeight: 420,
                maxWidth: "100%",
                // A small bitmap at natural size is a dot — a 1x1 icon renders as a single pixel
                // and the card reads as broken/empty (visual gate, 2026-10-09). A floor keeps it
                // visible, and `pixelated` keeps the upscale honest instead of smearing it.
                minWidth: 48,
                minHeight: 48,
                imageRendering: "pixelated",
              }}
              src={imageUrl}
            />
          ) : (
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>Decoding {name}…</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * PdfViewer — renders a PDF's pages to canvases, in the chat.
 *
 * Why pdf.js: the webview cannot show a PDF natively. macOS WKWebView does not render one in an
 * iframe, the app's CSP has no `frame-src` for a remote viewer, and handing the file to the OS
 * would leave the transcript (and the app's security model) behind. PDF.js renders to a canvas,
 * which needs no CSP allowance at all.
 *
 * Verified against this app's CSP by dependency review (2026-10-09): no `eval`, no
 * `wasm-unsafe-eval`, the worker loads from an emitted same-origin asset, and if the worker
 * cannot start, pdf.js falls back to the main thread — so the strict policy costs image-decode
 * speed and ICC color management, not correctness. `useWasm: false` makes that trade explicit
 * rather than leaving blocked-wasm console noise behind.
 *
 * Static assets (`/pdfjs/{cmaps,standard_fonts,wasm,iccs}`) are staged at build time by
 * `scripts/copy-pdfjs-assets.mjs` — see that file for what each directory buys.
 */
import { useEffect, useMemo, useRef, useState } from "react";
// Type-only: erased at compile time, so importing the library's types costs no runtime load.
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/** Worker + assets, wired lazily so this module costs nothing until a PDF is actually shown. */
let pdfjs: typeof import("pdfjs-dist") | null = null;
let loadError: string | null = null;

/**
 * `Promise.withResolvers` is used unguarded by pdf.js 6.x, and it does not exist before
 * WebKit 17.4 — while this app declares macOS 11 as its floor. Without this, a PDF would fail to
 * open on an older OS for a reason no error message would explain. Defining it is a two-line
 * polyfill ahead of the library import, which is why it lives here and not in a bundler plugin.
 */
function ensureWithResolvers(): void {
  const P = Promise as unknown as { withResolvers?: () => unknown };
  if (typeof P.withResolvers === "function") return;
  P.withResolvers = function withResolvers<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (pdfjs) return pdfjs;
  if (loadError) throw new Error(loadError);
  try {
    ensureWithResolvers();
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    // A same-origin emitted asset — never a blob:/data: URL, which this CSP would refuse.
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    pdfjs = lib;
    return lib;
  } catch (e) {
    loadError = `the PDF renderer did not load: ${(e as Error).message}`;
    throw new Error(loadError);
  }
}

/**
 * pdf.js 6 refuses a canvas past its area limit (`canvasMaxAreaInBytes`), and pages are not all
 * letter-sized — a 2× render of a large drawing can cross it and fail a page that would have
 * rendered fine smaller. Shrink the scale rather than the fidelity target: clamp total pixels.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

/** A canvas per page, sized to FIT the frame — see the fit note in `PdfViewer`. */
function PdfPage({
  doc,
  pageNumber,
  width,
  height,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  /** The frame's inner height: a page scales to whichever axis runs out first. */
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        /*
         * FIT, not fill-width. Scaling only by width let a wide page overflow the frame — a
         * 200x100pt page rendered 873px wide is 436px tall in a 396px-tall box, so its bottom was
         * clipped and the sheet sat flush on the card's edge (visual gate, 2026-10-09). Taking the
         * smaller of the two scales shows the WHOLE page, which is the one thing a PDF preview
         * must do; a multi-page document then scrolls page by page.
         */
        const fit = Math.min(width / base.width, height / base.height);
        // 2× the display size on top of the fit: the canvas is a raster, and a 1× render of text
        // looks soft beside the app's own type at any device pixel ratio above 1.
        const crisp = fit * 2;
        const area = base.width * base.height * crisp * crisp;
        const scale = area > MAX_CANVAS_PIXELS ? crisp * Math.sqrt(MAX_CANVAS_PIXELS / area) : crisp;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setBox({ w: Math.round(viewport.width / 2), h: Math.round(viewport.height / 2) });
        // v6 takes the canvas itself; `canvasContext` is the deprecated spelling, and passing only
        // that is a type error against the shipped signature.
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch (e) {
        // A cancelled render throws by design (a page unmounted mid-render, or a re-layout); only
        // a real failure deserves to surface.
        if (!cancelled && !/cancel/i.test(String((e as Error)?.message ?? e))) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, width, height]);

  if (failed) {
    return (
      <div
        className="py-4 text-center text-[11px]"
        style={{ color: "var(--warn)" }}
        data-testid={`pdf-page-error-${pageNumber}`}
      >
        page {pageNumber} could not be rendered
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid={`pdf-page-${pageNumber}`}
      className="mx-auto block rounded-sm bg-white shadow-sm"
      style={box ? { width: `${box.w}px`, height: `${box.h}px` } : { width: "100%" }}
    />
  );
}

export function PdfViewer({ data, height = 420 }: { data: Uint8Array; height?: number }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // The container's real width drives the render scale, and it changes when the window or the
  // rail does — a stale width is a canvas that overflows or renders blurry.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // `clientWidth` is the box's inner width already; the 24px accounts for its px-3 padding, so a
    // page never renders wider than the space it is centred in.
    const measure = () => setWidth(Math.max(200, el.clientWidth - 24));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The LOADING TASK, not the document: in v6 `destroy` exists only on the task, and destroying
    // it tears down the document and its worker too. Holding the task (rather than reassigning to
    // the loaded proxy) is what makes the cleanup below correct — and the proxy has no destroy.
    let opened: { destroy: () => Promise<void> } | null = null;
    void (async () => {
      try {
        const lib = await loadPdfjs();
        /*
         * `data.slice()` — a per-load COPY, and the reason is a real failure rather than tidiness:
         * pdf.js TRANSFERS the buffer to its worker, which DETACHES the caller's ArrayBuffer. Hand
         * it `data` itself and the second load of those bytes dies with
         *   "Failed to execute 'postMessage' on 'Worker': An ArrayBuffer is detached and could not
         *    be cloned"
         * — which is what a remount does (React's dev double-invoke, or any later re-open of the
         * same card). The copy gives pdf.js a buffer it may own and leaves the prop reusable.
         */
        // Bytes, not a URL: `connect-src 'self'` would refuse a file:// or blob: document URL.
        const task = lib.getDocument({
          data: data.slice(),
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          // Required even with wasm off: the JS fallback decoders' location derives from it.
          wasmUrl: "/pdfjs/wasm/",
          iccUrl: "/pdfjs/iccs/",
          useWasm: false,
        });
        opened = task;
        const loaded = await task.promise;
        if (cancelled) return;
        setDoc(loaded);
        setPages(loaded.numPages);
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy().catch(() => {});
    };
  }, [data]);

  const pageNumbers = useMemo(() => Array.from({ length: pages }, (_, i) => i + 1), [pages]);

  if (error) {
    return (
      <div
        className="px-4 py-6 text-center text-[12px]"
        style={{ background: "rgba(0,0,0,0.42)", color: "var(--warn)" }}
        data-testid="pdf-error"
      >
        This PDF could not be rendered — {error}
      </div>
    );
  }

  // The frame's inner height: the scroll box's height minus its own padding. Pages fit inside it,
  // so one page is always fully visible instead of clipped at the card's edge.
  const innerHeight = height - 24;

  return (
    <div style={{ background: "rgba(0,0,0,0.42)" }} data-testid="pdf-frame">
      {/* The page count sits ABOVE the scroll area rather than inside it: inside, it scrolls away
          the moment the reader moves, and "how long is this" is the first question a PDF raises. */}
      {pages > 0 && doc && (
        <div
          className="border-b px-3 py-1 text-center text-[11px]"
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
          data-testid="pdf-pagecount"
        >
          {pages} page{pages === 1 ? "" : "s"}
        </div>
      )}
      <div
        ref={wrapRef}
        className="overflow-auto px-3 py-3"
        style={{ maxHeight: height }}
        data-testid="pdf-scroll"
      >
        {pages === 0 || !doc ? (
          <div className="py-8 text-center text-[12px]" style={{ color: "var(--text-faint)" }} data-testid="pdf-loading">
            Reading the PDF…
          </div>
        ) : (
          <div className="space-y-2">
            {pageNumbers.map((n) => (
              <PdfPage key={n} doc={doc} pageNumber={n} width={width} height={innerHeight} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

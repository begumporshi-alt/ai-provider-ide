/**
 * html-doc — finds whole HTML documents inside an assistant message.
 *
 * ZCode-quality chat rendering means a model that answers with a full HTML page gets a live,
 * sandboxed preview card, not a wall of markup in a code fence. But only *whole documents*
 * qualify: an ```html snippet that is a fragment (a button, a table body) is code and must stay
 * a highlighted code block. The line is `<!doctype html>` / `<html>` — the same one a browser
 * draws for "this is a page".
 *
 * Streaming-safe by omission: an unterminated fence is left to the markdown renderer (which
 * already paints a half-open fence as a code block), so nothing new flashes mid-stream. Once the
 * closing fence arrives the very next frame promotes the block to a preview card — one flicker,
 * the same one every streaming renderer pays when a construct completes.
 */

export interface TextPart {
  kind: "text";
  text: string;
}

export interface HtmlPart {
  kind: "html";
  /** The document source, fence stripped. */
  code: string;
}

export type RichPart = TextPart | HtmlPart;

/** A complete HTML document starts with a doctype or the `<html>` element itself. */
function isHtmlDocument(src: string): boolean {
  const head = src.trimStart().slice(0, 500);
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head);
}

const FENCE_OPEN = /^(```|~~~)\s*html\s*$/i;
const FENCE_CLOSE = /^(```|~~~)\s*$/;

/**
 * Split a message into prose runs and whole-HTML-document parts, in order.
 *
 * - A message that *is* a raw document (no fence) becomes one `html` part.
 * - A closed ```html fence whose body is a whole document becomes an `html` part; every other
 *   fence stays prose for the markdown renderer.
 * - Prose around the document is preserved verbatim, so a sentence introducing the page keeps
 *   its place above the card.
 */
export function splitHtmlDocs(src: string): RichPart[] {
  if (isHtmlDocument(src)) return [{ kind: "html", code: src.trim() }];

  const lines = src.split("\n");
  const parts: RichPart[] = [];
  let runStart = 0;
  let i = 0;

  const flushText = (end: number) => {
    const text = lines.slice(runStart, end).join("\n");
    if (text.trim()) parts.push({ kind: "text", text });
  };

  while (i < lines.length) {
    if (!FENCE_OPEN.test(lines[i].trim())) {
      i += 1;
      continue;
    }
    const openLine = i;
    let closeLine = i + 1;
    while (closeLine < lines.length && !FENCE_CLOSE.test(lines[closeLine].trim())) closeLine += 1;
    // Unterminated fence (mid-stream, or a model that forgot to close): leave it alone.
    if (closeLine >= lines.length) {
      i += 1;
      continue;
    }
    const body = lines.slice(openLine + 1, closeLine).join("\n");
    if (isHtmlDocument(body)) {
      flushText(openLine);
      parts.push({ kind: "html", code: body.trim() });
      runStart = closeLine + 1;
    }
    i = closeLine + 1;
  }
  flushText(lines.length);

  return parts;
}

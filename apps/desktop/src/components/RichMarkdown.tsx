/**
 * RichMarkdown — the chat's text renderer: markdown, plus live HTML documents.
 *
 * A thin splitter over `splitHtmlDocs`: prose runs go to the markdown renderer exactly as
 * before, and each whole HTML document the model produced becomes a sandboxed preview card.
 * Messages with no document render through the identical `Markdown` path — this wrapper must be
 * invisible for everything that is not a page.
 */
import { useMemo } from "react";
import { splitHtmlDocs } from "../lib/chat/html-doc";
import { findLocalhostUrls } from "../lib/chat/artifacts";
import { HtmlPreview } from "./HtmlPreview";
import { Markdown } from "./Markdown";
import { UrlPreview } from "./UrlPreview";

export function RichMarkdown({ source }: { source: string }) {
  const parts = useMemo(() => splitHtmlDocs(source), [source]);
  // A localhost URL the model named (a dev server it started, one it wants you to look at) gets a
  // preview under the prose. Only localhost: `findLocalhostUrls` filters with the same rule the
  // host's egress policy enforces, so a card never appears for a URL that could not be fetched.
  const urls = useMemo(() => findLocalhostUrls(source), [source]);

  const body =
    parts.length === 1 && parts[0].kind === "text" ? (
      <Markdown source={parts[0].text} />
    ) : (
      <>
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <Markdown key={i} source={p.text} />
          ) : (
            <HtmlPreview key={i} code={p.code} />
          ),
        )}
      </>
    );

  if (urls.length === 0) return body;

  return (
    <>
      {body}
      {urls.map((u) => (
        <UrlPreview key={u} url={u} />
      ))}
    </>
  );
}

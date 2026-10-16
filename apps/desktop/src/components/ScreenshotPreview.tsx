/**
 * Inline view of an image a tool call produced — the screenshot `browser_screenshot` saved, the
 * file `read_image` loaded, the picture `generate_image` drew. The path comes from the call's own
 * result (`imagePathFromResult`); the bytes load through the same read-only `read_image` sandbox
 * tool the model uses, falling back to the session image cache (`cacheName`, from the receipt's
 * `cache:` line) when the workspace copy is gone. It renders nothing until the image answers, and
 * nothing at all when neither source has it — an evicted cache keeps the row's text, not an error.
 */
import { useEffect, useState } from "react";
import { fetchWorkspaceImage } from "../lib/tools/host";

export function ScreenshotPreview({
  root,
  path,
  cacheName,
  testId = "browser-shot",
}: {
  root: string;
  path: string;
  cacheName?: string | null;
  testId?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!root || !path) return;
    let alive = true;
    void fetchWorkspaceImage(root, path, cacheName ?? undefined).then((img) => {
      if (alive && img) setSrc(`data:${img.mediaType};base64,${img.base64}`);
    });
    return () => {
      alive = false;
    };
  }, [root, path, cacheName]);

  if (!src) return null;
  return (
    <div data-testid={testId}>
      <div className="mono mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
        ⎿ {path}
      </div>
      <img
        src={src}
        alt={`workspace image ${path}`}
        className="mt-1 max-h-72 rounded border"
        style={{ borderColor: "var(--border)" }}
      />
    </div>
  );
}

/**
 * artifacts — what the transcript can PREVIEW, and what it can only hand to the browser.
 *
 * The chat shows cards for files the agent produced. Which files deserve a card is decided here,
 * once, so the transcript and the run's change set cannot disagree.
 *
 * The mirrors on the host side: `core/artifact.rs` owns the same extension allowlist and refuses
 * anything else, so a path that slips through here fails loudly rather than silently rendering
 * nothing. Keep the two lists in step — `artifacts.test.ts` pins the pairs that matter.
 */

export type ArtifactKind = "html" | "pdf" | "image";

/** The previewable extensions, mapped to the card they get. Mirrors `media_type_for` in Rust. */
const KINDS: Readonly<Record<string, ArtifactKind>> = {
  html: "html",
  htm: "html",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
};

/** The artifact card `path` gets, or null when the file is not previewable. */
export function artifactKindForPath(path: string): ArtifactKind | null {
  const name = path.trim();
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  // Lowercased because a model writes `REPORT.PDF` as readily as `report.pdf`.
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The media type for a previewable path — mirrors `media_type_for` in `core/artifact.rs`.
 *  The host's own answer is authoritative for a live read; this is for a HISTORICAL version, whose
 *  bytes come from the transcript and never touch the host. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function mediaTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** The parts of a transcript step this module needs — structural, so `UIStep` fits without a cast
 *  and nothing here depends on the screen layer. */
export interface WriteStep {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status?: string;
}

/**
 * The previewable path a step SUCCESSFULLY wrote, or null.
 *
 * One predicate for every caller — the render decision, the transcript-wide dedupe, and the version
 * history — because two copies of it would eventually disagree about what counts as a write, and
 * the symptom would be a card for a file the run never wrote, or a history missing a version.
 *
 * Three gates, each earning its place:
 *  - a result exists — an in-flight call has written nothing yet;
 *  - status is not error/denied, plus the wording check for transcript rows that carry no status,
 *    where a refusal is visible only in the result text. A refused `write_file` (plan mode, a denied
 *    approval) must never look like a successful write;
 *  - a previewable extension.
 */
export function writtenArtifactPath(step: WriteStep): string | null {
  const path = typeof step.args.path === "string" ? step.args.path : "";
  if (!path || !artifactKindForPath(path)) return null;
  if (step.name !== "write_file" && step.name !== "edit_file") return null;
  if (step.result === undefined) return null;
  if (step.status === "error" || step.status === "denied") return null;
  if (/refused|denied|PLAN MODE|not allowed|outside the workspace/i.test(step.result)) return null;
  return path;
}

/** The file name inside a workspace-relative path, for a card's title. */
export function baseName(path: string): string {
  const clean = path.trim().replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? clean : clean.slice(slash + 1);
}

/**
 * Localhost URLs — the one remote-ish case the host will actually fetch.
 *
 * `core/egress.rs::check_url` permits `is_local(host) || allowlist`, and `is_local` covers
 * localhost and 127.0.0.0/8. So a dev server's URL can be fetched and shown; anything else is a
 * destination the egress policy refuses, and the card offers the browser instead of pretending.
 */
export function isLocalhostUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The http(s) URLs in a block of prose, de-duplicated and in order of appearance.
 *
 * Trailing punctuation is trimmed: a sentence ending "see http://localhost:3000." has a URL that
 * does not include the full stop, and a fetch of `http://localhost:3000.` fails on the host.
 */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>()[\]"'`]+/gi;
  for (const m of text.match(re) ?? []) {
    const url = m.replace(/[.,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** The localhost URLs in a block of prose — what the URL preview card will offer. */
export function findLocalhostUrls(text: string): string[] {
  return findUrls(text).filter(isLocalhostUrl);
}

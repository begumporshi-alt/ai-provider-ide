/**
 * Relative time for listings ("2h ago"), shared by the Sources screen and the Assistant's
 * source-session picker. One implementation so the two surfaces cannot disagree about what
 * "recent" means.
 *
 * The exact timestamp stays available to callers as a `title`/tooltip; this is the glance value.
 */
export function timeAgo(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown time";
  // A clock-skewed store can carry a future mtime; "in 3m" helps nobody, and "just now" is the
  // honest reading of a timestamp the app cannot place.
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  const date = new Date(ts);
  return date.getFullYear() === new Date(now).getFullYear()
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/** The full timestamp for a `title`: the relative label is the glance, this is the record. */
export function exactTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown time";
  return new Date(ts).toLocaleString();
}

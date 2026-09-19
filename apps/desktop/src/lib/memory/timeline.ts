/**
 * Timeline helpers for the Memory screen.
 *
 * Kept out of the screen file on purpose: vitest here runs in node with only `.ts` in its include
 * list, so anything worth a unit test cannot live in a `.tsx`.
 *
 * The screen has two modes and they want different things from time. Browsing is chronological, so
 * the date is the axis and a day header supplies it. Searching is ranked, so the ranking is the
 * axis and a relative age is what you read. Both come from here.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Coarse relative age. Precision is not the point — "3d ago" is what you read to judge recency. */
export function ago(ts: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Exact clock time in the viewer's locale, e.g. "20:24". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Local calendar day for a timestamp, as `YYYY-MM-DD`. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Shift by whole calendar days, so "yesterday" survives a DST boundary. */
function shiftDays(ts: number, delta: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + delta);
  return d.getTime();
}

/** "Today" / "Yesterday" / a dated label. Relative where that reads better, dated where it does not. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(shiftDays(now, -1))) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Group items into local-day buckets, in first-seen order.
 *
 * Deliberately does not sort. The incoming order carries the ranking, and a timeline that
 * re-ordered its own rows would silently contradict the list it was handed.
 */
export function groupByDay<T>(
  items: T[],
  tsOf: (item: T) => number,
  now: number = Date.now(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const ts = tsOf(item);
    const key = dayKey(ts);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabel(ts, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** Range chips, in days. `0` is unbounded. */
export const RANGES: { days: number; label: string }[] = [
  { days: 0, label: "all" },
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
];

/** Cut-off timestamp for a range chip. `0` means everything, which is what `>= 0` naturally gives. */
export function since(days: number, now: number = Date.now()): number {
  return days <= 0 ? 0 : now - days * DAY;
}

/** One day, for callers that need to describe a range. */
export { DAY as ONE_DAY, MINUTE as ONE_MINUTE };

import { useTrailHealth, type TrailId } from "../lib/trail-health";

/**
 * A trail is incomplete, and the surface that claims it is complete has to say so.
 *
 * Rendered from the shared channel rather than from anything the screen read, because a write that
 * failed leaves no trace in the table — a read cannot detect a row that was never written. This is the
 * only signal that one is missing, and without it a card saying "every adapter the assistant wrote"
 * claims a completeness it has no way to know it has.
 *
 * Takes a `trail` rather than reading one global count: the generation-audit card must not announce a
 * lost drift write, nor the reverse. A surface may only make claims about its own table.
 *
 * **Takes the noun too**, because the right word is the *screen's*, not this component's. The provider
 * cards lose **rows**; the run history loses **writes** — a run, or a step of one — and hardcoding
 * "rows" would make the Agents warning say something false about which thing went missing. The last
 * failure's own words are what disambiguate, since the count cannot.
 */
export function TrailWriteWarning({
  trail,
  noun = "row",
  nounPlural = "rows",
}: {
  trail: TrailId;
  noun?: string;
  nounPlural?: string;
}) {
  const count = useTrailHealth((s) => s.counts[trail]);
  const last = useTrailHealth((s) => s.lastMessage[trail]);
  if (count === 0) return null;
  return (
    <div
      className="mb-2 rounded border px-3 py-2 text-[12px]"
      style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
    >
      {count} {count === 1 ? noun : nounPlural} could not be recorded — this history is incomplete.
      {/* The host's own words, so a locked database is distinguishable from a full disk. */}
      {last !== null && <span style={{ color: "var(--text-faint)" }}> Last failure: {last}</span>}
    </div>
  );
}

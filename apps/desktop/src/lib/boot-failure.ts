/**
 * What the boot-failure screen should advise, given the failure it actually hit.
 *
 * **Why this is a function and not a sentence.** The screen used to append one unconditional line:
 * *"If the database is corrupt, restore from the newest dated backup (§4)"*. That is the most
 * destructive remedy the app can offer, and it was offered for **every** cause — including a `429`
 * from the gateway's own brute-force backoff, which clears by itself in about half a minute. An
 * operator who followed it would restore a backup and lose data in order to "fix" a transient rate
 * limit. The advice has to be chosen from the error, not asserted over it.
 *
 * The error text is the shape `fetchAdmin` throws — `` `${method} ${path} → ${status}: ${body}` `` —
 * so the status is what is matched on, and the fallback is deliberately *hedged* rather than
 * confident: when nothing is recognised, the honest thing is to point at the error and make the
 * backup advice conditional, because that advice is only correct for one of the causes.
 */
export function bootFailureHint(error: string): string {
  if (/→ 429\b/.test(error)) {
    return "The gateway is rate-limiting repeated failed requests. That clears by itself within about half a minute — reload the window rather than restoring anything.";
  }
  if (/→ 401\b/.test(error)) {
    return "The gateway refused the app's own credential. Reloading the window mints a fresh one.";
  }
  if (/→ 5\d\d\b/.test(error)) {
    return "The gateway answered with a server error. Its log sits next to the database file.";
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|TypeError/i.test(error)) {
    return "The gateway did not answer on its port. Check that it is running before changing any data.";
  }
  return "If the app cannot open its own store, restore from the newest dated backup (§4) — backups live next to the database file. The error above is the only thing the host reported, so read it first.";
}

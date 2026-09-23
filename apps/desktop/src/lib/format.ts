/**
 * Presentation helpers shared across screens.
 *
 * These live in one place for the same reason the DTOs do: a value rendered two ways is two
 * sources of truth. The spend figures on Control (the global cap) and on Local Gateway (each
 * app's budget) are the *same* number in the same unit, so they have to be formatted by the same
 * function — otherwise raising the cap in one place and reading it in the other would show two
 * different dollar amounts for one micro-USD value, and the operator would have no way to tell
 * which was lying.
 */

/**
 * Micro-USD to a display string.
 *
 * The precision is deliberately asymmetric. Sub-cent amounts are common here — a single routed
 * request can cost a few micro-USD — and rounding those to two decimals would render a real,
 * non-zero spend as `$0.00`, which reads as "nothing was spent" rather than "very little was".
 * Above a cent, cents are what the operator is comparing against a cap.
 */
export function usd(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: micros < 10_000 ? 4 : 2,
  });
}

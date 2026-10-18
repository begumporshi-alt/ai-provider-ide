/**
 * FNV-1a, 32 bits, rendered base36. The one property everything that calls this needs is
 * **determinism across processes**: an id derived from content — a builtin configuration, a
 * recurring finding — is only sound if the same content produces the same id in every process and
 * on every day, which rules out anything seeded or randomized. Cryptographic strength is not
 * required; these ids name things, they do not guard them.
 */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

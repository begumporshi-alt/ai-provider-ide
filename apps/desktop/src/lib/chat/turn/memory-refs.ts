/**
 * The recall record a message carries — a leaf module so both the store (resume) and the turn
 * engine can use it without either pulling the other's world in.
 */
export interface RecalledMemory {
  id: string;
  layer: string;
  text: string;
  /** When the memory was learned — `created_at` on the store row. */
  at: number;
  pinned: boolean;
}

/** Strip a store `Memory` (or anything with the same core fields) to what a message carries. */
export function recalledLight(
  memories: readonly { id: string; layer: string; text: string; created_at: number; pinned: boolean }[],
): RecalledMemory[] {
  return memories.map((m) => ({
    id: m.id,
    layer: m.layer,
    text: m.text,
    at: m.created_at,
    pinned: m.pinned,
  }));
}

/**
 * Read the `memory_refs` column back. A row from before the column existed, or one whose JSON a
 * future build changed the shape of, yields nothing — a card that fails to appear is honest,
 * whereas a crash on resume would take the whole conversation down with it.
 */
export function parseRecalledMemoryRefs(json: string | null | undefined): RecalledMemory[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (v): v is RecalledMemory =>
      !!v && typeof v === "object"
      && typeof (v as RecalledMemory).id === "string"
      && typeof (v as RecalledMemory).text === "string",
  );
}

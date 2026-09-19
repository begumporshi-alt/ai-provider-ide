/**
 * Memory engine — the L0→L3 pipeline, webview side.
 *
 * The split is deliberate: the host stores and ranks (BM25/FTS5, no embedding model), and the
 * webview distils, because distillation needs a model and the webview is what owns the gateway
 * client. Putting extraction in Rust would mean duplicating provider selection, key handling
 * and fallback just to make one call.
 *
 * Layering is the whole point. Recall reads the abstract layers first — they are small, cheap
 * and already distilled — and only then falls back to L1/L0 when the question is about
 * specifics. A flat store has to guess how much to hand back; this one does not.
 */
import {
  captureMemories,
  captureMemory,
  listMemories,
  recallMemories,
  sessionMemories,
  updateMemory,
  type Memory,
  type MemoryLayer,
} from "../../store";
import { activeSession } from "../context/recorder";

/** Atoms are facts, not paragraphs. Anything longer is prose that escaped the extractor. */
export const MAX_ATOM_CHARS = 200;
/** One exchange rarely yields more than a handful of durable facts. */
export const MAX_ATOMS_PER_TURN = 8;
/** Character budget for the injected block. Unbounded recall would eat the prompt. */
export const DEFAULT_CONTEXT_BUDGET = 1200;

export type Generator = (model: string, prompt: string) => Promise<string>;

const DISTIL_PROMPT = `You distill durable memory from a single conversation exchange.

Rules:
- Return ONLY a JSON array of strings. No prose, no code fence, no commentary.
- Each string is one self-contained fact, preference, constraint, or decision that would still
  be true and useful in a later conversation.
- Each string under ${MAX_ATOM_CHARS} characters.
- Exclude: greetings, filler, restatements of the question, transient state, and anything that
  only made sense in this one exchange.
- If nothing durable was said, return [].

Exchange:
`;

/**
 * Distillation batch size.
 *
 * Distilling after every single exchange costs one extra model call per turn — double the
 * requests, double the tokens, and a second line in the activity ledger for every message the
 * user sends. The reference design runs an async pipeline, not a call per request. So turns are
 * accumulated and distilled in batches: a third of the cost, and three turns of context make
 * better atoms than one does.
 */
export const DISTIL_EVERY = 3;
/**
 * Scenarios are derived less often than atoms. A session that has produced six new atoms since
 * the last scenario pass gets condensed into L2 blocks — fewer passes means a single batch is
 * meaningful, and L2 stays small enough that "abstract first" recall is cheap.
 */
export const SCENARIO_EVERY = 6;
/** One scenario pass yields at most this many L2 rows. Bound the prompt. */
const MAX_SCENARIOS_PER_PASS = 3;

/** The exchanges awaiting distillation, oldest first, capped at one batch. */
const pending: { user: string; assistant: string }[] = [];
let sinceDistil = 0;

/** Test seam: forget the accumulated window and the scenario-pass marker. */
export function resetDistillation(): void {
  pending.length = 0;
  sinceDistil = 0;
  lastScenarioAt.clear();
}

/**
 * Last scenario pass per session: the number of L1 atoms that pass had already consumed, so
 * `current - recorded` is the size of the new window. Map (not plain object) so sessions are
 * GC'd naturally when no one is listening.
 */
const lastScenarioAt: Map<string, number> = new Map();

/**
 * Record the raw exchange. L0 is the layer everything else is derived from, so it is written
 * synchronously with the turn — losing it means the atom derived from it can never be checked
 * against what was actually said.
 *
 * Best-effort: a memory write must never fail a chat.
 */
export async function rememberTurn(
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  pending.push({ user: userText, assistant: assistantText });
  if (pending.length > DISTIL_EVERY) pending.splice(0, pending.length - DISTIL_EVERY);
  // A turn is the batching unit, so the counter advances here rather than in distilTurn — which
  // is called once per turn in practice but should not have to be for batching to be correct.
  sinceDistil += 1;
  try {
    await captureMemories([
      { layer: "L0", text: userText, sessionId, subject: "user" },
      { layer: "L0", text: assistantText, sessionId, subject: "assistant" },
    ]);
  } catch {
    // Intentionally swallowed — see the note above.
  }
}

/**
 * Pull the JSON array out of a model reply that may have ignored the "no prose" instruction.
 * Returns [] rather than throwing, because a turn that fails to distil is not a failure of the
 * turn — it just means nothing new was learned.
 */
export function parseAtoms(reply: string): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => (v.length > MAX_ATOM_CHARS ? `${v.slice(0, MAX_ATOM_CHARS - 1)}…` : v))
    .slice(0, MAX_ATOMS_PER_TURN);
}

/**
 * Distil the accumulated exchanges into L1 atoms and store them.
 *
 * Returns [] without calling out unless a full batch has accumulated — see DISTIL_EVERY. The
 * caller is expected not to await this in the request path: distillation runs after the answer
 * is already on screen, and a slow, misconfigured or offline model must not change what the
 * user sees.
 */
export async function distilTurn(
  sessionId: string,
  model: string,
  generate?: Generator,
): Promise<string[]> {
  // No model means distillation can never run; returning without touching the counter keeps a
  // later turn — once a model is configured — from having to wait another full batch.
  if (!model || pending.length === 0) return [];
  if (sinceDistil < DISTIL_EVERY) return [];

  const script = pending
    .slice(-DISTIL_EVERY)
    .map((t) => `User: ${t.user}\n\nAssistant: ${t.assistant}`)
    .join("\n\n---\n\n");
  try {
    const reply = await (generate ?? defaultGenerator)(model, `${DISTIL_PROMPT}${script}`);
    const atoms = parseAtoms(reply);
    // An empty result is a successful look that found nothing durable, so the window is dropped
    // either way — otherwise a model that never returns JSON would be re-asked forever.
    pending.length = 0;
    sinceDistil = 0;
    if (atoms.length === 0) return [];
    await captureMemories(
      atoms.map((text) => ({ layer: "L1" as MemoryLayer, text, sessionId })),
    );
    // Scenarios ride along with the atoms that produced them — fire-and-forget, so a slow or
    // failing second call never delays what the user is reading.
    void distilScenarios(sessionId, model, generate);
    return atoms;
  } catch {
    // Counter and window both survive: a transient failure retries on the next turn instead of
    // waiting another full batch, and the exchanges are not lost.
    return [];
  }
}

/** The real generator: one non-streaming call through the router, so fallback and the ledger
 *  apply exactly as they do for a user turn. */
async function defaultGenerator(model: string, prompt: string): Promise<string> {
  const { router } = await import("../../store");
  const exec = await router.generateText({ model, messages: [{ role: "user", content: prompt }] });
  let out = "";
  for await (const chunk of exec.chunks) out += chunk;
  return out;
}

const SCENARIO_PROMPT = `You condense a batch of memory atoms into scenario blocks.

A scenario is a short, durable block of related facts that hang together — one project, one
ongoing thread of work, one area of preference. Not one fact per scenario.

Rules:
- Return ONLY a JSON array of objects: [{"subject": "<2-4 words>", "text": "<block>"}].
- No prose, no code fence, no commentary.
- Up to ${MAX_SCENARIOS_PER_PASS} scenarios per pass.
- Each "subject" is the shortest useful label.
- Each "text" is a self-contained paragraph under 400 characters.
- Drop atoms that are trivial or one-off — only group durable ones into scenarios.
- If nothing groups, return [].

Atoms:
`;

/**
 * Condense the L1 atoms accumulated since the last scenario pass into L2 blocks.
 *
 * Returns the number of L2 rows written. A pass fires only after `SCENARIO_EVERY` new atoms
 * have piled up for one session, so a chat that yields one atom every few turns costs nothing
 * here for a while. On failure the marker rolls back, so the next pass retries the same atoms
 * instead of silently losing them.
 */
export async function distilScenarios(
  sessionId: string,
  model: string,
  generate?: Generator,
): Promise<number> {
  if (!model) return 0;
  let atoms: Memory[] = [];
  try {
    atoms = await sessionMemories(sessionId, "L1", 200);
  } catch {
    return 0;
  }
  const seen = lastScenarioAt.get(sessionId) ?? 0;
  if (atoms.length - seen < SCENARIO_EVERY) return 0;
  // Record the new cursor first so a stuck call doesn't re-queue the same atoms next time.
  lastScenarioAt.set(sessionId, atoms.length);
  const fresh = atoms.slice(seen);
  const script = fresh.map((a) => `- ${a.text}`).join("\n");
  try {
    const reply = await (generate ?? defaultGenerator)(model, `${SCENARIO_PROMPT}${script}`);
    const scenarios = parseScenarios(reply);
    if (scenarios.length === 0) return 0;
    await captureMemories(
      scenarios.map((s) => ({
        layer: "L2" as MemoryLayer,
        text: s.text,
        sessionId,
        subject: s.subject,
      })),
    );
    return scenarios.length;
  } catch {
    // Roll the cursor back so the next pass retries the same atoms.
    lastScenarioAt.set(sessionId, seen);
    return 0;
  }
}

/**
 * Same defensive parsing as parseAtoms, but for objects. Prose the model wraps around the JSON
 * is tolerated; an unbalanced response is rejected.
 */
export function parseScenarios(
  reply: string,
): { subject: string; text: string }[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is Record<string, unknown> => v && typeof v === "object")
    .map((v) => ({
      subject: String(v.subject ?? "").trim().slice(0, 80),
      text:
        String(v.text ?? "").trim().length > 400
          ? `${String(v.text).trim().slice(0, 399)}…`
          : String(v.text ?? "").trim(),
    }))
    .filter((s) => s.subject.length > 0 && s.text.length > 0)
    .slice(0, MAX_SCENARIOS_PER_PASS);
}

/**
 * Layered recall: abstract layers first, then specifics, pinned always.
 *
 * Pinned memories are prepended because pinning is the operator saying "this must never be
 * dropped", and BM25 has no notion of importance — only of relevance to this query.
 */
export async function recallContext(
  query: string,
  opts: { limit?: number; layers?: MemoryLayer[] } = {},
): Promise<Memory[]> {
  const limit = Math.max(1, opts.limit ?? 8);
  try {
    const pinned = (await listMemories(null, 50)).filter((m) => m.pinned).slice(0, 4);

    let hits: Memory[];
    if (opts.layers && opts.layers.length > 0) {
      hits = await recallMemories(query, limit, opts.layers);
    } else {
      // Half the budget is reserved for the distilled layers; whatever they do not use is
      // given to the specific ones, so neither tier can starve the other.
      const abstract = await recallMemories(query, Math.ceil(limit / 2), ["L3", "L2"]);
      const remaining = limit - abstract.length;
      const specific =
        remaining > 0 ? await recallMemories(query, remaining, ["L1", "L0"]) : [];
      hits = [...abstract, ...specific];
    }

    const seen = new Set(pinned.map((m) => m.id));
    const merged = [...pinned];
    for (const m of hits) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    return merged;
  } catch {
    return [];
  }
}

/**
 * Render recalled memories as a labeled, bounded block.
 *
 * Labeled on purpose: memory injected into a prompt without a marker is indistinguishable from
 * something the user just said, and the model will treat it as current input. Bounded because
 * recall that grows without a ceiling eventually costs more than it is worth.
 */
export function memoryBlock(memories: Memory[], budget = DEFAULT_CONTEXT_BUDGET): string {
  if (memories.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const m of memories) {
    const line = `- [${m.layer}] ${m.text}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return (
    "Context recalled from memory — treat as prior knowledge, do not ask for it again:\n"
    + lines.join("\n")
  );
}

/**
 * Put recalled memories into the context graph.
 *
 * `messageNodeId` is the message that consumed them; the edge reads message -recalled-> memory,
 * which is the direction the Context screen's provenance view expects.
 */
export function recordRecall(messageNodeId: string, memories: Memory[]): void {
  if (memories.length === 0) return;
  const rec = activeSession();
  for (const m of memories) {
    const id = rec.node("memory", m.text.slice(0, 80), { layer: m.layer, memoryId: m.id });
    rec.edge(messageNodeId, id, "recalled");
  }
}

/** Record one stored memory as a graph node, so the Memory screen and the graph agree. */
export async function captureAndRecord(
  layer: MemoryLayer,
  text: string,
  sessionId: string | null = null,
  options: { pinned?: boolean } = {},
): Promise<Memory | null> {
  try {
    const m = await captureMemory({
      layer,
      text,
      sessionId,
      pinned: options.pinned ?? false,
    });
    const rec = activeSession();
    rec.node("memory", m.text.slice(0, 80), { layer, memoryId: m.id });
    void rec.flush();
    return m;
  } catch {
    return null;
  }
}

/**
 * Add a fact to the L3 core profile. Pinned by default — the point of L3 is that it always
 * rides along in recall. Session-null so the fact outlives the conversation.
 */
export async function captureCore(text: string): Promise<Memory | null> {
  return captureAndRecord("L3", text, null, { pinned: true });
}

/** Edit the text of an existing core fact. Returns false when the id was not found. */
export async function editCore(id: string, text: string): Promise<boolean> {
  try {
    return await updateMemory(id, text);
  } catch {
    return false;
  }
}

/**
 * The one thing a send needs from AXIOM: the promoted configuration, reduced to the two fields an
 * interactive turn is allowed to change.
 *
 * Read per turn rather than cached in the screen, because a promotion has to take effect on the next
 * turn. A stale copy would mean the configuration AXIOM benchmarked is not the one the user runs —
 * which does not make "AXIOM improved the agent" wrong so much as unfalsifiable, and unfalsifiable is
 * the worse failure for a tool whose entire job is measuring.
 *
 * What is deliberately **not** here: `loop.maxIterations`. The rule from D119 (commit 7662cb3) is
 * that a step bound is justified only where nobody can press Stop, and the Assistant's user can. So
 * a version's iteration budget bounds AXIOM's own unattended eval runs — which have nobody at the
 * keyboard — and nothing else. Passing it through here would have re-imposed exactly the interactive
 * ceiling that commit deleted, from a database row instead of a constant, where it would be much
 * harder to notice.
 */
import { parsePromptPatches, type PromptPatchBlock } from "@aiprovider/axiom-core";
import { axiomActiveConfig } from "../../store";

export interface ActiveAxiomTurn {
  /** The promoted version's prompt blocks; empty when nothing is promoted. */
  patches: PromptPatchBlock[];
  /** Absent means the loop's own built-in — see `AgentLoopOptions.verificationNudgeMax`. */
  verificationNudgeMax?: number;
}

export const NO_AXIOM_TURN: ActiveAxiomTurn = { patches: [] };

export async function activeAxiomTurn(): Promise<ActiveAxiomTurn> {
  try {
    const { config } = await axiomActiveConfig();
    return {
      // Parsed, not used verbatim: `promptOverride` is a whole prompt measured against whatever base
      // the app composed at the time, and running it as-is would discard a system prompt the user has
      // edited since. The blocks are the part that was actually measured.
      patches: config.promptOverride ? parsePromptPatches(config.promptOverride) : [],
      verificationNudgeMax: config.loop.verificationNudgeMax,
    };
  } catch {
    // An older host, a failed migration, a table that is not there: the turn runs exactly as it did
    // before AXIOM existed. Refusing a user's send because a supervision layer could not be read
    // would turn the thing meant to improve the agent into a new way to break it.
    return NO_AXIOM_TURN;
  }
}

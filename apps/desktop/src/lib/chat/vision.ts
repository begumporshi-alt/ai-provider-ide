/**
 * Reading an image for a model that cannot see it.
 *
 * A screenshot attached to a text-only model is not a dead end. The app can look at the image with
 * a model that declares vision, hand the chosen model that reading as text, and answer the question
 * — which is what the user's own framing asks for: *"if I attach image in our assistant it
 * can/should still analyse it without vision power model."*
 *
 * Three deliberate properties:
 *
 *  - **Attaching is never blocked.** The picker shows which models can see (a badge, informational),
 *    and nothing refuses the file. A refusal phrased against the model reads as the app being
 *    broken, or as the model being worse than it is, when the honest position is that a second
 *    model does the looking.
 *  - **The reading is labelled on the wire.** The text model is told what it is reading and that it
 *    came from another model's reading, so it does not claim to have seen the image itself, and the
 *    user can tell what was actually observed.
 *  - **It is lossy, and that is stated, not hidden.** A description carries text, layout and visible
 *    state well; it does not carry fine detail. For a chart's exact pixels or a photo's texture, a
 *    vision model is still the right pick — which is why the badge exists.
 */

/** How the reading is framed for the model that will answer. */
export const VISION_DESCRIBE_SYSTEM =
  "You are the vision step for a model that cannot see images. Describe the image exhaustively and " +
  "literally, so the other model can answer questions about it without seeing it: transcribe every " +
  "piece of visible text verbatim (including UI labels, error messages, code, file paths and " +
  "numbers), describe the layout and what is where, name interface elements and their states, " +
  "describe diagrams and charts including their values and axes, and note colours or visual " +
  "attributes that carry meaning. Say plainly when something is unreadable or ambiguous. Do not " +
  "speculate about what the image is for beyond what is visible. Answer with the description only — " +
  "no preamble, no headings.";

/** Room for a dense screenshot's text. Generous on purpose: a truncated reading loses exactly the
 *  detail the other model was handed this job for. */
export const VISION_DESCRIBE_MAX_TOKENS = 1200;

export interface VisionCandidate {
  /** `slug/native`, the id form the picker and the wire both use. */
  id: string;
  providerId: string;
  nativeId: string;
  supportsVision?: boolean;
}

/**
 * Which model should do the looking, or `null` when nothing can.
 *
 * Order, and each step has a reason:
 *  1. **The configured default**, if its provider is enabled. An explicit choice wins even when the
 *     row does not declare vision — the same trust the app extends elsewhere to a user who knows
 *     their setup: providers publish capability metadata inconsistently, and the person who set a
 *     model as the vision helper has told us it can see.
 *  2. **The first enabled model that declares vision**, so the feature works with no configuration.
 *  3. `null` — nothing can look, and the caller must say so instead of sending an image that would
 *     be ignored or rejected upstream.
 */
export function pickVisionModel(opts: {
  /** `settings.defaults.vision`, if set. */
  preferred?: string;
  models: readonly VisionCandidate[];
  isEnabled: (providerId: string) => boolean;
}): string | null {
  const { preferred, models, isEnabled } = opts;
  if (preferred) {
    const hit = models.find((m) => (m.id === preferred || m.nativeId === preferred) && isEnabled(m.providerId));
    if (hit) return hit.id;
  }
  const declaring = models.find((m) => m.supportsVision === true && isEnabled(m.providerId));
  return declaring?.id ?? null;
}

/** One image's reading, as it is handed to the answering model. */
export interface ImageReading {
  name: string;
  description: string;
}

/**
 * The wire text for a turn whose images were read by another model.
 *
 * Delimited and attributed: the answering model must know it is reading a *reading* — otherwise it
 * will talk about "the screenshot I can see", which is a claim it cannot make and which misleads
 * whoever reads the answer. The `<image>` wrapper follows the `<memory>` / `<context>` blocks the
 * app already injects.
 */
export function imageContextBlock(readings: readonly ImageReading[], readBy: string): string {
  const body = readings
    .map((r) => `<image name="${r.name}">\n${r.description.trim()}\n</image>`)
    .join("\n\n");
  return (
    `<images read-by="${readBy}">\n` +
    `These were read for you by another model, which can see images; you cannot. Treat the ` +
    `descriptions as your only view of them, and do not claim to have seen the images themselves.\n\n` +
    `${body}\n</images>`
  );
}

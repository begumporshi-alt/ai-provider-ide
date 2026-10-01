/**
 * Content parts: reading one as text, and rendering an array of them into a dialect's own shape.
 *
 * Two jobs that look like one and are not, which is why they are separate functions here:
 *
 *   - **`textOfContent` — flatten for the router's own purposes** (token estimation, system-message
 *     hoisting, the summarizer's transcript). It must never inflate: an image part becomes a
 *     one-token marker rather than its base64, because code that measures "how big is this request"
 *     would otherwise see megabytes and compress away the conversation to make room for a picture.
 *   - **`renderContentParts` — translate for a provider** (OpenAI's `image_url`, Anthropic's
 *     `source.base64`, Gemini's `inlineData`). The shapes come from the manifest's
 *     `contentPartTemplates`, so a new dialect is a declaration rather than a branch here.
 *
 * Before this module the two concerns were tangled: `context-compress.ts` had its own flattening
 * that `JSON.stringify`-ed anything unrecognised — which was harmless only because only the gateway
 * could produce array content, and nothing measured images. `ContentPart` writes the distinction
 * down.
 */
import type { ContentPart } from "./ports.js";

/**
 * What an image counts as in a flattened transcript.
 *
 * A real image costs the model on the order of a hundred to a few thousand tokens depending on its
 * dimensions, so any single number is an approximation. The approximation here is deliberately the
 * cheap one: over-counting would push the router's compressor to drop conversation to make room for
 * a picture whose true cost is unknowable from the bytes alone.
 */
export const IMAGE_PLACEHOLDER = "<image>";

/** Does this part carry image bytes? Covers our own shape and the dialects' shapes a gateway
 *  client may forward verbatim (`image_url`, `input_image`, `inlineData`, `image`). */
function isImagePart(type: string): boolean {
  return /image|inline\s*data/i.test(type);
}

/** `JSON.stringify` that cannot throw. Content arrives from the gateway as a client's own JSON, so
 *  a cyclic or otherwise unserialisable value is possible — and a token estimate must never take the
 *  request path down. */
function measured(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  const type = typeof p.type === "string" ? p.type : "";
  if (type && isImagePart(type)) return IMAGE_PLACEHOLDER;
  // An unrecognised object part: measure it rather than reporting nothing. Reporting "" would claim
  // a message is empty, which is a worse error than a rough size for a shape we do not model.
  return measured(part);
}

/**
 * The text of a message's content, whatever shape it arrived in.
 *
 * Parts are joined with a space — the separator is arbitrary for the purposes this serves (token
 * counting, a transcript line) and a space is what the pre-existing estimator used, so token
 * estimates do not shift for the string-and-text-parts case.
 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join(" ");
  return measured(content);
}

/** A template as the manifest declares it: placeholders at any depth, rendered by `renderTemplate`. */
export type ContentPartTemplates = Record<string, Record<string, unknown>>;

/**
 * One text part in the dialect's own shape, for the string→parts wrap below.
 *
 * A dialect with no `text` template gets our internal shape, which is the pre-existing behaviour and
 * no worse than before — it is at least a shape some compatible server accepts.
 */
function renderWrappedText(
  text: string,
  templates: ContentPartTemplates | undefined,
  render: (template: Record<string, unknown>, values: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  const template = templates?.text;
  return template ? render(template, { text }) : { type: "text", text };
}

/**
 * Shape every message's content for one dialect: render part arrays, and rename the content field
 * when the dialect calls it something else (Gemini's `parts`).
 *
 * One function rather than two loops in the interpreter, because the two decisions are the same
 * decision — "what does this dialect expect where the content goes" — and splitting them is how a
 * dialect ends up with rendered parts in a field its API does not read.
 *
 * A dialect that declares nothing gets its messages back untouched: no rename, no re-render, so a
 * manifest written before this existed behaves exactly as it did.
 */
export function shapeMessageContent(
  messages: readonly unknown[],
  templates: ContentPartTemplates | undefined,
  contentField: string | undefined,
  render: (template: Record<string, unknown>, values: Record<string, unknown>) => Record<string, unknown>,
): unknown[] {
  const renames = contentField !== undefined && contentField !== "content";
  if (!templates && !renames) return [...messages];
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as Record<string, unknown>;
    let content = renderContentParts(msg.content, templates, render);
    if (!renames) return content === msg.content ? msg : { ...msg, content };
    // A dialect that names its own content field wants *parts*, always an array: a plain string
    // becomes a single text part. Without this the rename would produce `parts: "hi"`, which is a
    // shape no provider accepts — a rename without the accompanying shape change is not a mapping.
    //
    // The wrapped part goes through the dialect's **own** text template. It used to be built in our
    // internal shape (`{type:"text",text}`), which was rendered by nothing — this wrap runs after
    // `renderContentParts` — so every plain-text message to Gemini went out as
    // `parts:[{type:"text",text:"hi"}]`, carrying a `type` field its Part proto does not define.
    // Undetected because the only assertions on a Gemini body checked its length and its roles, and
    // the multimodal tests all used array content, which does take the rendering path. Found
    // 2026-10-01 while adding tool parts to the same body.
    if (typeof content === "string") {
      content = content === "" ? [] : [renderWrappedText(content, templates, render)];
    }
    const out = { ...msg, [contentField!]: content ?? [] };
    delete out.content;
    return out;
  });
}

/**
 * Render an array of parts into the dialect's wire shape, or `undefined` when there is nothing to
 * do (string content, or a manifest with no declarations).
 *
 * A manifest that declares no templates passes the parts through unchanged. That is the honest
 * failure mode for a dialect nobody has taught yet: sending our internal shape is at least
 * *something* a compatible server may accept, and silently dropping images would be a worse lie
 * than a 400 the user can see.
 */
export function renderContentParts(
  content: unknown,
  templates: ContentPartTemplates | undefined,
  render: (template: Record<string, unknown>, values: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (!Array.isArray(content)) return content;
  if (!templates) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : undefined;
    const template = type ? templates[type] : undefined;
    if (!template) return part;
    switch (type) {
      case "text":
        return render(template, { text: p.text ?? "" });
      case "image":
        return render(template, {
          mediaType: p.mediaType ?? "application/octet-stream",
          // The data-URI form is what OpenAI's `image_url.url` wants; Anthropic's and Gemini's
          // templates use the bare `dataBase64`. Both are offered so a dialect does not have to
          // concatenate strings inside a template it cannot execute.
          dataBase64: p.dataBase64 ?? "",
          dataUri: `data:${p.mediaType ?? "application/octet-stream"};base64,${p.dataBase64 ?? ""}`,
        });
      default:
        return part;
    }
  });
}

/** Build a user message's content: a plain string when there is nothing but text, else parts. */
export function userContent(text: string, images: readonly { mediaType: string; dataBase64: string }[]): string | ContentPart[] {
  if (images.length === 0) return text;
  const parts: ContentPart[] = images.map((i) => ({ type: "image" as const, mediaType: i.mediaType, dataBase64: i.dataBase64 }));
  // The text goes first: a question written above its images reads the way the user typed it.
  if (text.trim()) parts.unshift({ type: "text", text });
  return parts;
}

/** How many image parts a message carries — for the UI's "sent with N images" affordances. */
export function countImageParts(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => {
    const type = (p as { type?: unknown } | null)?.type;
    return typeof type === "string" && isImagePart(type);
  }).length;
}

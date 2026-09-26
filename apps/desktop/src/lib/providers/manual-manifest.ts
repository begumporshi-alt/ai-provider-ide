/**
 * The manifest for a provider the operator typed in by hand (Providers → the custom form).
 *
 * **Derived from the builtin template for the chosen dialect, never hand-written.** The
 * hand-written version this replaces had drifted from `openaiCompat()` in four ways at once, and
 * every one failed *silently* — measured 2026-09-26 against the live gateway with a real provider
 * (`agnes-3.0-flash`, which does return tool calls):
 *
 * 1. **No `responseMap.toolCalls`.** A tool call the model *did* make was dropped, and the client
 *    received an empty message with `finish_reason: stop`. Measured: the identical payload answered
 *    `finish_reason: tool_calls` + a real `get_weather` call from the upstream, and
 *    `finish_reason: stop` + `content: ""` through the gateway. The request side already forwarded
 *    `{{tools?}}`, so the asymmetry was invisible from the request.
 * 2. **No `stream.chunkMap.toolCalls`** — the same loss on the streaming path.
 * 3. **No `stream.toolCallStream`**, which is how the Anthropic dialect reassembles a tool call
 *    split across `content_block_start` and `input_json_delta` events.
 * 4. **Choosing `anthropic-messages-v1` only relabelled the manifest.** The paths stayed
 *    `/chat/completions` and `$.choices[0]…`, so an Anthropic provider was wired to an OpenAI
 *    shape under an Anthropic name — broken in every direction, not just tool calls.
 *
 * One cause for all four: the manifest shape lived in two places and they drifted. So this is a
 * thin overlay on the template, not a second copy of it. Anything the template gains, a manual
 * provider gains — which is exactly the property whose absence caused this.
 */
import { BUILTIN_TEMPLATES, type AdapterManifest } from "@aiprovider/router-core";

/** The two dialects the custom form offers. Mirrors the `<select>` in `Providers.tsx`. */
export type ManualDialect = "openai-chat-v1" | "anthropic-messages-v1";

export type ManualAuthChoice = "bearer" | "x-api-key" | "custom";

/** One `provider.auth.headers` entry: a header name, and the prefix its value carries. */
export type ManualAuthHeader = { name: string; prefix?: string };

/**
 * The auth header for one of the form's three choices.
 *
 * `prefix: undefined` rather than `""` for an empty prefix: an empty string would render as
 * `Authorization: <secret>` with a stray space, and the adapter distinguishes "no prefix" from
 * "prefix is blank" when it joins.
 */
export function authHeaderFor(
  auth: ManualAuthChoice,
  header: string,
  prefix: string,
): ManualAuthHeader {
  if (auth === "x-api-key") return { name: "x-api-key" };
  if (auth === "custom") return { name: header, prefix: prefix || undefined };
  return { name: "Authorization", prefix: "Bearer" };
}

/**
 * Build the manifest for a manual provider.
 *
 * `now` is injectable so a test can pin `provenance.createdAt`; production passes nothing.
 */
export function buildManualManifest(input: {
  url: string;
  dialect: ManualDialect;
  authHeader: ManualAuthHeader;
  now?: string;
}): AdapterManifest {
  const base =
    input.dialect === "anthropic-messages-v1"
      ? BUILTIN_TEMPLATES["anthropic-compat"](input.url)
      : BUILTIN_TEMPLATES["openai-compat"](input.url);

  return {
    ...base,
    // The form's own choices override the template's: the operator picked the dialect and the auth
    // scheme. Everything else — endpoints, selectors, limits, capabilities — is the template's.
    dialect: input.dialect,
    provider: { baseUrl: input.url, auth: { headers: [input.authHeader] } },
    provenance: {
      origin: "user-edited",
      generatorModel: null,
      createdAt: input.now ?? new Date().toISOString(),
    },
  };
}

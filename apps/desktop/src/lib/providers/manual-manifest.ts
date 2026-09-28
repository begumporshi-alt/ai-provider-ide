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
 * Parse the custom-headers field: one `Name: value` per line.
 *
 * Returns the problems rather than throwing, because this feeds a live form — a half-typed line is
 * the normal state of a field being filled in, not an error worth an exception.
 *
 * Blank lines and `#` comments are skipped so a block can be annotated. A line without a colon is a
 * problem: guessing a separator would silently produce a header named after the whole line.
 */
export function parseHeaderLines(text: string): { headers: Record<string, string>; problems: string[] } {
  const headers: Record<string, string> = {};
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at < 1) {
      problems.push(`"${line}" is not a "Name: value" pair`);
      continue;
    }
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!name) {
      problems.push(`"${line}" has no header name`);
      continue;
    }
    headers[name] = value;
  }
  return { headers, problems };
}

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
 * Recover the operator's custom headers from a stored manifest, as form text.
 *
 * **This is what stops an edit from silently deleting them.** `save()` rebuilds the manifest from
 * the draft and writes it when anything differs, so a form that opened with an empty headers field
 * would produce a manifest without the operator's `user-agent` — and would do it while they were
 * editing the provider's *name*. Hydrating is not a convenience here; without it the field is a
 * one-way door.
 *
 * The template's own headers are subtracted, because they are not the operator's to see or to keep:
 * showing `anthropic-version: 2023-06-01` in the box would promote a template detail into an
 * operator override, where it would then survive a future template change that should have updated
 * it.
 */
export function headersToLines(m: AdapterManifest, dialect: ManualDialect): string {
  const template =
    dialect === "anthropic-messages-v1"
      ? BUILTIN_TEMPLATES["anthropic-compat"]("https://unused.invalid")
      : BUILTIN_TEMPLATES["openai-compat"]("https://unused.invalid");
  const own = new Set(
    [
      ...Object.keys(template.endpoints.listModels?.headers ?? {}),
      ...Object.keys(template.endpoints.generateText?.headers ?? {}),
    ].map((k) => k.toLowerCase()),
  );
  const out: Record<string, string> = {};
  for (const ep of [m.endpoints.listModels, m.endpoints.generateText]) {
    for (const [k, v] of Object.entries(ep?.headers ?? {})) {
      if (!own.has(k.toLowerCase())) out[k] = v;
    }
  }
  return Object.entries(out)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Apply request headers to **every** endpoint of a manifest, without disturbing anything else.
 *
 * One implementation because two flows need it — the manual form, and auto setup answering a client
 * gate on a manifest it just fingerprinted. A second copy would be the drift this module's header
 * exists to warn about.
 *
 * **An endpoint with nothing to add is returned untouched, key and all.** Materialising an empty
 * `headers: {}` would be functionally identical but would break byte-parity with the template for
 * every provider that has no custom headers — and parity with the template is the property the
 * manual path exists to hold, so a gratuitous diff here is not cosmetic. (Caught by the
 * `leaves the manifest identical to the template` test.)
 *
 * The merge is *over* the template's own headers, not instead of them: the anthropic template
 * carries `anthropic-version`, and replacing the map would drop a header the dialect requires. The
 * template is the floor and these entries are the overlay.
 */
export function withRequestHeaders(
  m: AdapterManifest,
  headers: Record<string, string>,
): AdapterManifest {
  if (Object.keys(headers).length === 0) return m;
  const merge = <T extends { headers?: Record<string, string> }>(ep: T): T => ({
    ...ep,
    headers: { ...ep.headers, ...headers },
  });
  return {
    ...m,
    endpoints: {
      ...m.endpoints,
      ...(m.endpoints.listModels ? { listModels: merge(m.endpoints.listModels) } : {}),
      ...(m.endpoints.generateText ? { generateText: merge(m.endpoints.generateText) } : {}),
      ...(m.endpoints.generateImage ? { generateImage: merge(m.endpoints.generateImage) } : {}),
    },
  };
}

/**
 * Build the manifest for a manual provider.
 *
 * `extraHeaders` are the operator's custom request headers, and they are applied to **every**
 * endpoint rather than to text generation alone. That is the point of them: a gateway that gates on
 * a client header gates the catalogue call too, and `listModels` is the call every ping, probe and
 * catalog refresh makes — so headers that reached only `generateText` would leave the provider
 * unusable while appearing configured. Measured 2026-09-29 on `agentrouter.org`, which answers
 * `401 unauthorized_client_error` to `GET /v1/models` for any unrecognised `User-Agent`.
 *
 * `now` is injectable so a test can pin `provenance.createdAt`; production passes nothing.
 */
export function buildManualManifest(input: {
  url: string;
  dialect: ManualDialect;
  authHeader: ManualAuthHeader;
  extraHeaders?: Record<string, string>;
  now?: string;
}): AdapterManifest {
  const base =
    input.dialect === "anthropic-messages-v1"
      ? BUILTIN_TEMPLATES["anthropic-compat"](input.url)
      : BUILTIN_TEMPLATES["openai-compat"](input.url);

  const extra = input.extraHeaders ?? {};

  return {
    ...base,
    // The form's own choices override the template's: the operator picked the dialect and the auth
    // scheme. Everything else — endpoints, selectors, limits, capabilities — is the template's.
    dialect: input.dialect,
    provider: { baseUrl: input.url, auth: { headers: [input.authHeader] } },
    endpoints: withRequestHeaders(base, extra).endpoints,
    provenance: {
      origin: "user-edited",
      generatorModel: null,
      createdAt: input.now ?? new Date().toISOString(),
    },
  };
}

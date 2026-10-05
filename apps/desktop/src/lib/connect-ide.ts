/**
 * "Connect your IDE" — copy-paste config for the coding agents this gateway is built to serve.
 *
 * The panel on the Gateway screen minted-labeled per-app keys already (Per-app keys, above it);
 * what was missing was the *last mile*: the exact bytes an IDE needs. These builders are pure so
 * the snippets can be pinned by unit tests rather than eyeballed, and so the one thing that is
 * easy to get subtly wrong — which base URL each client expects — is stated once, here:
 *
 *  - OpenAI-compatible clients dial `<base>/chat/completions`, so the base carries the `/v1`
 *    (that is the gateway's `endpointUrl` verbatim).
 *  - Claude Code (and the Anthropic SDK) append `/v1/messages` to `ANTHROPIC_BASE_URL`, so that
 *    base must be the *root* — `/v1` here produced `/v1/v1/messages` (the old preset's bug).
 *  - ZCode's `openai-compatible` provider entries take the `/v1` base too, verified against a
 *    live entry in `~/.zcode/v2/config.json` (`options.baseURL` ends in `/v1`).
 *
 * Secrets never enter the webview (invariant 14), so every snippet carries a placeholder the
 * operator pastes their minted key over — the mint button puts that key on the clipboard
 * host-side, and the snippet is deliberately the second paste, not the first.
 */

/** The paste-over slot in every snippet. Starts with the real key prefix so it is recognizable. */
export const CONNECT_KEY_PLACEHOLDER = "sk-aip-PASTE-KEY-HERE";

export type ConnectTarget = "zcode" | "claude-code" | "openai";

export interface ConnectMeta {
  id: ConnectTarget;
  /** Tab label. */
  label: string;
  /** The per-app key label minted for this target — one key per app is the whole point. */
  mintLabel: string;
  /** Where the snippet goes, in one line. */
  where: string;
}

export const CONNECT_TARGETS: readonly ConnectMeta[] = [
  {
    id: "zcode",
    label: "ZCode",
    mintLabel: "zcode",
    where: "~/.zcode/v2/config.json — quit ZCode first (it rewrites the file on exit), merge the entry under \"provider\", relaunch.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    mintLabel: "claude-code",
    where: "~/.claude/settings.json under \"env\", or export the two variables in your shell; restart Claude Code.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible app",
    mintLabel: "my-app",
    where: "Any OpenAI-compatible client or SDK: set the base URL and key, pick a model id from /v1/models.",
  },
];

/**
 * The server root of a gateway endpoint URL — `http://127.0.0.1:8787/v1` → `http://127.0.0.1:8787`.
 * Anchored at the end: a bare root passes through unchanged, and nothing earlier in the URL is touched.
 */
export function rootUrl(endpoint: string): string {
  return endpoint.replace(/\/v1\/?$/, "");
}

export interface ConnectSnippetInput {
  /** The gateway's OpenAI base, `http://127.0.0.1:8787/v1`. */
  endpoint: string;
  /** A model id the router serves (qualified `provider/native` or bare). Empty → placeholder. */
  model: string;
  /** ZCode keys its provider entries by a UUID; the panel mints one so the snippet is complete. */
  providerId: string;
}

export function buildConnectSnippet(target: ConnectTarget, input: ConnectSnippetInput): string {
  const { endpoint, model } = input;
  const modelId = model.trim() === "" ? "<model-id>" : model.trim();
  switch (target) {
    case "zcode": {
      // Shape verified against a live custom-provider entry in ~/.zcode/v2/config.json:
      // top-level "provider" (singular), entry keyed by a UUID, `options.baseURL` with /v1.
      const config = {
        provider: {
          [input.providerId]: {
            name: "AI Provider Router",
            kind: "openai-compatible",
            source: "custom",
            options: {
              baseURL: endpoint,
              apiKey: CONNECT_KEY_PLACEHOLDER,
              apiKeyRequired: true,
            },
          },
        },
      };
      return [
        "// ~/.zcode/v2/config.json — merge this under the top level, then quit and relaunch ZCode",
        "// (it rewrites the file on exit; live edits are lost). Model ids come from /v1/models.",
        JSON.stringify(config, null, 2),
      ].join("\n");
    }
    case "claude-code": {
      // The root, not /v1 — Claude Code appends /v1/messages itself. AUTH_TOKEN rides the
      // Authorization: Bearer header, which the gateway accepts alongside x-api-key.
      return [
        "# Claude Code — ~/.claude/settings.json under \"env\", or export in your shell:",
        `export ANTHROPIC_BASE_URL="${rootUrl(endpoint)}"`,
        `export ANTHROPIC_AUTH_TOKEN="${CONNECT_KEY_PLACEHOLDER}"`,
        "# Pin the model to one the router serves (ids from /v1/models):",
        `# export ANTHROPIC_MODEL="${modelId}"`,
      ].join("\n");
    }
    case "openai": {
      return [
        `Base URL: ${endpoint}`,
        `API key:  ${CONNECT_KEY_PLACEHOLDER}`,
        "",
        "from openai import OpenAI",
        `client = OpenAI(base_url="${endpoint}", api_key="${CONNECT_KEY_PLACEHOLDER}")`,
        "",
        "# smoke test",
        `curl ${endpoint}/chat/completions \\`,
        `  -H "Authorization: Bearer ${CONNECT_KEY_PLACEHOLDER}" \\`,
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${modelId}","messages":[{"role":"user","content":"ping"}]}'`,
      ].join("\n");
    }
  }
}

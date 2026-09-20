/**
 * web-test/mock.mjs — DEV-ONLY, zero-dependency local mock for the browser harness.
 *
 * CORS is required because the page origin (localhost:1420) differs from the mock origin; a
 * real provider is remote anyway, so this is the honest browser path. Two providers live on
 * one server, distinguished by prefix:
 *
 *   /v1  the "oracle" — an OpenAI-compatible API that ALSO scripts AI-generator rounds:
 *        the declarative round gets deliberately-unusable JSON (all candidates fail, which is
 *        what makes the Tier-2 offer appear), the Tier-2 round gets a working code envelope.
 *   /v2  the "exotic" — genuinely unexpressible by the declarative grammar: models behind a
 *        POST with a body, chat as plain text split on newlines. Classic OpenAI/Anthropic
 *        paths 404, so the fingerprinter correctly reports "unknown".
 *
 * Ports/secrets must match web-test/seeds.ts and the Playwright spec.
 */
import { createServer } from "node:http";

const PORT = 18901;
const MOCK_ORIGIN = `http://127.0.0.1:${PORT}`;
const RAW_EXOTIC_KEY = "sk-nd-works";
/** Must match OR_ROUTER_KEY in web-test/seeds.ts. */
const RAW_OR_KEY = "sk-or-router-works";

// ---------------------------------------------------------------------------
// The Tier-2 envelope the oracle returns for the code-adapter round.
// ---------------------------------------------------------------------------

const SOURCE = [
  "export default {",
  "  async listModels(http) {",
  '    log("listing models");',
  '    const r = await http({ path: "/models/query", method: "POST", body: { select: "*" } });',
  "    const rows = JSON.parse(r.text).rows;",
  "    return rows.map((m) => m.model_name);",
  "  },",
  "  async generateText(http, emit, argsJson) {",
  "    const args = JSON.parse(argsJson);",
  '    log("chat " + args.model);',
  "    const last = args.messages[args.messages.length - 1].content;",
  '    const r = await http({ path: "/chat", method: "POST", body: { model: args.model, prompt: last } });',
  '    for (const line of r.text.split("\\n")) if (line.length > 0) emit(line);',
  "  },",
  "}",
].join("\n");

const CODE_ENVELOPE = {
  dialect: "newline-plain-v1",
  authHeader: { name: "Authorization", prefix: "Bearer" },
  capabilities: { text: true, image: false },
  source: SOURCE,
};

// ---------------------------------------------------------------------------
// State (the exotic's last protected request — wire-level truth for the spec).
// ---------------------------------------------------------------------------

let seen = { url: null, headers: {} };

/** 1×1 transparent PNG — what the image endpoint serves and what /img/tiny.png returns. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Last request that hit the image bytes endpoint — wire-level truth for the spec. */
let imgSeen = { path: null };

function cors(res, extra = {}) {
  // Authorization must be named explicitly: the "*" wildcard never matches it
  // (Fetch spec), and a preflight that never resolves hangs the whole request.
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept,X-Requested-With",
    "Access-Control-Max-Age": "86400",
    ...extra,
  });
  res.end();
}

function json(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

// ---------------------------------------------------------------------------
// The oracle (/v1): OpenAI-compatible, plus scripted generator rounds.
// ---------------------------------------------------------------------------

async function oracle(req, res, path) {
  if (path === "/models" && req.method === "GET") {
    return json(res, 200, {
      object: "list",
      data: [
        { id: "oracle-mini", object: "model", owned_by: "sysai" },
        { id: "oracle-flash", object: "model", owned_by: "sysai" },
        { id: "sd-oracle-1", object: "model", owned_by: "sysai" },
      ],
    });
  }
  // The image model's endpoint returns a URL (not b64) on THIS mock's origin, which the
  // renderer must fetch back through the host's egress carve-out (CSP forbids it directly).
  if (path === "/images/generations" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!String(body.prompt ?? "").trim()) return json(res, 400, { error: "prompt required" });
    return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: `${MOCK_ORIGIN}/v1/img/tiny.png` }] });
  }
  if (path === "/img/tiny.png" && req.method === "GET") {
    imgSeen = { path: "/v1/img/tiny.png" };
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": PNG_1PX.length,
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(PNG_1PX);
  }
  if (path === "/e2e/img-seen" && req.method === "GET") return json(res, 200, imgSeen);
  if (path === "/chat/completions" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const messages = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const last = messages[messages.length - 1]?.content ?? "";
    const stream = body.stream === true;
    const tools = Array.isArray(body.tools) && body.tools.length > 0;
    const sawToolResult = messages.some((m) => m.role === "tool");

    let content;
    let toolCall;
    if (system.includes("Tier-2 code adapters")) {
      // The Tier-2 round: a fenced envelope the extractor can parse.
      content = "```json\n" + JSON.stringify(CODE_ENVELOPE, null, 2) + "\n```";
    } else if (system.includes("You write adapter manifests")) {
      // The declarative round: deliberately unusable, so every A/B/C candidate fails and the
      // Tier-2 offer appears in the UI — the honest path for a grammar-inexpressible API.
      content = "```json\n{ \"unusable\": true, \"reason\": \"the exotic API has no declarative mapping\" }\n```";
    } else if (tools && !sawToolResult && /missing/i.test(last)) {
      // Agent mode, FAILING-tool variant: read a file the shim's virtual FS does not contain.
      // The shim replies exactly as tools.rs does — `{ok:false, output:"", error:"no such file"}` —
      // so this is what proves the bridge forwards the reason instead of a blank result.
      toolCall = { name: "read_file", arguments: JSON.stringify({ path: "nope.txt" }) };
      content = "";
    } else if (tools && !sawToolResult) {
      // Agent-mode trigger: emit one tool call (list_dir ".") so the loop executes it once.
      // The interpreter accumulates deltas by index and emits on stream close.
      toolCall = { name: "list_dir", arguments: JSON.stringify({ path: "." }) };
      content = "";
    } else {
      content = tools && sawToolResult
        ? "Done. Here is what I found in the workspace."
        : `Hello from ${body.model ?? "oracle"}`;
    }

    if (!stream) {
      return json(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "oracle-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(toolCall ? {
              tool_calls: [{
                id: "call_mock_1",
                type: "function",
                function: { name: toolCall.name, arguments: toolCall.arguments },
              }],
            } : {}),
          },
          finish_reason: toolCall ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    if (toolCall) {
      // OpenAI streaming shape: one chunk declaring the call (id + name + empty args),
      // then a chunk with arguments delta, then finish_reason "tool_calls", then [DONE].
      // The interpreter's collectToolCallDeltas accumulates id/name/args by index and the
      // pending buffer is flushed once the stream ends.
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call_mock_1", type: "function",
          function: { name: toolCall.name, arguments: "" },
        }] } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          function: { arguments: toolCall.arguments },
        }] } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else {
      const words = content.split(" ");
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + " " } }] })}\n\n`);
      }
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------
// The exotic (/v2): not describable by the declarative grammar.
// ---------------------------------------------------------------------------

const EXOTIC_MODELS = { rows: [{ model_name: "nd-lite" }, { model_name: "nd-pro" }] };

async function exotic(req, res, path) {
  if (path === "/e2e/seen" && req.method === "GET") return json(res, 200, seen);
  if (path === "/models/query" || path === "/chat") {
    const auth = req.headers.authorization;
    seen = { url: req.url, headers: { ...req.headers } };
    if (auth !== `Bearer ${RAW_EXOTIC_KEY}`) return json(res, 401, { error: "unauthorized" });

    if (path === "/models/query") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body || typeof body !== "object" || !("select" in body)) return json(res, 400, { error: "bad body" });
      return json(res, 200, EXOTIC_MODELS);
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const model = body.model ?? "nd-lite";
    const prompt = String(body.prompt ?? "");
    // Plain text, newline-delimited — not JSON, not SSE. Unexpressible in the grammar.
    const text = `Hello\nfrom\n${model}\n(${prompt.slice(0, 24)})`;
    res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end(text);
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------
// The OpenRouter-shaped provider (/v3): vendor-namespaced ids whose image capability is
// stated ONLY in architecture.output_modalities. This is the regression fixture for the
// 2026-09-16 modality amendment — an id-pattern rule matches ZERO of these ids, and
// openrouter/auto must stay a TEXT model despite also listing "image". Image generation is
// served from /images (OpenRouter's own Image API), not /images/generations.
// ---------------------------------------------------------------------------

const OR_MODELS = {
  data: [
    { id: "openai/gpt-5-image", architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } },
    { id: "google/gemini-2.5-flash-image", architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] } },
    // Dual-modality router: PRIMARY output is text, so it must NOT appear in the Image tab.
    { id: "openrouter/auto", architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } },
    { id: "openai/gpt-4o", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
  ],
};

async function orRouter(req, res, path) {
  if (path === "/models" && req.method === "GET") {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${RAW_OR_KEY}`) return json(res, 401, { error: { message: "No auth credentials found" } });
    return json(res, 200, OR_MODELS);
  }
  if (path === "/images" && req.method === "POST") {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${RAW_OR_KEY}`) return json(res, 401, { error: { message: "No auth credentials found" } });
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!String(body.prompt ?? "").trim()) return json(res, 400, { error: { message: "prompt required" } });
    // OpenRouter's real shape: stateful base64, media_type, no url field.
    return json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: PNG_1PX.toString("base64"), media_type: "image/png" }],
      usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
    });
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return cors(res);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname.replace(/^\/(v1|v2|v3)/, "");
    if (req.url.startsWith("/v1/")) return await oracle(req, res, path);
    if (req.url.startsWith("/v2/")) return await exotic(req, res, path);
    if (req.url.startsWith("/v3/")) return await orRouter(req, res, path);
    return notFound(res);
  } catch (e) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`web-test mock listening on http://127.0.0.1:${PORT} (CORS: any origin)`);
});

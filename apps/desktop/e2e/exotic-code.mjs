/**
 * Tier-2 live-test pair (plain node, zero deps):
 *
 *  - oracle AI :18797 — an OpenAI-compatible chat endpoint whose completion IS the Tier-2
 *    envelope { dialect, authHeader, capabilities, source }. The "intelligence" is scripted
 *    so the whole stack (router AI route, exclusion rule, four-gate review, QuickJS sandbox)
 *    runs for real while costing nothing.
 *
 *  - exotic provider :18798 — a surface the DECLARATIVE grammar cannot express, so the
 *    wizard's only honest option is Tier 2:
 *      * model list behind POST /models/query returning {rows:[{model_name}]} (a POST with a
 *        body — the grammar's listModels is GET with query params only);
 *      * chat at POST /chat answering text/plain newline-delimited chunks — not JSON (no
 *        jsonPath can read it) and not SSE (no event framing to map a delta from).
 *    Only an imperative adapter can translate that, which is exactly what Tier 2 is for.
 *
 *  - GET /e2e/seen — a test-only endpoint exposing the headers that actually reached the
 *    wire on the last protected request, so the E2E can prove the credential the guest never
 *    saw was the one the host injected (and that a guest-set auth header was dropped).
 */
import http from "node:http";

const ORACLE_PORT = Number(process.env.ORACLE_PORT ?? 18797);
const EXOTIC_PORT = Number(process.env.EXOTIC_PORT ?? 18798);
const EXOTIC_BASE = `http://127.0.0.1:${EXOTIC_PORT}/v2`;
const SECRET = "sk-nd-works";

// The module the oracle "writes". Relative paths only, no auth headers (it knows the host
// injects them), no banned constructs, plain string emits.
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

const ENVELOPE = JSON.stringify({
  dialect: "newline-plain-v1",
  authHeader: { name: "Authorization", prefix: "Bearer" },
  capabilities: { text: true, image: false },
  source: SOURCE,
});

// oracle AI (18797)
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url === "/v1/models" || url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "oracle-chat" }] }));
        return;
      }
      if (url === "/v1/chat/completions") {
        const content = "```json\n" + ENVELOPE + "\n```"; // fences also exercise extractJson
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 90, completion_tokens: 120 },
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no route" }));
    });
  })
  .listen(ORACLE_PORT, "127.0.0.1", () => console.log(`oracle AI on :${ORACLE_PORT}/v1`));

// exotic provider (18798)
let seen = { url: null, headers: {} };
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const auth = req.headers.authorization ?? "";

      // Test-only introspection: the wire-level truth about the last protected request.
      if (url === "/v2/e2e/seen" || url === "/e2e/seen") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(seen));
        return;
      }

      const protectedRoute = url.includes("/models/query") || url.includes("/chat");
      if (protectedRoute) {
        seen = { url, headers: { ...req.headers } };
        if (auth !== `Bearer ${SECRET}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
      }

      if (url === "/v2/models/query" || url === "/models/query") {
        // POST with a body — the declarative grammar has no listModels POST.
        let select = "";
        try {
          select = JSON.parse(body).select ?? "";
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            rows:
              select === "*"
                ? [{ model_name: "nd-lite" }, { model_name: "nd-pro" }]
                : [{ model_name: "nd-lite" }],
          }),
        );
        return;
      }

      if (url === "/v2/chat" || url === "/chat") {
        // text/plain, newline-delimited — not JSON, not SSE. No declarative map can read this.
        let model = "nd-lite";
        try {
          model = JSON.parse(body).model ?? model;
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`Hello\nfrom\n${model}`);
        return;
      }

      // classic OpenAI/Anthropic paths deliberately absent -> the fingerprinter must miss
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route ${url}` }));
    });
  })
  .listen(EXOTIC_PORT, "127.0.0.1", () => console.log(`exotic provider on :${EXOTIC_PORT}/v2`));

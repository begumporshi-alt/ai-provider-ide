/**
 * Phase 4 live-test pair (plain node, zero deps):
 *  - exotic provider :18789 — deliberately NOT OpenAI/Anthropic shaped: model list under
 *    {items:[{name}]}, chat at /completions-v2 with an envelope of {text}. The fingerprinter
 *    must return `unknown` so the wizard falls to the AI path.
 *  - oracle AI       :18788 — an OpenAI-compatible chat endpoint whose "model" is scripted:
 *    every completion returns the JSON manifest that adapts the exotic provider. This is the
 *    System AI for the test, keeping the full stack (router AI route + gates + UI + enable)
 *    real while the "intelligence" is deterministic and free.
 */
import http from "node:http";

// Ports are env-overridable so several oracle pairs can coexist in one test run.
const ORACLE_PORT = Number(process.env.ORACLE_PORT ?? 18788);
const EXOTIC_PORT = Number(process.env.EXOTIC_PORT ?? 18789);
// The manifest must point at the exotic provider's own port, whatever it is.
const EXOTIC_BASE = `http://127.0.0.1:${EXOTIC_PORT}/v2`;

const MANIFEST = JSON.stringify({
  manifestVersion: 1,
  dialect: "exotic-v2",
  provider: { baseUrl: EXOTIC_BASE, auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] } },
  endpoints: {
    listModels: { method: "GET", path: "/models", map: { models: "$.items[*].name", raw: "$.items[*]" } },
    generateText: {
      method: "POST",
      path: "/completions-v2",
      requestTemplate: { model: "{{model}}", messages: "{{messages}}", stream: "{{stream}}", max_tokens: "{{maxTokens?}}" },
      responseMap: { text: "$.text", usage: "$.usage" },
      stream: { protocol: "sse", chunkMap: { delta: "$.text" }, errorMap: { "$.err": "PASS_THROUGH" } },
    },
  },
  capabilities: { text: true, image: false },
  provenance: { origin: "ai-generated", generatorModel: null, createdAt: "2026-09-16T00:00:00Z" },
});

// oracle AI (18788)
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
        let stream = false;
        try {
          stream = JSON.parse(body).stream === true;
        } catch {
          /* ignore */
        }
        const content = "```json\n" + MANIFEST + "\n```"; // fences also exercise extractJson
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 100, completion_tokens: 150 } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no route" }));
    });
  })
  .listen(ORACLE_PORT, "127.0.0.1", () => console.log(`oracle AI on :${ORACLE_PORT}/v1`));

// exotic provider (18789)
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const deny = auth !== "sk-exotic-works" && (url.includes("completions") || url === "/v2/models");
      if (url === "/v2/models" || url === "/models") {
        if (deny) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ name: "ex-lite" }, { name: "ex-pro" }] }));
        return;
      }
      if (url === "/v2/completions-v2" || url === "/completions-v2") {
        let model = "ex-lite";
        let wantStream = false;
        try {
          const j = JSON.parse(body);
          model = j.model ?? model;
          wantStream = j.stream === true;
        } catch {
          /* ignore */
        }
        if (deny) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad key" }));
          return;
        }
        const full = `exotic answered with ${model}`;
        if (wantStream) {
          // exotic SSE framing: each event carries a full {text} line (its generated
          // adapter maps delta from $.text)
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ text: full.slice(0, 7) })}\n\n`);
          res.write(`data: ${JSON.stringify({ text: full.slice(7), done: true })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: full, usage: { in: 5, out: 7 } }));
        return;
      }
      // classic OpenAI paths deliberately absent -> fingerprint must fail
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route ${url}` }));
    });
  })
  .listen(EXOTIC_PORT, "127.0.0.1", () => console.log(`exotic provider on :${EXOTIC_PORT}/v2`));

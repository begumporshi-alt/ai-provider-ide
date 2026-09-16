/**
 * Phase 5 live-test pair (plain node):
 *  - drift provider :18790 — starts OpenAI-compatible; POST /__flip switches it to a NEW
 *    shape (models at /items {items:[{name}]}, chat at /chat2 with {text} framing, SSE
 *    chunk text under $.t). GET /__state reports the mode.
 *  - oracle AI :18788 — completions endpoint whose scripted answer is the manifest that
 *    fits the FLIPPED shape (auth via Bearer, any key).
 */
import http from "node:http";

let flipped = false;

const FLIP_MANIFEST = JSON.stringify({
  manifestVersion: 1,
  dialect: "drifted-v2",
  provider: { baseUrl: "http://127.0.0.1:18790/v1", auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] } },
  endpoints: {
    listModels: { method: "GET", path: "/items", map: { models: "$.items[*].name" } },
    generateText: {
      method: "POST",
      path: "/chat2",
      requestTemplate: { model: "{{model}}", messages: "{{messages}}", stream: "{{stream}}", max_tokens: "{{maxTokens?}}" },
      responseMap: { text: "$.text" },
      stream: { protocol: "sse", chunkMap: { delta: "$.t" } },
    },
  },
  capabilities: { text: true, image: false },
  provenance: { origin: "ai-generated", generatorModel: null, createdAt: "x" },
});

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      const json = (code, v) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (url === "/__flip") {
        flipped = true;
        return json(200, { flipped });
      }
      if (url === "/__unflip") {
        flipped = false;
        return json(200, { flipped });
      }
      if (url === "/__state") return json(200, { flipped });
      const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!flipped) {
        // OpenAI-compatible mode
        if (url === "/v1/models" || url === "/models") {
          if (auth !== "sk-drift-works") return json(401, { error: "bad key" });
          return json(200, { data: [{ id: "dgpt" }, { id: "dsecond" }] });
        }
        if (url === "/v1/chat/completions") {
          if (auth !== "sk-drift-works") return json(401, { error: "bad key" });
          let stream = false;
          try {
            stream = JSON.parse(body).stream === true;
          } catch {
            /* ignore */
          }
          const model = (() => {
            try {
              return JSON.parse(body).model ?? "dgpt";
            } catch {
              return "dgpt";
            }
          })();
          if (stream) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `drift-v1:${model}` } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            return res.end();
          }
          return json(200, { choices: [{ message: { content: `drift-v1:${model}` } }] });
        }
        return json(404, { error: `no route ${url}` });
      }
      // FLIPPED mode: everything old is gone
      if (url === "/v1/items" || url === "/items") {
        if (auth !== "sk-drift-works") return json(401, { error: "bad key" });
        return json(200, { items: [{ name: "dgpt" }, { name: "dsecond" }] });
      }
      if (url === "/v1/chat2" || url === "/chat2") {
        if (auth !== "sk-drift-works") return json(401, { error: "bad key" });
        let stream = false;
        let model = "dgpt";
        try {
          const j = JSON.parse(body);
          stream = j.stream === true;
          model = j.model ?? model;
        } catch {
          /* ignore */
        }
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ t: `drift-v2:${model}` })}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return json(200, { text: `drift-v2:${model}` });
      }
      return json(404, { error: `no route ${url}` });
    });
  })
  .listen(18790, "127.0.0.1", () => console.log("drift provider on :18790 (v1 mode; POST /__flip to drift)"));

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url === "/v1/models" || url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "oracle-chat" }] }));
      }
      if (url === "/v1/chat/completions") {
        let stream = false;
        try {
          stream = JSON.parse(body).stream === true;
        } catch {
          /* ignore */
        }
        const content = FLIP_MANIFEST;
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      }
      res.writeHead(404);
      res.end();
    });
  })
  .listen(18788, "127.0.0.1", () => console.log("oracle AI on :18788/v1"));

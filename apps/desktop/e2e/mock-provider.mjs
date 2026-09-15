/**
 * Local mock OpenAI-compatible provider for live self-testing (E2E).
 *
 * Behavior contract:
 *   GET  /v1/models               -> 200, catalog (any auth) — powers Test + discovery
 *   POST /v1/chat/completions     -> Bearer sk-mock-key-A: 401 (dead key — rotation demo)
 *                                     Bearer sk-mock-key-B|C: 200 SSE stream / JSON
 *   POST /v1/images/generations   -> 200 with a tiny embedded PNG (b64_json)
 *
 * Plain node, zero deps: `node e2e/mock-provider.mjs` (port 18787).
 */
import http from "node:http";

const PORT = 18787;
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = () => {
      try {
        return JSON.parse(body || "{}");
      } catch {
        return {};
      }
    };

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "mock-fast", object: "model", owned_by: "mock" },
            { id: "sd-mock-1", object: "model", owned_by: "mock" },
          ],
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (auth === "sk-mock-key-A") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock key A is dead (by design)", type: "invalid_request", code: "invalid_api_key" } }));
        return;
      }
      const { stream, model } = json();
      const text = `Hello from ${model ?? "mock"} via key ${auth === "sk-mock-key-C" ? "C (provider 2)" : "B"}`;
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunks = ["Hel", "lo, ", "world", "!"].map(
          (t) => `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: t } }] })}\n\n`,
        );
        chunks.push(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        chunks.push("data: [DONE]\n\n");
        let i = 0;
        const tick = () => {
          if (i >= chunks.length) {
            res.end();
            return;
          }
          res.write(chunks[i++]);
          setTimeout(tick, 15);
        };
        tick();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "mock",
          object: "chat.completion",
          model: model ?? "mock-fast",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG_1PX }] }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}`, type: "invalid_request" } }));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock provider on http://127.0.0.1:${PORT}/v1`));

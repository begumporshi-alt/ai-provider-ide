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

/**
 * A 96x48 PNG for the image-artifact variant — a visible two-tone mark, generated and verified by
 * scripts/make-fixture-png.mjs. Deliberately NOT the 1x1 pixel the image route uses: a one-pixel
 * bitmap renders as an invisible dot, so a screenshot of that card cannot be told apart from a
 * broken card, and a reviewer would be judging the fixture instead of the layout.
 */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABBUlEQVR42u3Xuw3DMAwE0BshZWZwlU09gXdNE7hIgIiWKX6OBFioMI/Gg2BLeDxfX7Ude9dZ+AVqJhFQM32AtmP/b1ScCeeqmQZAzSQCaiYRUDOJgJpJBFScCZeeLsiEiZ5STJjuLMKEm/30TFBJIWaCYhYlE9QTyZiwKJeGCUvTCZhgMCM1E8wmJWWC8bx0THCZmogJjrNTMMH9DYIzIchODsuEUF/EgEwI+GcNxYSwJ7QgTAh+0ndnQvzbkC9TDiBHpkxALkz5gIyZsgKZMeUGMmBiAFrKxAO0iIkNSJ2JE0iRiRlIhYkf6CZTFaBpplpAE0wVgS4x1QUSMlUHGjI10IDpDZukEE2Cz2TvAAAAAElFTkSuQmCC";

/**
 * A one-page PDF for the PDF-artifact variant — built with correct xref offsets and verified
 * parseable by the REAL pdf.js before being pasted here (`numPages: 1`, 200x100, text
 * "Artifact preview"). A hand-waved PDF would fail inside the renderer, where the failure reads
 * as a broken viewer rather than a bad fixture. Regenerate with scripts/make-fixture-pdf.mjs.
 */
const TINY_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDYgPj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiAyMCA0NSBUZCAoQXJ0aWZhY3QgcHJldmlldykgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwNwolJUVPRgo=";

/** Last request that hit the image bytes endpoint — wire-level truth for the spec. */
let imgSeen = { path: null };

function cors(res, extra = {}) {
  // Authorization must be named explicitly: the "*" wildcard never matches it
  // (Fetch spec), and a preflight that never resolves hangs the whole request.
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    // HTTP-Referer/X-Title: the OpenRouter profile's textHeaders — a preflight that does not
    // name them refuses the profile's chat requests before the handler ever runs.
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept,X-Requested-With,HTTP-Referer,X-Title",
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

/** Await inside the mock's streaming loop, for the `slow:` mode documented at its use site. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    /**
     * The user's own prompt, wherever it sits. `last` is the newest message, which on a follow-up
     * round-trip is a tool *result* — so anything keyed on what the person asked for has to read
     * the last turn they wrote, not the last message on the wire. (Found the hard way: the
     * timeline spec's `think:` trigger fired in round one and silently not in round two.)
     */
    const userPrompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const stream = body.stream === true;
    const tools = Array.isArray(body.tools) && body.tools.length > 0;
    const sawToolResult = messages.some((m) => m.role === "tool");
    // Multimodal: count the image parts this dialect received. Reported in the reply so a spec can
    // assert that the image actually arrived — a body-only assertion would pass even if the reply
    // path dropped it, and this is the same statement the acceptance criterion makes ("a vision
    // model describes it").
    const imageParts = messages.reduce(
      (n, m) =>
        n + (Array.isArray(m.content) ? m.content.filter((p) => typeof p?.type === "string" && /image/i.test(p.type)).length : 0),
      0,
    );

    let content;
    let toolCall;
    /** More than one call in one turn — what exercises the loop's parallel execution (gap 1). */
    let toolCalls;
    // The newest tool result, where second-round branches read what the first round's tool did.
    const toolMsgs = messages.filter((m) => m.role === "tool");
    const lastToolResult = String(toolMsgs[toolMsgs.length - 1]?.content ?? "");
    /**
     * Reasoning-only: the OpenAI-compatible spelling of the failure that produced the "the agent
     * is not replying" report (2026-10-02, `agentrouter.org` / `deepseek-v4-flash`). The model
     * spends its whole output budget deliberating and never opens a text block, so a client that
     * reads only `delta.content` receives **nothing** while 8192 events go past. Driven by a
     * `think:` prefix because the real trigger is a provider-side default (`thinking` on) that a
     * request cannot portably express — the point here is the client's handling of the shape.
     */
    const reasoningOnly = /^think:/i.test(String(last));
    /**
     * Reasoning *before acting*: the shape the timeline spec is about — a model that deliberates
     * and then calls a tool, round after round. Keyed on the same `think:` prefix as the
     * reasoning-only path (which, in agent mode, never fires: the tools branch above wins), and
     * emitted as `reasoning_content` deltas before the content/call deltas so the client sees the
     * order the model produced. Fixed words, so a spec can assert on what reached the panel.
     */
    const thinksBeforeActing = /^think:/i.test(String(userPrompt)) && Boolean(tools);
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
    } else if (tools && /again/i.test(last)) {
      // Agent mode, SECOND-TURN variant: the same tool again, on a later turn and with a history
      // that already contains a tool result. Ungated on `sawToolResult` for that reason — the
      // "always allow this tool" spec needs a call that would be gated if the grant were not
      // recorded, and a branch that required a clean history could never produce one.
      toolCall = { name: "edit_file", arguments: JSON.stringify({ path: "README.md", old: "there", new: "world" }) };
      content = "";
    } else if (tools && /approved/i.test(last)) {
      // Agent mode, PLAN-APPROVED variant: the user turn that follows clicking "Approve plan &
      // execute". Deliberately NOT gated on `!sawToolResult`: the plan pass before it always ends
      // with a tool result (the refusal), so a branch that required a clean history could never
      // fire and the executing pass would look like it did nothing — which is precisely the
      // behaviour this variant exists to disprove.
      toolCall = { name: "edit_file", arguments: JSON.stringify({ path: "README.md", old: "world", new: "there" }) };
      content = "";
    } else if (tools && !sawToolResult && /edit/i.test(last)) {
      // Agent mode, MUTATION variant: an edit_file call against the shim's virtual FS
      // (`README.md` holds "hello\nworld\n"). The transcript must render this as a diff — the
      // added/removed lines — rather than a JSON argument blob, which is what the tool-result
      // rendering spec asserts.
      toolCall = { name: "edit_file", arguments: JSON.stringify({ path: "README.md", old: "world", new: "there" }) };
      content = "";
    } else if (tools && !sawToolResult && /long|slow/i.test(last)) {
      // Agent mode, LONG-COMMAND variant: a run_command the spec holds open (see the shim's
      // `holdTool`), so "Stop cancels the tool that is actually running" can be driven for real.
      // `node` is allowlisted, so the call is one the real sandbox would accept too.
      toolCall = { name: "run_command", arguments: JSON.stringify({ program: "node", args: ["-e", "setTimeout(() => {}, 60000)"] }) };
      content = "";
    } else if (tools && !sawToolResult && /parallel/i.test(last)) {
      // Agent mode, PARALLEL variant: two calls in ONE turn. The loop must run both (its
      // Promise.all over the batch) and append both results before the next round.
      toolCalls = [
        { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
        { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
      ];
      content = "";
    } else if (tools && /notebook/i.test(userPrompt) && !sawToolResult) {
      // Agent mode, NOTEBOOK variant: read first (the listing is what edit_notebook's index
      // targets), then replace cell 0, then summarize. Multi-round branches key on the newest
      // USER turn — on round two `last` is a tool result, which never mentions the notebook.
      toolCall = { name: "read_notebook", arguments: JSON.stringify({ path: "analysis.ipynb" }) };
      content = "";
    } else if (tools && /notebook/i.test(userPrompt) && /nbformat/.test(lastToolResult)) {
      toolCall = {
        name: "edit_notebook",
        arguments: JSON.stringify({
          path: "analysis.ipynb",
          action: "replace",
          index: 0,
          source: "print('edited by the agent')",
        }),
      };
      content = "";
    } else if (tools && /notebook/i.test(userPrompt)) {
      content = "Notebook updated — cell 0 now reads the edited line.";
    } else if (tools && /checklist/i.test(userPrompt) && !sawToolResult) {
      // Agent mode, SKILL variant: the body is fetched through load_skill from the installed,
      // enabled skill the user names (a shim builtin); it arrives as the tool result.
      toolCall = { name: "load_skill", arguments: JSON.stringify({ name: "Code review" }) };
      content = "";
    } else if (tools && /checklist/i.test(userPrompt)) {
      content = "Following the loaded checklist: " + lastToolResult.replace(/\s+/g, " ").trim();
    } else if (tools && /draw/i.test(last) && !sawToolResult) {
      // Agent mode, IMAGE variant: generate_image is loop-handled — the loop itself calls the
      // gateway's image route and lands the bytes with write_file, so nothing here serves the
      // image; the model is passed explicitly because no image default is seeded. Gated on
      // !sawToolResult: the follow-up user turn names the written path ("images/drawn.png"),
      // which also matches /draw/, and without the gate this branch would loop on itself.
      toolCall = {
        name: "generate_image",
        arguments: JSON.stringify({ prompt: "a tiny red pixel", model: "sd-oracle-1", path: "images/drawn.png" }),
      };
      content = "";
    } else if (tools && /background/i.test(userPrompt) && !sawToolResult) {
      // Agent mode, BACKGROUND variant: start a detached job, then poll it by the id the
      // start receipt names.
      toolCall = {
        name: "run_command",
        arguments: JSON.stringify({ program: "echo", args: ["bg", "work", "done"], background: true }),
      };
      content = "";
    } else if (tools && /background/i.test(userPrompt) && /bg-\d+/.test(lastToolResult) && !/\[status\]/.test(lastToolResult)) {
      const id = /bg-\d+/.exec(lastToolResult)[0];
      toolCall = { name: "process_output", arguments: JSON.stringify({ job: id, wait_ms: 1000 }) };
      content = "";
    } else if (tools && /background/i.test(userPrompt)) {
      content = "Background job finished — its output: " + (lastToolResult.split("\n")[1]?.trim() ?? "");
    } else if (tools && /specialist/i.test(userPrompt) && !sawToolResult) {
      // Agent mode, SPECIALIST variant: dispatch_agent naming a user-authored agent type. The
      // child's own request carries the definition's system prompt (marker-echoed in its final
      // answer below), which is what proves the def reached the child loop.
      toolCall = { name: "dispatch_agent", arguments: JSON.stringify({ task: "find the drifted docs", agent: "doc-sweeper" }) };
      content = "";
    } else if (tools && sawToolResult && String(system).includes("DEFMARKER-doc-sweeper")) {
      // The doc-sweeper specialist's own final round: its system turn carries the definition's
      // prompt, so the answer the parent receives proves the def was dispatched, not the
      // default researcher.
      content = "Specialist summary — the doc-sweeper prompt reached the child loop.";
    } else if (tools && !sawToolResult && /delegat/i.test(last)) {
      // Agent mode, DELEGATION variant: dispatch_agent — the tool that never reaches the sandbox.
      // The nested run comes back through this same endpoint with the task as its only user turn
      // ("list the files…" falls through to the list_dir branch), which is what gives the child a
      // tool call of its own to record on the Subagents screen.
      toolCall = { name: "dispatch_agent", arguments: JSON.stringify({ task: "list the files in the workspace" }) };
      content = "";
    } else if (tools && /write page twice/i.test(userPrompt) && toolMsgs.length === 0) {
      // THE SAME FILE TWICE variant: the transcript's artifact preview must appear ONCE, for the
      // newest write, after the run ends — not once per edit (measured complaint 2026-10-10).
      // Ordered before the `/write page/` branch below, which this prompt also matches.
      toolCall = {
        name: "write_file",
        arguments: JSON.stringify({
          path: "site/index.html",
          content: "<!doctype html>\n<html><body><h1>FIRST MARK</h1></body></html>\n",
        }),
      };
      content = "";
    } else if (tools && /write page twice/i.test(userPrompt) && toolMsgs.length === 1) {
      // The second write to the SAME path. Its content supersedes the first, so a preview of the
      // first would be showing the user a file that no longer exists in that form.
      toolCall = {
        name: "write_file",
        arguments: JSON.stringify({
          path: "site/index.html",
          content: "<!doctype html>\n<html><body><h1>FINAL MARK</h1></body></html>\n",
        }),
      };
      content = "";
    } else if (tools && /write page twice/i.test(userPrompt)) {
      content = "Done. Here is what I found in the workspace.";
    } else if (tools && !sawToolResult && /write page/i.test(userPrompt)) {
      // Agent mode, HTML-ARTIFACT variant: a real page written to the workspace, which is what the
      // transcript's artifact card previews. `write_file` (utf-8) is the same call the real host
      // serves, so the diff and the card are driven by one tool result.
      toolCall = {
        name: "write_file",
        arguments: JSON.stringify({
          path: "site/index.html",
          content:
            "<!doctype html>\n<html>\n  <body style=\"font-family: sans-serif\">\n" +
            "    <h1 style=\"color: rebeccapurple\">Written by the agent</h1>\n" +
            "    <p>This file is on disk and previewed from there.</p>\n" +
            "  </body>\n</html>\n",
        }),
      };
      content = "";
    } else if (tools && !sawToolResult && /write pdf/i.test(userPrompt)) {
      // Agent mode, PDF-ARTIFACT variant. `encoding: "base64"` mirrors tools.rs: this is how real
      // bytes reach the disk, and how the artifact reader hands them back.
      toolCall = {
        name: "write_file",
        arguments: JSON.stringify({ path: "docs/report.pdf", content: TINY_PDF_B64, encoding: "base64" }),
      };
      content = "";
    } else if (tools && !sawToolResult && /write logo/i.test(userPrompt)) {
      // Agent mode, IMAGE-ARTIFACT variant: the 1×1 PNG the image route already serves.
      toolCall = {
        name: "write_file",
        arguments: JSON.stringify({ path: "assets/logo.png", content: TINY_PNG_B64, encoding: "base64" }),
      };
      content = "";
    } else if (!tools && /localhost link/i.test(last)) {
      // Plain chat: the model names a dev-server URL. The card fetches it through the host's
      // egress path — loopback is the one remote-ish host the policy permits.
      content = "The preview server is up at http://127.0.0.1:18901/demo — have a look.";
    } else if (!tools && /remote link/i.test(last)) {
      // Plain chat: a host the egress policy does not permit, so the card must NOT try to fetch
      // it — it offers the browser instead.
      content = "The upstream docs live at https://example.com/guide — open that in your browser.";
    } else if (tools && !sawToolResult && /plan the/i.test(userPrompt)) {
      // Agent mode, PLAN-CARD variant: the plan-mode answer IS the plan document — prose, no tool
      // call — which is what the transcript's DocCard renders. Long enough to overflow the
      // card's clamped preview, so the "View full plan" pill is reachable in a spec.
      content = [
        "# Subagent System Upgrade — Two Phases",
        "",
        "Bring the assistant's document rendering up to what ZCode shows: a titled plan card with",
        "a truncated, fading preview and the full document one click away. Each phase ships",
        "independently.",
        "",
        "## Phase 1 — the plan card",
        "",
        "1. Record the plan-mode answer's message id when the run finishes.",
        "2. Render that message through DocCard: icon header, copy button, clamped preview.",
        "3. Expand in place; collapsing returns the faded preview.",
        "",
        "## Phase 2 — live HTML documents",
        "",
        "4. Split whole html documents out of the markdown stream.",
        "5. Preview each one in a sandboxed iframe with a code toggle beside it.",
        "6. Keep fragments and snippets as highlighted code — they are not pages.",
      ].join("\n");
    } else if (tools && !sawToolResult) {
      // Agent-mode trigger: emit one tool call (list_dir ".") so the loop executes it once.
      // The interpreter accumulates deltas by index and emits on stream close.
      toolCall = { name: "list_dir", arguments: JSON.stringify({ path: "." }) };
      content = "";
    } else if (reasoningOnly) {
      // No answer at all — the model never got past thinking. `content` must stay empty, or the
      // test would be asserting on a reply the real provider never sends.
      content = "";
    } else if (!tools && /html page/i.test(last)) {
      // Plain-chat variant: a whole HTML document in a fenced block — the shape the HtmlPreview
      // card exists for. The prose around the fence proves the splitter keeps surrounding text;
      // a fragment stays a code block (asserted in the unit suite, not here).
      content = [
        "Here is a small page:",
        "",
        "```html",
        "<!doctype html>",
        "<html>",
        "  <body style=\"font-family: sans-serif; background: #f8fafc\">",
        "    <h1 style=\"color: teal\">Rendered live</h1>",
        "    <p>This page runs inside the chat.</p>",
        "  </body>",
        "</html>",
        "```",
        "",
        "It renders in a sandboxed frame above.",
      ].join("\n");
    } else {
      content = tools && sawToolResult
        ? "Done. Here is what I found in the workspace."
        : imageParts > 0
          ? `Seen ${imageParts} image${imageParts === 1 ? "" : "s"} in this request.`
          : `Hello from ${body.model ?? "oracle"}`;
    }

    const calls = toolCalls ?? (toolCall ? [toolCall] : []);

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
            ...(calls.length > 0 ? {
              tool_calls: calls.map((c, i) => ({
                id: `call_mock_${i + 1}`,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            } : {}),
          },
          finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    if (thinksBeforeActing) {
      const thought = sawToolResult
        ? "The tool answered; the workspace is in the state the user asked for. Now I can summarise."
        : "The user wants the readme greeting changed. I should read the file before editing it.";
      for (const w of thought.split(" ")) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: w + " " } }] })}\n\n`);
      }
    }
    if (calls.length > 0) {
      // OpenAI streaming shape: per call, a chunk declaring the call (id + name + empty args,
      // each at its own index), then a chunk with its arguments delta; then finish_reason
      // "tool_calls" and [DONE]. The interpreter's collectToolCallDeltas accumulates
      // id/name/args by index and the pending buffer is flushed once the stream ends.
      for (const [i, c] of calls.entries()) {
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{
            index: i, id: `call_mock_${i + 1}`, type: "function",
            function: { name: c.name, arguments: "" },
          }] } }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{
            index: i,
            function: { arguments: c.arguments },
          }] } }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else if (reasoningOnly) {
      // Reasoning deltas only, then the limit. The words are fixed so a spec can assert on the
      // text that reached the panel rather than merely that *something* rendered.
      const reasoning = "The user is asking about the release checklist. I should read the changelog first, then the tags, then report only the differences.";
      for (const w of reasoning.split(" ")) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: w + " " } }] })}\n\n`);
        // Slow enough (≈2 s for the sentence) that a spec can observe the panel while the turn is
        // still running — "open and filling" is the state that distinguishes progress from a hang,
        // and an instant reply could never show it.
        await sleep(90);
      }
      // `max_tokens` covers reasoning AND answer on this shape, and the reasoning took all of it:
      // the stream ends at the output limit with no text block ever opened. This is the fact that
      // separates "the model reasoned too long" from "the manifest cannot read this provider".
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      })}\n\n`);
    } else {
      // A `slow:` prefix on the user's message makes the reply take a few seconds instead of
      // finishing before the browser can breathe. Requested explicitly rather than applied to
      // everything, because most specs want the answer and a delay for them all would only make the
      // suite slower. It exists for the tests that need a turn to still be RUNNING while they act —
      // cancelling one, or checking that a dialog's Escape does not cancel one — where an
      // instantaneous reply is untestable: the turn is over by the time the key arrives.
      const words = /^slow:/i.test(String(last))
        ? Array.from({ length: 40 }, (_, i) => `tick${i}`)
        : content.split(" ");
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + " " } }] })}\n\n`);
        if (words.length > 20) await sleep(120);
      }
    }
    // Streamed usage, on request. This is OpenAI's documented shape and the shape the interpreter
    // waits for: a chunk with an EMPTY `choices` array carrying `usage`, sent after the content
    // (and, on a real server, after the finish chunk) and before `[DONE]`. The router asks for it
    // (`stream_options.include_usage`, from the manifest's `stream.requestUsage`), so a mock that
    // never sent it left every streamed request recording zero tokens — and that is precisely the
    // "cost stayed 0 forever" defect the interpreter's usage tail exists to prevent. Without this
    // the harness cannot exercise the streamed-usage path at all, which is the only path the
    // Assistant uses.
    if (body.stream_options?.include_usage === true) {
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`);
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
    // Dual-modality router: PRIMARY output is text, so it must NOT be tagged an image model.
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
  if (path === "/chat/completions" && req.method === "POST") {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${RAW_OR_KEY}`) return json(res, 401, { error: { message: "No auth credentials found" } });
    // Exists to script the IMAGE story's agent round (ui.spec Story 5): on a draw prompt the
    // model emits one generate_image call naming an image-primary model, so the loop exercises
    // the gateway's image ingress against OpenRouter's real /images route. Same wire shapes as
    // the oracle's handler above — the engine's interpreter consumes both identically.
    const body = JSON.parse((await readBody(req)) || "{}");
    const messages = body.messages ?? [];
    const userPrompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const tools = Array.isArray(body.tools) && body.tools.length > 0;
    const sawToolResult = messages.some((m) => m.role === "tool");
    const calls = tools && !sawToolResult && /draw/i.test(String(userPrompt))
      ? [{
          name: "generate_image",
          arguments: JSON.stringify({ prompt: "a tiny red pixel", model: "openai/gpt-5-image", path: "images/or.png" }),
        }]
      : [];
    const content = calls.length === 0 ? "Done. The image is saved in the workspace." : "";
    if (body.stream !== true) {
      return json(res, 200, {
        id: "chatcmpl-or-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "openai/gpt-4o",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(calls.length > 0 ? {
              tool_calls: calls.map((c, i) => ({
                id: `call_or_mock_${i + 1}`,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            } : {}),
          },
          finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    for (const [i, c] of calls.entries()) {
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: i, id: `call_or_mock_${i + 1}`, type: "function",
          function: { name: c.name, arguments: "" },
        }] } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{
          index: i,
          function: { arguments: c.arguments },
        }] } }],
      })}\n\n`);
    }
    if (calls.length > 0) {
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else {
      for (const w of content.split(" ")) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + " " } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    }
    if (body.stream_options?.include_usage === true) {
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return cors(res);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname.replace(/^\/(v1|v2|v3)/, "");
    /**
     * A plain page for the URL-preview spec — deliberately NOT under /v1, because it is not a
     * provider API route: it is a "dev server" the model names, and the UI fetches it through the
     * host's `egress_request`. Serving real HTML is what makes the preview card take its page
     * branch instead of its text branch.
     */
    if (url.pathname === "/demo" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(
        "<!doctype html><html><body style=\"font-family: sans-serif\">" +
          "<h1 style=\"color: seagreen\">Demo server</h1>" +
          "<p>Served by the mock, shown inside the chat.</p></body></html>",
      );
    }
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

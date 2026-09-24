#!/usr/bin/env node
// measure-gateway-latency.mjs — the gateway's own cost, separated from the provider's.
//
// "Response time" conflates three things: this router's cost, transport, and the upstream model's
// own time. The real ledger cannot separate them — its p50 is dominated by 20k-token prompts — so
// this script builds the only configuration in which the router's share is visible: an isolated
// store pointed at a LOCAL STUB, and the same request sent two ways, once through the gateway and
// once straight at the stub. The difference is the gateway.
//
// Two lessons from the first manual run are built into the setup, because both cost real time:
//
//   1. **The upstream URL has two authorities (D46).** The egress allowlist is derived from
//      `providers.base_url`, but the adapter calls the URL inside the active manifest's
//      `endpoints`. Repointing only the first leaves the manifest's real host outside the
//      allowlist, and every request becomes `HostDenied` — which the attempt layer reports as
//      `NETWORK`, producing a 502 that blames the upstream for a local policy refusal. Both are
//      repointed below, and `assertUpstreamReached` refuses to print numbers if the stub never saw
//      a request.
//   2. **`curl`'s TTFB is not node's TTFB.** `%{time_starttransfer}` counts response HEADERS;
//      the first `res.on("data")` counts the first BODY byte. Same request, two answers, both
//      correct. This script reports the body one, because that is what a user sees.
//
// The real store is only ever READ (via SQLite's WAL-safe `.backup`). Nothing here writes to it.
//
// Usage:  node scripts/measure-gateway-latency.mjs
// Env:    AIPROVIDERD_BIN   path to the release binary (default: the workspace target dir)
//         AIP_SOURCE_DB     the store to snapshot (default: the app's appDataDir)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const BIN = process.env.AIPROVIDERD_BIN
  || path.join(REPO, "apps/desktop/src-tauri/target/release/aiproviderd");
const SOURCE_DB = process.env.AIP_SOURCE_DB
  || path.join(os.homedir(), "Library/Application Support/dev.aiprovider.router/ai-provider-router.db");

const STUB_PORT = 8799;
const GW_PORT = 8801;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aip-lat-"));
const ISO_DB = path.join(TMP, "ai-provider-router.db");

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const q = (sql) => sh("sqlite3", [ISO_DB, sql]).trim();
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); cleanup(); process.exit(1); };

// ── the stub ─────────────────────────────────────────────────────────────────────────────────
// Instantaneous unless a delay is set. The streaming branch is the load-bearing one: it emits
// `gapMs` BETWEEN chunks, so a client's time-to-first-content tells us whether the gateway RELAYS
// chunks as they arrive or BUFFERS the whole answer. Those behave identically in total time and
// differ only in TTFB, which is exactly why total latency alone cannot answer it.
const stub = { served: 0, streams: 0, gapMs: 0, chunks: 6 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStub() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/_ctl/reset") { stub.served = 0; stub.streams = 0; res.end("{}"); return; }
    if (url.pathname === "/_ctl/gap") { stub.gapMs = Number(url.searchParams.get("ms") || 0); res.end("{}"); return; }

    let raw = "";
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* a probe, not a completion */ }
    stub.served++;
    if (!url.pathname.endsWith("/chat/completions")) { res.writeHead(404).end("{}"); return; }

    if (body.stream === true) {
      stub.streams++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (let i = 0; i < stub.chunks; i++) {
        res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: "p" } : { content: "o" }, finish_reason: null }] })}\n\n`);
        await sleep(stub.gapMs);
      }
      res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }));
  });
  return new Promise((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve(server)));
}

// ── the gateway ──────────────────────────────────────────────────────────────────────────────
let child = null;
function startGateway() {
  const env = { ...process.env, AIP_DATA_DIR: TMP };
  for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]) delete env[k];
  child = spawn(BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
}

async function waitForHealth(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${GW_PORT}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

// ── request plumbing ─────────────────────────────────────────────────────────────────────────
let KEY = null;
function request(target, { stream = false } = {}) {
  const payload = JSON.stringify({ model: "agnes-2.5-flash", messages: [{ role: "user", content: "ping" }], ...(stream ? { stream: true } : {}) });
  const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${KEY}` };
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: "127.0.0.1", port: target === "gw" ? GW_PORT : STUB_PORT, path: "/v1/chat/completions", method: "POST", headers }, (res) => {
      let ttfb = null, body = "";
      res.on("data", (c) => { if (ttfb === null) ttfb = Number(process.hrtime.bigint() - t0) / 1e6; body += c; });
      res.on("end", () => resolve({ status: res.statusCode, ttfb, total: Number(process.hrtime.bigint() - t0) / 1e6, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const ms = (n) => `${n.toFixed(1)} ms`;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function cleanup() {
  if (child && !child.killed) child.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────
async function setup() {
  if (!fs.existsSync(BIN)) fail(`no binary at ${BIN} — run \`cargo build --release\` first, or set AIPROVIDERD_BIN`);
  if (!fs.existsSync(SOURCE_DB)) fail(`no store at ${SOURCE_DB} — set AIP_SOURCE_DB`);

  sh("sqlite3", [`file:${SOURCE_DB}?mode=ro`, `.backup '${ISO_DB}'`]);

  const providers = q("SELECT id, slug, base_url FROM providers").split("\n").filter(Boolean);
  if (!providers.length) fail("the snapshot has no providers — nothing to route to");
  const [providerId] = providers[0].split("|");
  const realHost = providers[0].split("|")[2];

  // Both authorities, or the measurement measures the allowlist instead of the gateway (D46).
  q(`UPDATE providers SET base_url='http://127.0.0.1:${STUB_PORT}/v1' WHERE id='${providerId}'`);
  q(`UPDATE manifests SET body_json = replace(body_json, '${realHost}', 'http://127.0.0.1:${STUB_PORT}/v1') WHERE provider_id='${providerId}'`);
  q(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('gateway', '{"port":${GW_PORT},"enabled":true,"mutationEnabled":true}')`);
  q("DELETE FROM ledger");

  const manifest = q(`SELECT body_json FROM manifests WHERE provider_id='${providerId}' AND is_active=1`);
  if (manifest && manifest.includes(realHost)) fail(`the manifest still names ${realHost} — the rewrite missed; the run would report a policy refusal as NETWORK (D46)`);

  KEY = process.env.AIP_GW_KEY || sh("security", ["find-generic-password", "-s", "ai-provider-router", "-a", "masterkey", "-w"]).trim();
  if (!KEY) fail("could not read a credential from the keychain (or set AIP_GW_KEY)");
  // Which credential this is matters to the numbers, not just to auth: the master key is served
  // from a bounded cache, while per-app keys are read from the keychain on every request
  // (`gateway.rs:1374`). Measured 2026-09-24, the difference is **0.8 ms** (11.6 ms master vs
  // 12.4 ms per-app), not the several milliseconds the mechanism suggests — so record it rather
  // than assume it. Note also that `curl` reports a higher `/v1/models` than node does, because
  // node reuses the connection and curl opens a fresh one per invocation.
  // The one lever that controls whether streaming is incremental. `AIP_GATEWAY_TOOLS=off` turns
  // gateway-owned tools off, which makes `ToolOwnership::None`, which stops `ProseGate` holding
  // text back. Merged into whatever `router` row the snapshot carried rather than replacing it,
  // so the other settings keep their real values.
  const toolsOff = process.env.AIP_GATEWAY_TOOLS === "off";
  let routerRow = {};
  try { routerRow = JSON.parse(q("SELECT value_json FROM settings WHERE key='router'") || "{}"); } catch { routerRow = {}; }
  routerRow.gatewayToolsEnabled = !toolsOff;
  const json = JSON.stringify(routerRow).replace(/'/g, "''");
  q(`INSERT OR REPLACE INTO settings (key, value_json) VALUES ('router', '${json}')`);

  const isMaster = !process.env.AIP_GW_KEY;
  return {
    providerId,
    realHost,
    tools: toolsOff ? "off  (streaming can be incremental)" : "on   (ProseGate holds text back)",
    credential: isMaster ? "master key (cached)" : "per-app key (keychain read per request)",
  };
}

// The guard that makes this script worth trusting: if the gateway never reached the upstream, the
// numbers below are measuring a local refusal, not a round trip. Refuse to print them.
function assertUpstreamReached(before) {
  const delta = stub.served - before;
  if (delta === 0) fail("the stub received 0 requests — the gateway refused before egress (see D45/D46); any latency printed here would be the cost of a refusal");
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { realHost, credential, tools } = await setup();
  console.log(`snapshot   ${SOURCE_DB}`);
  console.log(`isolated   ${TMP}   (real store only read)`);
  console.log(`upstream   ${realHost}  →  http://127.0.0.1:${STUB_PORT}/v1`);
  console.log(`credential ${credential}`);
  console.log(`gw tools   ${tools}`);

  const server = await startStub();
  startGateway();
  if (!await waitForHealth()) fail(`the gateway never answered /health on ${GW_PORT}`);

  // Warm-up. Two costs are being paid here and neither is steady-state: the master-key cache fill
  // and the adapter's first touch. The cache fill is the one that matters — the keychain read is
  // bounded by `MASTER_KEY_WAIT` (1500 ms, `gateway.rs:143`), and until it completes **every
  // authenticated route answers 503**, whatever credential is presented.
  //
  // `/health` does not cover this, and the first version of this script wrongly assumed it did:
  // `/health` is deliberately unauthenticated, so a 200 from it says nothing about whether the
  // authenticated surface is ready. Polling it and then immediately sending a request lands inside
  // the window. Retrying the *authenticated* call on 503 is therefore the correct readiness check
  // rather than a workaround — and it is the same trap a Phase 6 supervisor will hit.
  let warm = null;
  const warmDeadline = Date.now() + 10000;
  while (Date.now() < warmDeadline) {
    warm = await request("gw");
    if (warm.status !== 503) break;
    await sleep(250);
  }
  if (warm.status !== 200) fail(`warm-up returned ${warm.status}: ${warm.body.slice(0, 160)}`);
  console.log(`warm-up    ${ms(warm.total)} (excluded from the statistics)\n`);

  const N = 15;
  const before = stub.served;
  const viaGw = [], direct = [];
  for (let i = 0; i < N; i++) { viaGw.push(await request("gw")); direct.push(await request("stub")); }
  assertUpstreamReached(before);

  const g = viaGw.map((r) => r.total), d = direct.map((r) => r.total);
  console.log("── the gateway's own overhead ─────────────────────────────────────");
  console.log(`  direct to upstream   median ${ms(med(d))}`);
  console.log(`  through the gateway  median ${ms(med(g))}`);
  console.log(`  ⇒ overhead           ${ms(med(g) - med(d))} at the median, ${ms(mean(g) - mean(d))} on average  (n=${N})`);

  const models = [];
  for (let i = 0; i < 12; i++) { const t = process.hrtime.bigint(); await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } }); models.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const health = [];
  for (let i = 0; i < 12; i++) { const t = process.hrtime.bigint(); await fetch(`http://127.0.0.1:${GW_PORT}/health`); health.push(Number(process.hrtime.bigint() - t) / 1e6); }
  console.log("\n── where it goes ──────────────────────────────────────────────────");
  console.log(`  /health            (no auth)              ${ms(med(health))}`);
  console.log(`  /v1/models         (+ auth + store)       ${ms(med(models))}`);
  console.log(`  /v1/chat/completions (+ router + ledger)  ${ms(med(g))}`);

  await fetch(`http://127.0.0.1:${STUB_PORT}/_ctl/gap?ms=0`).catch(() => {});
  const burst = await Promise.all(Array.from({ length: 24 }, () => request("gw")));
  const tally = {};
  for (const r of burst) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log("\n── concurrency: 24 at once ────────────────────────────────────────");
  console.log(`  statuses ${JSON.stringify(tally)}   (perProviderConcurrency sheds, it does not queue)`);

  // Streaming: upstream emits 6 chunks 200 ms apart, so ~1200 ms of upstream time. A first content
  // byte near 1200 ms means the gateway BUFFERED; near 200 ms means it RELAYED.
  await fetch(`http://127.0.0.1:${STUB_PORT}/_ctl/gap?ms=200`).catch(() => {});
  const s = await request("gw", { stream: true });
  const relayed = s.ttfb !== null && s.ttfb < s.total * 0.5;
  console.log("\n── streaming: does the client see tokens early? ───────────────────");
  console.log(`  upstream emitted over ~1200 ms`);
  console.log(`  first content byte ${ms(s.ttfb)}   total ${ms(s.total)}`);
  console.log(`  ⇒ ${relayed ? "RELAYED incrementally" : "BUFFERED — the whole answer arrives at the end"}`);

  server.close();
  cleanup();
  console.log(`\n✓ done — the real store was not modified`);
}

main().catch((e) => { console.error(`\n✗ ${e.message}\n`); cleanup(); process.exit(1); });

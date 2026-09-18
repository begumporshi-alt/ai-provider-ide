/**
 * Gateway worker entry (audit R1) — the whole point of this file is that it runs in a webview
 * that is NOT the visible UI. It hydrates the router core from the host and then answers the
 * Rust gateway's routed requests.
 *
 * It deliberately imports as little as possible: no React, no screens. That keeps this page's
 * module graph small, so editing the UI does not trigger an HMR reload that would tear down
 * the bridge mid-request.
 *
 * The master key never appears here — authentication happened in Rust before this file runs.
 */
import { invoke } from "@tauri-apps/api/core";
import { bootstrap } from "./store";
import { startGatewayBridge } from "./gateway-bridge";

const log = document.getElementById("log");

function write(message: string, cls?: string): void {
  if (!log) return;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = message;
  log.appendChild(line);
}

async function main(): Promise<void> {
  await bootstrap();
  write("router core hydrated");
  await startGatewayBridge();
  write("bridge listening — gateway requests are served from this window", "ok");
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  write(`gateway worker failed: ${String(e)}`, "err");
  // This window is never visible, so the console above is unreadable. Without reporting it
  // host-side the only symptom is a gateway that stops answering seconds after Start.
  void invoke("gateway_worker_error", { message }).catch(() => undefined);
});

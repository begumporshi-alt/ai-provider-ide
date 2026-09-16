/**
 * Local Gateway settings (UI_UX_PLAN.md §7): "turning on a local service", not API config —
 * Running status, the endpoint URL prominent, master key as SecretAction (copy primary,
 * reveal is a Rust-side clipboard action — never a webview string), and copy presets.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, inputCls, inputStyle } from "../components/atoms";

interface GatewayStatus {
  running: boolean;
  port: number;
  hasKey: boolean;
  endpointUrl: string;
}

export function GatewayScreen() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  // null = loading the persisted port; keeps the chosen port across restarts (§3.3 UX)
  const [portInput, setPortInput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<GatewayStatus>("gateway_status").then(setStatus).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    refresh();
    invoke<string | null>("settings_get", { key: "gateway" })
      .then((v) => {
        const p = v ? (JSON.parse(v) as { port?: number }).port : undefined;
        setPortInput(String(p ?? 8787));
      })
      .catch(() => setPortInput("8787"));
    const t = window.setInterval(refresh, 2500);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function toggle() {
    setError(null);
    try {
      if (status?.running) {
        await invoke("gateway_disable");
      } else {
        const port = Number(portInput) || undefined;
        await invoke("gateway_enable", { port });
        await invoke("settings_set", { key: "gateway", valueJson: JSON.stringify({ port }) });
        if (!status?.hasKey) await invoke("gateway_key_generate");
      }
      refresh();
    } catch (e) {
      setError(String(e)); // invariant 16: port-squat surfaces here, loudly
    }
  }

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    flash(label);
  }

  function flash(label: string) {
    setCopied(label);
    window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
  }

  const running = status?.running ?? false;
  const endpoint = status?.endpointUrl ?? `http://127.0.0.1:${portInput || 8787}/v1`;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-[20px] font-semibold">Local Gateway</h1>
      <p className="mb-4 text-[13px]" style={{ color: "var(--text-dim)" }}>
        Expose your whole Model Router behind one local master key — speaking OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini. Any app that takes a
        base URL + API key — Cursor, Continue, openai-python, scripts — gets every provider you
        configured, with the same key rotation and failover, behind one local master key.
      </p>

      <section className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <div className="mb-3 flex items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${running ? "dot-healthy" : "dot-disabled"}`} />
          <span className="text-[14px] font-semibold">{running ? "Running" : "Stopped"}</span>
          <div className="ml-auto flex items-center gap-2">
            <input
              className={`${inputCls} w-24`}
              style={inputStyle}
              value={portInput ?? ""}
              onChange={(e) => setPortInput(e.target.value.replace(/\D/g, ""))}
              disabled={running || portInput === null}
              inputMode="numeric"
            />
            <Button variant={running ? "danger" : "primary"} onClick={() => void toggle()}>
              {running ? "Stop" : "Start"}
            </Button>
          </div>
        </div>

        <div className="mb-2">
          <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Endpoint URL</span>
          <div className="flex items-center gap-2">
            <code className="mono flex-1 truncate rounded border px-2 py-1.5" style={{ background: "var(--bg)", borderColor: "var(--border)" }}>{endpoint}</code>
            <Button onClick={() => void copy(endpoint, "url")}>{copied === "url" ? "Copied" : "Copy"}</Button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px]">Master key</span>
            <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {status?.hasKey ? "Stored in your OS keychain. Shown once on generation; reveal = copy to clipboard (never shown here)." : "None yet — starting the gateway generates one."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void invoke("gateway_key_copy").then(() => flash("key"), (e) => setError(String(e)))} disabled={!status?.hasKey}>
              {copied === "key" ? "Copied" : "Copy key"}
            </Button>
            <Button onClick={() => void invoke("gateway_key_generate").then(() => flash("rotate"), (e) => setError(String(e)))}>
              Rotate
            </Button>
            <Button variant="danger" onClick={() => void invoke("gateway_key_revoke").then(refresh)}>
              Revoke
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded border px-3 py-2 text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            {error}
            {/cannot bind/.test(error) && (
              <div className="mt-1" style={{ color: "var(--text-dim)" }}>
                Another process owns that port. Pick a different port above and press Start. Note: the default 8787 is fixed so app URLs stay predictable — a local process could squat it (documented v1 trade-off).
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-2 text-[14px] font-semibold">Copy-paste presets</h2>
        <PresetRow
          label="openai-python"
          code={`client = OpenAI(base_url="${endpoint}", api_key="<master key>")`}
          onCopy={() => void copy(`client = OpenAI(base_url="${endpoint}", api_key="<master key>")`, "py")}
        />
        <PresetRow
          label="cURL (stream)"
          code={`curl ${endpoint}/chat/completions \\\n  -H "Authorization: Bearer <master key>" -H "content-type: application/json" \\\n  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'`}
          onCopy={() => void copy(`curl ${endpoint}/chat/completions -H "Authorization: Bearer <master key>" -H "content-type: application/json" -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'`, "curl")}
        />
        <PresetRow
          label="Cursor / Continue"
          code={`OpenAI Base URL: ${endpoint}\nAPI Key: <paste the copied master key>`}
          onCopy={() => void copy(`OpenAI Base URL: ${endpoint}\nAPI Key: <paste the copied master key>`, "cursor")}
        />
        <PresetRow
          label="Claude Code / anthropic-sdk"
          code={`export ANTHROPIC_BASE_URL="${endpoint}"\nexport ANTHROPIC_API_KEY=<paste the copied master key>`}
          onCopy={() => void copy(`export ANTHROPIC_BASE_URL="${endpoint}"\nexport ANTHROPIC_API_KEY=<paste the copied master key>`, "claude")}
        />
        <PresetRow
          label="cURL — Anthropic /v1/messages"
          code={`curl ${endpoint}/messages \\\n  -H "x-api-key: <master key>" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \\\n  -d '{"model":"claude-3-5-sonnet","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`}
          onCopy={() => void copy(`curl ${endpoint}/messages -H "x-api-key: <master key>" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"claude-3-5-sonnet","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`, "acurl")}
        />
        <PresetRow
          label="OpenAI Responses (Codex-style)"
          code={`curl ${endpoint.replace("/v1", "")}/v1/responses \\\n  -H "authorization: Bearer <master key>" -H "content-type: application/json" \\\n  -d '{"model":"gpt-4o","input":"hi","stream":true}'`}
          onCopy={() => void copy(`curl ${endpoint.replace("/v1", "")}/v1/responses -H "authorization: Bearer <master key>" -H "content-type: application/json" -d '{"model":"gpt-4o","input":"hi","stream":true}'`, "rcurl")}
        />
        <PresetRow
          label="Gemini generateContent"
          code={`curl "${endpoint.replace("/v1", "/v1beta")}/models/mock/model-name:generateContent" \\\n  -H "x-goog-api-key: <master key>" -H "content-type: application/json" \\\n  -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`}
          onCopy={() => void copy(`curl "${endpoint.replace("/v1", "/v1beta")}/models/mock/model-name:generateContent" -H "x-goog-api-key: <master key>" -H "content-type: application/json" -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`, "gcurl")}
        />
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-2 text-[14px] font-semibold">How it behaves</h2>
        <ul className="list-disc space-y-1 pl-5 text-[12px]" style={{ color: "var(--text-dim)" }}>
          <li>Binds <code className="mono">127.0.0.1</code> only — nothing on your LAN is reachable (LAN sharing would be a separate, warned opt-in).</li>
          <li>Serves while this window is open. Closing the app stops the gateway.</li>
          <li>Model names: qualified <code className="mono">provider/native</code> for an exact provider, or a bare id to let the router pick + fail over.</li>
          <li>Every request is logged in Activity under source <span className="mono">gateway</span>. Wrong key → 401; router busy → 429; app closed → 503.</li>
          <li>Four compatible surfaces — one master key: <b>OpenAI Chat</b> (<span className="mono">/v1/chat/completions</span>, <span className="mono">/v1/models</span>, <span className="mono">/v1/images/generations</span>) · <b>OpenAI Responses</b> (<span className="mono">/v1/responses</span>) · <b>Anthropic Messages</b> (<span className="mono">/v1/messages</span>, auth via <span className="mono">x-api-key</span> — Claude Code / anthropic-sdk) · <b>Gemini</b> (<span className="mono">/v1beta/models/&lt;model&gt;:generateContent</span> + <span className="mono">?alt=sse</span> streaming, auth via <span className="mono">x-goog-api-key</span> or <span className="mono">?key=</span>). Tools/tool_choice are refused with a clear error (never silently dropped).</li>
        </ul>
      </section>
    </div>
  );
}

function PresetRow({ label, code, onCopy }: { label: string; code: string; onCopy: () => void }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium" style={{ color: "var(--text-dim)" }}>{label}</span>
        <Button variant="ghost" onClick={onCopy}>Copy</Button>
      </div>
      <pre className="mono mt-0.5 overflow-x-auto whitespace-pre-wrap rounded border p-2 text-[11px]" style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}>
        {code}
      </pre>
    </div>
  );
}

void Field;

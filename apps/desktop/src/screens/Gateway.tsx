/**
 * Local Gateway settings (UI_UX_PLAN.md §7): "turning on a local service", not API config —
 * Running status, the endpoint URL prominent, master key as SecretAction (copy primary,
 * reveal is a Rust-side clipboard action — never a webview string), and copy presets.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, inputCls, inputStyle } from "../components/atoms";

interface GatewayStatus {
  /** Operator intent — the gateway is supposed to be serving. Not the same as "the worker is
   *  awake": a hidden worker's beat stops after ~8 idle minutes and revives on demand. */
  running: boolean;
  port: number;
  hasKey: boolean;
  endpointUrl: string;
  /** R1: window hidden, gateway serving in the background. */
  background: boolean;
  /** The worker is awake right now rather than merely reachable. False is routine. */
  workerAwake: boolean;
  /** Age of the worker's last heartbeat. Distinguishes "you stopped it" from "it lapsed". */
  heartbeatAgeMs: number;
  /** Why the worker page failed to boot, if it did. It runs in an invisible window. */
  workerError: string | null;
}

/** Audit R4: metadata only — the secret lives in the keychain and is never returned here. */
interface AppKey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Audit R4: month-to-date spend vs. the cap, both in micro-USD (cap 0 = disabled). */
interface SpendStatus {
  monthMicros: number;
  capMicros: number;
  capped: boolean;
}

/** Canonical cost unit is micro-USD (see packages/router-core/src/pricing.ts). */
function usd(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: micros < 10_000 ? 4 : 2,
  });
}

export function GatewayScreen() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  // null = loading the persisted port; keeps the chosen port across restarts (§3.3 UX)
  const [portInput, setPortInput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Mirrors the Rust default (GatewayCore::new) so the toggle does not flash "Disabled"
  // for a beat before the invoke resolves.
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(true);
  // Audit H1b: gateway mutation (write_file / run_command) is OFF by default — the gateway has
  // no confirmation UI, unlike the Assistant. Mirrors the Rust default so it does not flash.
  const [mutationEnabled, setMutationEnabled] = useState<boolean>(false);
  // R4
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [spend, setSpend] = useState<SpendStatus | null>(null);
  const [capInput, setCapInput] = useState("");
  // R1: closing the window hides the app instead of quitting, so the gateway keeps serving.
  // Persisted under settings key "background"; defaults ON (that is the point of the feature).
  const [hideOnClose, setHideOnClose] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    invoke<GatewayStatus>("gateway_status").then(setStatus).catch((e) => setError(String(e)));
    invoke<boolean>("get_tools_enabled").then(setToolsEnabled).catch(() => {});
    invoke<boolean>("get_tools_mutation_enabled").then(setMutationEnabled).catch(() => {});
  }, []);

  const refreshKeys = useCallback(() => {
    invoke<AppKey[]>("gateway_app_keys").then(setAppKeys).catch((e) => setError(String(e)));
  }, []);
  const refreshSpend = useCallback(() => {
    invoke<SpendStatus>("gateway_spend_status")
      .then((s) => {
        setSpend(s);
        // Mirror the persisted cap into the field. Only runs on mount and after a save, so it
        // cannot clobber an in-progress edit.
        setCapInput(s.capMicros > 0 ? String(s.capMicros / 1_000_000) : "");
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    refresh();
    refreshKeys();
    refreshSpend();
    invoke<string | null>("settings_get", { key: "gateway" })
      .then((v) => {
        const p = v ? (JSON.parse(v) as { port?: number }).port : undefined;
        setPortInput(String(p ?? 8787));
      })
      .catch(() => setPortInput("8787"));
    invoke<string | null>("settings_get", { key: "background" })
      .then((v) => setHideOnClose(v ? (JSON.parse(v) as { hideOnClose?: boolean }).hideOnClose ?? true : true))
      .catch(() => setHideOnClose(true));
    const t = window.setInterval(refresh, 2500);
    return () => window.clearInterval(t);
  }, [refresh, refreshKeys, refreshSpend]);

  async function toggle() {
    setError(null);
    try {
      if (status?.running) {
        await invoke("gateway_disable");
        // Persist the off state too: "enabled" is what startup restores, so leaving a stale
        // `true` behind would start the gateway again on the next launch.
        const port = Number(portInput) || undefined;
        await invoke("settings_set", { key: "gateway", valueJson: JSON.stringify({ port, enabled: false }) });
      } else {
        const port = Number(portInput) || undefined;
        await invoke("gateway_enable", { port });
        await invoke("settings_set", { key: "gateway", valueJson: JSON.stringify({ port, enabled: true }) });
        if (!status?.hasKey) await invoke("gateway_key_generate");
      }
      refresh();
    } catch (e) {
      setError(String(e)); // invariant 16: port-squat surfaces here, loudly
    }
  }

  /**
   * R4: the secret is generated and copied host-side (Rust arboard) and never enters the
   * webview — that is why this returns only {id, label} and the UI says "copied to clipboard".
   */
  async function createAppKey() {
    setError(null);
    const label = newKeyLabel.trim() || "untitled";
    try {
      await invoke<{ id: string; label: string }>("gateway_app_key_create", { label });
      setNewKeyLabel("");
      refreshKeys();
      flash("appkey");
    } catch (e) {
      setError(String(e));
    }
  }

  async function revokeAppKey(id: string) {
    setError(null);
    try {
      await invoke("gateway_app_key_revoke", { id });
      refreshKeys();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteAppKey(id: string) {
    setError(null);
    try {
      await invoke("gateway_app_key_delete", { id });
      refreshKeys();
    } catch (e) {
      setError(String(e));
    }
  }

  /** R1: persist close-to-background. Read host-side at close time (`hide_on_close` in lib.rs);
   *  nothing to restart — the preference takes effect on the next close. */
  async function setBackground(on: boolean) {
    setError(null);
    try {
      await invoke("settings_set", { key: "background", valueJson: JSON.stringify({ hideOnClose: on }) });
      setHideOnClose(on);
    } catch (e) {
      setError(String(e));
    }
  }

  /** `override` bypasses the text field (Disable button) — setState is async, so the field
   *  value cannot be read back in the same tick. */
  async function saveCap(override?: number) {
    setError(null);
    const micros =
      override ??
      (() => {
        const usdValue = Number(capInput);
        if (capInput.trim() === "" || !Number.isFinite(usdValue)) return 0;
        return Math.max(0, Math.round(usdValue * 1_000_000));
      })();
    try {
      await invoke("gateway_spend_cap_set", { capMicros: micros });
      refreshSpend();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleTools() {
    setError(null);
    try {
      await invoke("set_tools_enabled", { enabled: !toolsEnabled });
      setToolsEnabled((prev) => !prev);
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleMutation() {
    setError(null);
    try {
      await invoke("set_tools_mutation_enabled", { enabled: !mutationEnabled });
      setMutationEnabled((prev) => !prev);
    } catch (e) {
      setError(String(e));
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

        {status?.workerError && (
          <div className="mb-3 rounded border p-2.5" style={{ borderColor: "var(--danger)", background: "var(--danger-soft, transparent)" }}>
            <p className="text-[12px] font-medium" style={{ color: "var(--danger)" }}>
              The gateway worker failed to start, so nothing can answer requests.
            </p>
            <pre className="mono mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text-faint)" }}>
              {status.workerError}
            </pre>
          </div>
        )}

        {running && status && !status.workerAwake && !status.workerError && (
          <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
            Running — the worker is asleep. macOS suspends a hidden page after roughly eight idle
            minutes; the next request wakes it and is served normally. Nothing is lost.
          </p>
        )}

        {!running && status && !status.workerError && status.heartbeatAgeMs > 0 && (
          <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
            Stopped — last heard from the worker {Math.round(status.heartbeatAgeMs / 1000)}s ago.
          </p>
        )}

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
        <h2 className="mb-1 text-[14px] font-semibold">Background</h2>
        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Closing the window keeps the app — and the gateway — running instead of quitting. It moves to your menu bar
          (or the Dock on macOS); click it to come back, or use Quit there to stop completely.
        </p>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px] font-medium">Keep running when the window is closed</span>
            <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {hideOnClose === null
                ? "Loading preference…"
                : hideOnClose
                  ? "On — closing the window hides the app and the gateway keeps serving."
                  : "Off — closing the window quits the app and stops the gateway."}
            </p>
          </div>
          <Button variant={hideOnClose ? "primary" : "ghost"} onClick={() => void setBackground(!hideOnClose)} disabled={hideOnClose === null}>
            {hideOnClose ? "On" : "Off"}
          </Button>
        </div>
        {status?.background && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
            Serving in the background right now.
          </p>
        )}
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-1 text-[14px] font-semibold">Per-app keys</h2>
        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Give each connected app its own key so you can cut one off without rotating the master key — and without
          breaking every other app. The secret is shown once, by copying it to your clipboard; only the label is kept.
          Revoking takes effect on the very next request.
        </p>

        <div className="mb-3 flex items-center gap-2">
          <input
            className={`${inputCls} flex-1`}
            style={inputStyle}
            placeholder="Label — e.g. Cursor, Claude Code, my-script"
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAppKey();
            }}
          />
          <Button variant="primary" onClick={() => void createAppKey()}>
            {copied === "appkey" ? "Copied to clipboard" : "Create key"}
          </Button>
        </div>

        {appKeys.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            No per-app keys yet. Everything currently uses the master key.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {appKeys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{k.label}</span>
                    {k.revokedAt !== null && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ background: "var(--bg)", color: "var(--danger)" }}>
                        revoked
                      </span>
                    )}
                  </div>
                  <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {k.id} · created {new Date(k.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {k.revokedAt === null ? (
                  <Button variant="danger" onClick={() => void revokeAppKey(k.id)}>Revoke</Button>
                ) : (
                  <Button variant="ghost" onClick={() => void deleteAppKey(k.id)}>Delete</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-1 text-[14px] font-semibold">Monthly spend cap</h2>
        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Stops a runaway consumer — an agent loop in a connected IDE — from spending past a budget. Month-to-date is
          measured from the ledger at the UTC month boundary and counts <b>all</b> router usage (Assistant and generator
          included), not just gateway traffic, so it is a real ceiling on what you pay. When it is reached the gateway
          answers 402 instead of forwarding. Leave blank to disable.
        </p>

        <div className="mb-3 flex items-center gap-4">
          <div>
            <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>This month</span>
            <span className="mono text-[15px] font-semibold" style={{ color: spend?.capped ? "var(--danger)" : "var(--text)" }}>
              {spend ? usd(spend.monthMicros) : "—"}
            </span>
          </div>
          <div>
            <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Cap (USD)</span>
            <div className="flex items-center gap-2">
              <input
                className={`${inputCls} w-28`}
                style={inputStyle}
                value={capInput}
                placeholder="none"
                inputMode="decimal"
                onChange={(e) => setCapInput(e.target.value.replace(/[^\d.]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveCap();
                }}
              />
              <Button onClick={() => void saveCap()}>{spend?.capMicros ? "Update" : "Set cap"}</Button>
              {spend?.capMicros ? (
                <Button variant="ghost" onClick={() => { setCapInput(""); void saveCap(0); }}>Disable</Button>
              ) : null}
            </div>
          </div>
        </div>

        {spend?.capped && (
          <div className="rounded border px-3 py-2 text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            Cap reached — the gateway is refusing requests with 402 until the month rolls over or you raise the cap.
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
          <li>Serves while the app is running — including with the window closed, once background mode is on. Quitting
            the app stops the gateway.</li>
          <li>Model names: qualified <code className="mono">provider/native</code> for an exact provider, or a bare id to let the router pick + fail over.</li>
          <li>Every request is logged in Activity under source <span className="mono">gateway</span>. Wrong key → 401; router busy → 429; app closed → 503; monthly cap reached → 402.</li>
          <li>Per-app keys are checked alongside the master key, and revocation lands on the next request. A failed
            attempt never slows down a caller with a valid key.</li>
          <li>Four compatible surfaces — one master key: <b>OpenAI Chat</b> (<span className="mono">/v1/chat/completions</span>, <span className="mono">/v1/models</span>, <span className="mono">/v1/images/generations</span>) · <b>OpenAI Responses</b> (<span className="mono">/v1/responses</span>) · <b>Anthropic Messages</b> (<span className="mono">/v1/messages</span>, auth via <span className="mono">x-api-key</span> — Claude Code / anthropic-sdk) · <b>Gemini</b> (<span className="mono">/v1beta/models/&lt;model&gt;:generateContent</span> + <span className="mono">?alt=sse</span> streaming, auth via <span className="mono">x-goog-api-key</span> or <span className="mono">?key=</span>).</li>
          <li>Tools/tool_choice/response_format are forwarded to upstream providers when enabled. Legacy <code className="mono">functions</code> parameters (deprecated OpenAI style) are always rejected.</li>
        </ul>
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-2 text-[14px] font-semibold">Feature toggles</h2>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px] font-medium">Gateway tools</span>
            <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              On (default): a client that brings its own <code className="mono">tools</code> has them forwarded
              upstream and runs them itself; a client that brings none gets the gateway&apos;s own sandboxed
              tools, confined to <span className="mono">~/AI-Provider-Router-Workspace</span>. Off strips
              <code className="mono">tools</code>, <code className="mono">tool_choice</code> and
              <code className="mono">response_format</code> from every request.
            </p>
          </div>
          <Button
            variant={toolsEnabled ? "primary" : "ghost"}
            onClick={() => void toggleTools()}
          >
            {toolsEnabled ? "Enabled" : "Disabled"}
          </Button>
        </div>

        <div className="mt-3 flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <span className="text-[13px] font-medium">Gateway writes &amp; commands</span>
            <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              Off (default): the gateway&apos;s sandbox serves the four read-only tools — <code className="mono">read_file</code>,
              <code className="mono">list_dir</code>, <code className="mono">search_files</code>, <code className="mono">file_info</code> — and refuses
              <code className="mono">write_file</code>, <code className="mono">edit_file</code>, <code className="mono">mkdir</code> and
              <code className="mono">run_command</code>. The Assistant asks before every call,
              the gateway cannot — there is no UI on that path — so mutation is opt-in. Every gateway tool
              execution is written to <span className="mono">gateway.log</span> either way.
            </p>
          </div>
          <Button
            variant={mutationEnabled ? "primary" : "ghost"}
            onClick={() => void toggleMutation()}
          >
            {mutationEnabled ? "Enabled" : "Disabled"}
          </Button>
        </div>
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

/**
 * Local Gateway settings (UI_UX_PLAN.md §7): "turning on a local service", not API config —
 * Running status, the endpoint URL prominent, master key as SecretAction (copy primary,
 * reveal is a Rust-side clipboard action — never a webview string), and copy presets.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, inputCls, inputStyle } from "../components/atoms";
import { usd } from "../lib/format";
import { readGatewaySettings, type GatewayStatus } from "../store";
import { fetchAdmin } from "../lib/gateway-client";

/**
 * Audit R4: metadata only — the secret lives in the keychain and is never returned here.
 *
 * `capMicros` and `monthMicros` are 0017's per-app budget: what this app may spend in the month,
 * and what it has spent. `monthMicros` counts only rows written since attribution landed
 * (2026-09-23), so a key that has served traffic for months can legitimately read `$0.00` — that
 * is "not attributed", not "never used".
 */
interface AppKey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** This app's monthly budget in micro-USD. `null` = no budget of its own. */
  capMicros: number | null;
  monthMicros: number;
}

export function GatewayScreen() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  /**
   * Read once, and only for the endpoint URL's fallback before the host has answered.
   *
   * The port is *set* on Control → Gateway now. This screen keeps a read of the same row because it
   * is the screen that prints the URL, and printing `8787` while the live port is something else
   * would hand out an address that does not exist.
   */
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // R4
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  /**
   * One in-progress budget field per key, in USD.
   *
   * Keyed by id rather than held as a single field, because a budget is a property of *a key*: a
   * shared field would paint one app's draft against another app's row the moment the list had
   * more than one entry.
   */
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});
  // R1: closing the window hides the app instead of quitting, so the gateway keeps serving.
  // Persisted under settings key "background"; defaults ON (that is the point of the feature).
  const [hideOnClose, setHideOnClose] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    invoke<GatewayStatus>("gateway_status").then(setStatus).catch((e) => setError(String(e)));
  }, []);

  const refreshKeys = useCallback(() => {
    invoke<AppKey[]>("gateway_app_keys")
      .then((rows) => {
        setAppKeys(rows);
        /**
         * Seed a budget field the first time its key is seen, and **never from here again**.
         *
         * The list does not arrive with the screen: the heading paints first, so an operator can
         * start typing into a field before `gateway_app_keys` answers. Re-seeding on every refresh
         * therefore wiped the value they had typed, and the save that followed sent `0` — clearing
         * a budget instead of setting one, silently. Measured 2026-09-23 by `app-budget.spec.ts`,
         * which caught it on the first run.
         *
         * Building `next` fresh also drops drafts for keys that no longer exist, which is why the
         * deleted key's row does not come back with a stale field.
         */
        setCapDrafts((prev) => {
          const next: Record<string, string> = {};
          for (const k of rows) {
            next[k.id] = prev[k.id] ?? (k.capMicros !== null ? String(k.capMicros / 1_000_000) : "");
          }
          return next;
        });
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    refresh();
    refreshKeys();
    readGatewaySettings()
      .then((s) => setPort(s.port ?? 8787))
      .catch(() => setPort(8787));
    // The keyed route answers an object, so there is no `JSON.parse` and no null case to special
    // case: a missing row answers `{}`, and `{}.hideOnClose ?? true` is the default the old
    // ternary produced. The host still reads this row directly at close time (`hide_on_close`).
    fetchAdmin("GET", "/admin/settings/background")
      .then((v) => setHideOnClose((v as { hideOnClose?: boolean } | null)?.hideOnClose ?? true))
      .catch(() => setHideOnClose(true));
    const t = window.setInterval(refresh, 2500);
    return () => window.clearInterval(t);
  }, [refresh, refreshKeys]);

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

  /**
   * 0017: set one app's monthly budget.
   *
   * An empty field means "clear", matching Control's global cap: `Number("")` is `0` and `0` is
   * the host's own "no budget" value, so the two agree without a special case. Negative and
   * non-numeric input is clamped here as well as host-side — the field is already restricted to
   * digits and a dot, so this is a backstop, not the guard.
   */
  async function saveAppKeyCap(id: string) {
    setError(null);
    const draft = capDrafts[id] ?? "";
    const dollars = Number(draft);
    const micros =
      draft.trim() === "" || !Number.isFinite(dollars)
        ? 0
        : Math.max(0, Math.round(dollars * 1_000_000));
    try {
      await invoke("gateway_app_key_cap_set", { id, capMicros: micros });
      // Reflect the value actually sent, normalized the way the host normalizes it, so the field
      // and the row cannot disagree after a save. `refreshKeys` will not overwrite it — see there.
      setCapDrafts((d) => ({ ...d, [id]: micros > 0 ? String(micros / 1_000_000) : "" }));
      refreshKeys();
    } catch (e) {
      setError(String(e));
    }
  }

  /** Clearing is the same command with `0`; the host normalizes that to no budget at all. */
  async function clearAppKeyCap(id: string) {
    setError(null);
    try {
      await invoke("gateway_app_key_cap_set", { id, capMicros: 0 });
      setCapDrafts((d) => ({ ...d, [id]: "" }));
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
      await fetchAdmin("POST", "/admin/settings/background", { hideOnClose: on });
      setHideOnClose(on);
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
  const endpoint = status?.endpointUrl ?? `http://127.0.0.1:${port ?? 8787}/v1`;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-[20px] font-semibold">Local Gateway</h1>
      <p className="mb-4 text-[13px]" style={{ color: "var(--text-dim)" }}>
        Expose your whole Model Router behind one local master key — speaking OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini. Any app that takes a
        base URL + API key — Cursor, Continue, openai-python, scripts — gets every provider you
        configured, with the same key rotation and failover, behind one local master key.
      </p>

      <section className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        {/*
          State, not control. Starting and stopping the gateway, and choosing its port, live on
          Control → Gateway (§3: move, don't mirror) — a switch rendered in two places has two
          sources of truth, and they drift. What stays here is the *read*: this is the screen that
          prints the endpoint URL, so it has to say whether that URL answers.
        */}
        <div className="mb-3 flex items-center gap-3">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${running ? "dot-healthy" : "dot-disabled"}`} />
          <span className="text-[14px] font-semibold">{running ? "Running" : "Stopped"}</span>
          <span className="ml-auto text-[11px]" style={{ color: "var(--text-faint)" }}>
            Start, stop and port are on <b>Control → Gateway</b>
          </span>
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
              {status?.hasKey ? "Stored in your OS keychain. Shown once on generation; reveal = copy to clipboard (never shown here)." : "None yet — starting the gateway on Control generates one."}
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
      </section>

      <section className="mt-4 rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <h2 className="mb-1 text-[14px] font-semibold">Per-app keys</h2>
        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Give each connected app its own key so you can cut one off without rotating the master key — and without
          breaking every other app. The secret is shown once, by copying it to your clipboard; only the label is kept.
          Revoking takes effect on the very next request. A key can also carry its own monthly budget, which stops
          that one app without touching anyone else's.
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
                  {/*
                    The budget is per-*key*, so it lives on the key's row rather than on Control
                    beside the global cap — the same ownership rule that put the master key and the
                    per-app keys here. A revoked key keeps no budget control: it cannot spend, so a
                    field offering to limit it would be a control with no effect.
                  */}
                  {k.revokedAt === null && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span
                        className="text-[11px]"
                        style={{
                          color:
                            k.capMicros !== null && k.monthMicros >= k.capMicros
                              ? "var(--danger)"
                              : "var(--text-faint)",
                        }}
                      >
                        {usd(k.monthMicros)} this month
                        {k.capMicros !== null ? ` of ${usd(k.capMicros)}` : " · no budget"}
                      </span>
                      <input
                        className="mono w-20 rounded border px-1.5 py-0.5 text-[11px] outline-none focus:brightness-125"
                        style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
                        placeholder="budget"
                        inputMode="decimal"
                        aria-label={`Monthly budget in USD for ${k.label}`}
                        value={capDrafts[k.id] ?? ""}
                        onChange={(e) =>
                          setCapDrafts((d) => ({ ...d, [k.id]: e.target.value.replace(/[^\d.]/g, "") }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveAppKeyCap(k.id);
                        }}
                      />
                      <Button variant="ghost" onClick={() => void saveAppKeyCap(k.id)}>
                        {k.capMicros !== null ? "Update" : "Set budget"}
                      </Button>
                      {k.capMicros !== null && (
                        <Button variant="ghost" onClick={() => void clearAppKeyCap(k.id)}>Clear</Button>
                      )}
                    </div>
                  )}
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
          <li>Every request is logged in Activity under source <span className="mono">gateway</span>. Wrong key → 401; router busy → 429; app closed → 503; a spend limit reached → 402, and the body names which: <span className="mono">spend_cap_exceeded</span> for the global cap, <span className="mono">app_budget_exceeded</span> for one app's own.</li>
          <li>Per-app keys are checked alongside the master key, and revocation lands on the next request. A failed
            attempt never slows down a caller with a valid key.</li>
          <li>Four compatible surfaces — one master key: <b>OpenAI Chat</b> (<span className="mono">/v1/chat/completions</span>, <span className="mono">/v1/models</span>, <span className="mono">/v1/images/generations</span>) · <b>OpenAI Responses</b> (<span className="mono">/v1/responses</span>) · <b>Anthropic Messages</b> (<span className="mono">/v1/messages</span>, auth via <span className="mono">x-api-key</span> — Claude Code / anthropic-sdk) · <b>Gemini</b> (<span className="mono">/v1beta/models/&lt;model&gt;:generateContent</span> + <span className="mono">?alt=sse</span> streaming, auth via <span className="mono">x-goog-api-key</span> or <span className="mono">?key=</span>).</li>
          <li>Tools/tool_choice/response_format are forwarded to upstream providers when enabled. Legacy <code className="mono">functions</code> parameters (deprecated OpenAI style) are always rejected.</li>
        </ul>
      </section>

      {/*
        Pointers, not copies. Every switch that used to be on this screen now lives on Control, for
        the same reason this screen's own copy gives about per-app keys: a value rendered in two
        places has two sources of truth, and they drift. What is left here is the per-*thing* half —
        the master key, the per-app keys, the endpoint, and the snippets you paste into a client.
      */}
      <p className="mt-4 text-[11px]" style={{ color: "var(--text-faint)" }}>
        The gateway's on/off switch, its port and the <b>global</b> monthly spend cap live on the{" "}
        <b>Control</b> screen under <b>Gateway</b>; the tool switches — including writes and
        commands — are under <b>Tools</b>, where they persist across restarts. A <b>per-app</b>{" "}
        budget stays here, on the key it limits: it is a property of one app, not of the gateway.
      </p>
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

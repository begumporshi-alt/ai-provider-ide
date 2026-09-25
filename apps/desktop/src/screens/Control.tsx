/**
 * Control — the unified switchboard (`CONTROL_SWITCHBOARD_DESIGN.md`).
 *
 * Owns the **cross-cutting, set-once** switches, plus the telemetry that keeps them honest. It does
 * *not* own per-entity controls: per-provider enable lives on the provider card, per-memory scope and
 * pin in Memory, per-app key revoke in Gateway, expose/unexpose a model in Models. Control **links
 * out** instead of duplicating, because mirroring one value in two places gives it two sources of
 * truth — they drift, and then the switchboard lies about the system state.
 *
 * The screen's real job is answering **"is anything wrong?"** in about three seconds, so findings
 * lead each tab (§4.4). The hard part is that a switch which is off *by choice* is not a problem, and
 * the app cannot read intent. The injection telemetry supplies the missing evidence: `no_candidates`
 * arriving while memory is off is what turns a neutral state into a warning. That is why the ring
 * buffer in `injection_log.rs` had to exist before this screen could be honest.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clampConcurrency, MAX_PER_PROVIDER } from "@aiprovider/router-core";
import { Button, EmptyState, StatusDot, type Health } from "../components/atoms";
import {
  bootstrap,
  gatewayInjectionStats,
  gatewayLogTail,
  gatewayMemoryEnabled,
  gatewayMutationEnabled,
  gatewaySpendStatus,
  gatewayStatus,
  gatewayToolsEnabled,
  memoryStats,
  patchGatewaySettings,
  persistRouterSettings,
  readGatewaySettings,
  router,
  serviceInstall,
  serviceStatus,
  serviceUninstall,
  setGatewayMutationEnabled,
  setGatewayToolsEnabled,
  type GatewayLogLine,
  type GatewaySpendStatus,
  type GatewayStatus,
  type InjectionEvent,
  type InjectionStats,
  type MemoryStats,
  type ServiceStatus,
} from "../store";
import { usd } from "../lib/format";
import { fetchAdmin } from "../lib/gateway-client";
import { useUi } from "../ui-state";

// ---------- vocabulary ----------

/**
 * §4.2. The raw skip reasons are precise but opaque; layer 1 speaks plainly. Layer 2 always shows the
 * raw token beside the plain words so the two layers stay reconcilable.
 */
const REASON: Record<string, string> = {
  injected: "Used",
  no_candidates: "Nothing matched this question",
  principal_off: "Off for this app",
  client_off: "The app asked for no memory",
  write_only: "The app asked to record only, not to be reminded",
  disabled: "Memory is switched off",
  no_project: "Couldn't tell which project this is",
  below_floor: "Found facts, but none fitted the budget",
  deadline: "Too slow, skipped to keep the reply fast",
};

const reasonLabel = (raw: string) => REASON[raw] ?? raw;

type TabId = "gateway" | "memory" | "tools" | "routing";

const TABS: { id: TabId; label: string }[] = [
  { id: "gateway", label: "Gateway" },
  { id: "memory", label: "Memory & context" },
  { id: "tools", label: "Tools" },
  { id: "routing", label: "Routing" },
];

// ---------- findings (§4.4) ----------

type Severity = "blocker" | "warning";

interface Finding {
  id: string;
  severity: Severity;
  /** Names the *condition*. */
  title: string;
  /** Names the **evidence**. A blocker without evidence is a state, not a reason to act. */
  evidence: string;
  tab: TabId;
}

function findings(d: ControlData): Finding[] {
  const out: Finding[] = [];
  const g = d.gateway;

  // Blockers are things that *failed*, not things that are switched off.
  if (g?.running && !g.hasKey) {
    out.push({
      id: "no-master-key",
      severity: "blocker",
      tab: "gateway",
      title: "The gateway is serving with no master key",
      evidence: "Every client request is refused with 401 until a key exists.",
    });
  }

  const total = d.injection?.total ?? 0;
  const injected = d.injection?.counts.injected ?? 0;
  const noCandidates = d.injection?.counts.no_candidates ?? 0;

  // Warnings are "off, with evidence it is wanted".
  if (d.memory === false && total > 0) {
    out.push({
      id: "memory-off-but-used",
      severity: "warning",
      tab: "memory",
      title: "Memory is switched off, but requests keep arriving",
      evidence: `${total} request${total === 1 ? "" : "s"} recorded since launch, none injected.`,
    });
  }
  if (d.memory === true && total > 0 && injected === 0) {
    out.push({
      id: "memory-on-nothing-injected",
      severity: "warning",
      tab: "memory",
      title: "Memory is on, but nothing has been injected",
      evidence: `${noCandidates} of ${total} requests found no candidate facts.`,
    });
  }
  // The §5.1 hint. Surfaced, never auto-corrected: scoping a row is a deliberate act, and binding it
  // automatically would destroy the contamination guarantee (`store.rs:664-668`).
  if ((d.facts?.total ?? 0) > 0 && d.facts?.injectable === 0) {
    out.push({
      id: "nothing-scoped",
      severity: "warning",
      tab: "memory",
      title: "No fact is scoped, so none can ever be injected",
      evidence: `All ${d.facts?.total} recorded facts are capture-only. Scope one in Memory.`,
    });
  }

  return out;
}

// ---------- formatting ----------

function clock(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * `MM-DD HH:MM:SS`, local — the audit log's stamp.
 *
 * Not `clock`: that is for things that happened since the app started, where the date is today by
 * definition. The log is appended to for the life of the install and never rotated, so its lines
 * routinely come from earlier days and a bare time-of-day would read as a line from today.
 */
function logStamp(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- data ----------

interface ControlData {
  gateway: GatewayStatus | null;
  spend: GatewaySpendStatus | null;
  memory: boolean | null;
  tools: boolean | null;
  mutation: boolean | null;
  injection: InjectionStats | null;
  facts: MemoryStats | null;
  service: ServiceStatus | null;
  /** Set only when the *host itself* did not answer — a per-switch failure is reported per row. */
  hostError: string | null;
}

const EMPTY: ControlData = {
  gateway: null,
  spend: null,
  memory: null,
  tools: null,
  mutation: null,
  injection: null,
  facts: null,
  service: null,
  hostError: null,
};

/**
 * Load every value the screen reads.
 *
 * Each read settles independently: one command failing must not blank the whole screen. That is the
 * same fail-soft shape the other screens use, and it is what makes §4.3's "single switch fails" state
 * renderable at all.
 */
function useControlData(tick: number) {
  const [data, setData] = useState<ControlData>(EMPTY);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [gateway, spend, memory, tools, mutation, injection, facts, service] = await Promise.all([
      gatewayStatus().catch(() => null),
      gatewaySpendStatus().catch(() => null),
      gatewayMemoryEnabled().catch(() => null),
      gatewayToolsEnabled().catch(() => null),
      gatewayMutationEnabled().catch(() => null),
      gatewayInjectionStats().catch(() => null),
      memoryStats().catch(() => null),
      serviceStatus().catch(() => null),
    ]);
    setData({
      gateway,
      spend,
      memory,
      tools,
      mutation,
      injection,
      facts,
      service,
      hostError:
        gateway === null && memory === null
          ? "The app's host process did not answer. Switches are disabled until it does."
          : null,
    });
    setLoading(false);
  }, []);

  /**
   * Re-read only what the gateway poll needs.
   *
   * The gateway is the one subject on this screen that changes while the operator does nothing: the
   * worker's beat lapses after ~8 idle minutes, another process takes the port, a connected IDE
   * crosses the monthly cap. `tick` is bumped by user actions alone, so a tab that showed gateway
   * state without a clock of its own would freeze at whatever it read when the screen opened.
   *
   * It is deliberately **not** a second call to `load()`: that would re-run `memory_stats` — a
   * SQLite aggregate — every 2.5 seconds for the sake of a status dot. Two commands, merged into
   * the slice they belong to.
   *
   * `hostError` is left alone. It is derived from several reads, and one command failing while the
   * host is alive is §4.3's per-row failure, not a dead host.
   */
  const refreshGateway = useCallback(async () => {
    const [gateway, spend] = await Promise.all([
      gatewayStatus().catch(() => null),
      gatewaySpendStatus().catch(() => null),
    ]);
    setData((prev) => ({ ...prev, gateway, spend }));
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  return { data, loading, refreshGateway };
}

// ---------- primitives ----------

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      {title && (
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** §4.3: a skeleton rather than a zero, because a zero is a claim and we do not have one yet. */
function Metric({ label, value, hint, loading }: { label: string; value: React.ReactNode; hint?: string; loading?: boolean }) {
  return (
    <Card>
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>{label}</div>
      {loading ? (
        <div className="mt-1.5 h-[18px] w-16 animate-pulse rounded" style={{ background: "var(--surface-2)" }} />
      ) : (
        <div className="mono mt-0.5 text-[18px]">{value}</div>
      )}
      {hint && !loading && <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>{hint}</div>}
    </Card>
  );
}

/**
 * A switch row.
 *
 * §4.5: **the control never shows a state the host has not confirmed.** `checked` is owned by the
 * parent, and the parent only updates it after the host answers — so a failed apply leaves the row on
 * its previous value *and* shows an inline error. A toggle that appears to have flipped when the port
 * bind failed is worse than a spinner.
 */
function SwitchRow({
  label,
  state,
  hint,
  checked,
  onChange,
  slow,
  error,
  disabled,
}: {
  label: string;
  /**
   * The host's own word for the current state ("Running" / "Stopped"), shown beside the label.
   *
   * Separate from `label` on purpose: a switch's **accessible name must not change with its
   * state** — `aria-checked` is what carries that, and a screen reader announcing a control whose
   * name flips between "Running" and "Stopped" cannot tell the name from the value. The visible
   * word still matters though: it is the state, in the operator's vocabulary, and
   * `gateway-status.spec.ts` asserts this exact text.
   */
  state?: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void | Promise<void>;
  /** Binds a port or writes to disk — worth a pending state. In-memory switches flip instantly. */
  slow?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const commit = async (v: boolean) => {
    if (!slow) {
      await onChange(v);
      return;
    }
    setBusy(true);
    try {
      await onChange(v);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px]">
            {label}
            {state && <span style={{ color: "var(--text-dim)" }}>{state}</span>}
          </div>
          {hint && <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>{hint}</div>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled || busy}
          onClick={() => void commit(!checked)}
          className="relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full transition-colors disabled:opacity-40"
          style={{
            background: checked ? "var(--accent)" : "var(--surface-2)",
            border: "1px solid var(--border)",
          }}
        >
          <span
            className="absolute top-[1px] h-[13px] w-[13px] rounded-full transition-all"
            style={{ left: checked ? 16 : 1, background: checked ? "#0b0d10" : "var(--text-faint)" }}
          />
        </button>
      </div>
      {busy && <div className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>Applying…</div>}
      {error && <div className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>{error}</div>}
    </div>
  );
}

/** §4.4: findings lead the tab, and each names its evidence. */
function Findings({ list, onGo }: { list: Finding[]; onGo: (t: TabId) => void }) {
  if (list.length === 0) return null;
  return (
    <div className="mb-3 space-y-2">
      {list.map((f) => (
        <div
          key={f.id}
          className="flex items-start gap-2 rounded-md border p-2.5"
          style={{
            background: "var(--surface)",
            borderColor: f.severity === "blocker" ? "var(--danger)" : "var(--border)",
          }}
        >
          <StatusDot health={f.severity === "blocker" ? "unavailable" : "degraded"} />
          <div className="min-w-0">
            <div className="text-[13px]">{f.title}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-dim)" }}>{f.evidence}</div>
          </div>
          <button
            className="ml-auto shrink-0 text-[11px]"
            style={{ color: "var(--text-faint)" }}
            onClick={() => onGo(f.tab)}
          >
            {TABS.find((t) => t.id === f.tab)?.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * §4.1 layer 2. Raw detail stays behind a disclosure so layer 1 reads cleanly.
 *
 * The toggle is owned by the screen rather than each tab, so switching tabs collapses it — carrying
 * layer 2 open into a tab the reader has not looked at yet shows raw tokens before the plain sentence
 * that explains them.
 */
function Detail({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <Button variant="ghost" onClick={onToggle}>{open ? "Hide detail" : "Show detail"}</Button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1 text-[12px] last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <span style={{ color: "var(--text-faint)" }}>{k}</span>
      <span className="mono text-right">{v}</span>
    </div>
  );
}

interface TabProps {
  detail: boolean;
  onToggle: () => void;
}

// ---------- tabs ----------

function GatewayTab({
  d,
  loading,
  detail,
  onToggle,
  refreshGateway,
}: TabProps & { d: ControlData; loading: boolean; refreshGateway: () => void }) {
  const go = useUi((s) => s.go);
  const g = d.gateway;
  const running = g?.running ?? false;

  // The port field is a *draft*: seeded once from the row the host restores at launch, then owned by
  // the operator until they commit it. Re-seeding it on every poll would fight typing.
  const [port, setPort] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [capInput, setCapInput] = useState("");
  const [capError, setCapError] = useState<string | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  /**
   * The gateway's own clock. This tab mounts only while it is the selected one, so the interval
   * exists only while someone can see the thing it refreshes.
   */
  useEffect(() => {
    const t = window.setInterval(refreshGateway, 2500);
    return () => window.clearInterval(t);
  }, [refreshGateway]);

  useEffect(() => {
    readGatewaySettings()
      .then((s) => setPort(String(s.port ?? 8787)))
      .catch(() => setPort("8787"));
  }, []);

  /**
   * Mirror the persisted cap into the field.
   *
   * Keyed on the **number**, not on `d.spend`: the poll hands back a fresh object every 2.5 seconds,
   * so an effect keyed on the object would re-run constantly and erase a half-typed cap. A number
   * only changes when the cap really changed.
   */
  const capMicros = d.spend?.capMicros ?? null;
  useEffect(() => {
    if (capMicros === null) return;
    setCapInput(capMicros > 0 ? String(capMicros / 1_000_000) : "");
  }, [capMicros]);

  async function toggle(next: boolean) {
    setSwitchError(null);
    try {
      // `Number("")` is 0 and `0` is falsy, so an emptied field means "the host's default" — the
      // same reading the old screen had, kept deliberately.
      const portNum = Number(port) || undefined;
      if (next) {
        await invoke("gateway_enable", { port: portNum });
        await patchGatewaySettings({ port: portNum, enabled: true });
        if (!g?.hasKey) await invoke("gateway_key_generate");
        // A boot that could not reach the gateway left every screen empty, and this is the recovery
        // the shell's notice points at — so retry the reads here instead of making the user
        // relaunch. A no-op when the boot already succeeded (`bootstrap` is guarded).
        //
        // Swallowed on purpose: the gateway did start, and `bootstrap` records its own reason, so a
        // failure here is still visible in the shell rather than only in this screen's error slot.
        await bootstrap().catch(() => undefined);
        useUi.getState().bump();
      } else {
        await invoke("gateway_disable");
        // Persist the off state too: "enabled" is what startup restores, so leaving a stale `true`
        // behind would start the gateway again on the next launch.
        await patchGatewaySettings({ port: portNum, enabled: false });
      }
      await refreshGateway();
    } catch (e) {
      setSwitchError(String(e)); // invariant 16: a squatted port surfaces here, loudly
    }
  }

  /** `override` bypasses the field (Disable) — setState is async, so it cannot be read back here. */
  async function saveCap(override?: number) {
    setCapError(null);
    const micros =
      override ??
      (() => {
        const usdValue = Number(capInput);
        if (capInput.trim() === "" || !Number.isFinite(usdValue)) return 0;
        return Math.max(0, Math.round(usdValue * 1_000_000));
      })();
    try {
      // The route clamps at 0 as the command did, so the two agree on what a negative cap means.
      await fetchAdmin("POST", "/admin/spend/cap", { capMicros: micros });
      setCapInput(micros > 0 ? String(micros / 1_000_000) : "");
      await refreshGateway();
    } catch (e) {
      setCapError(String(e));
    }
  }

  const health: Health = !g ? "unknown" : g.running ? "healthy" : "disabled";

  // "Serving" is the whole state now. It used to be qualified by the worker's beat — awake or
  // asleep — which is how the UI ended up describing a healthy gateway as degraded.
  const serving = g?.running ? "serving" : "stopped";

  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Metric
          label="Gateway"
          loading={loading}
          value={<span className="flex items-center gap-2"><StatusDot health={health} />{g?.running ? "On" : "Off"}</span>}
          hint={serving}
        />
        <Metric
          label="Endpoint"
          loading={loading}
          value={`:${g?.port ?? "—"}`}
          hint={g?.endpointUrl ?? undefined}
        />
        <Metric
          label="Spend this month"
          loading={loading}
          value={d.spend ? usd(d.spend.monthMicros) : "—"}
          hint={d.spend?.capped ? `capped at ${usd(d.spend.capMicros)}` : "no cap set"}
        />
      </div>

      <Card title="Gateway">
        <SwitchRow
          label="Gateway"
          state={running ? "Running" : "Stopped"}
          hint="Binds 127.0.0.1 only. Starting with no master key generates one, host-side, and copies it to your clipboard — it is never rendered in this window."
          checked={running}
          slow
          disabled={d.hostError !== null || g === null}
          error={switchError}
          onChange={toggle}
        />

        <div className="py-2.5">
          <div className="text-[13px]">Port</div>
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
            Remembered across restarts. It cannot be changed while the gateway is running — the host
            owns the listener, so a field that disagreed with the bound socket would be a lie.
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              className="mono w-24 rounded border px-2 py-1 text-[13px] outline-none focus:brightness-125 disabled:opacity-50"
              style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
              value={port ?? ""}
              disabled={running || port === null}
              inputMode="numeric"
              aria-label="Gateway port"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            />
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {running ? "bound now" : "takes effect when you start the gateway"}
            </span>
          </div>
        </div>

        {switchError !== null && /cannot bind/.test(switchError) && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
            Another process owns that port. Pick a different port above and start the gateway. The
            default 8787 is fixed so app URLs stay predictable, so a local process can squat it — a
            documented v1 trade-off.
          </p>
        )}
      </Card>

      <div className="mt-3">
        <Card title="Login-item service">
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Runs the gateway as a system service, so it stays up after you quit the app. The service
            and the in-app gateway bind the same port — only one can run at a time. Installing the
            service while the app gateway is running is a bind conflict, not a handover.
          </p>
          {(() => {
            const s = d.service;
            const installed = s?.plistPresent ?? false;
            const loaded = s?.loaded ?? false;
            const pid = s?.pid ?? null;
            return (
              <div className="mt-2">
                <div className="flex items-center gap-3 text-[13px]">
                  <StatusDot health={loaded ? "healthy" : installed ? "degraded" : "unavailable"} />
                  <span>
                    {s === null
                      ? "—"
                      : loaded
                        ? `Running${pid !== null ? ` (pid ${pid})` : ""}`
                        : installed
                          ? "Installed, not running"
                          : "Not installed"}
                  </span>
                </div>
                {running && installed && !loaded && (
                  <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
                    The app gateway is running and owns the port. Stop it before starting the service,
                    or the service will fail to bind.
                  </p>
                )}
                {serviceError && (
                  <p className="mt-1.5 text-[11px]" style={{ color: "var(--danger)" }}>{serviceError}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {!installed ? (
                    <Button
                      disabled={serviceBusy || d.hostError !== null}
                      onClick={() => {
                        setServiceError(null);
                        setServiceBusy(true);
                        serviceInstall()
                          .then(() => refreshGateway())
                          .catch((e) => setServiceError(String(e)))
                          .finally(() => setServiceBusy(false));
                      }}
                    >
                      {serviceBusy ? "Installing…" : "Install"}
                    </Button>
                  ) : (
                    <Button
                      variant="danger"
                      disabled={serviceBusy || d.hostError !== null}
                      onClick={() => {
                        setServiceError(null);
                        setServiceBusy(true);
                        serviceUninstall()
                          .then(() => refreshGateway())
                          .catch((e) => setServiceError(String(e)))
                          .finally(() => setServiceBusy(false));
                      }}
                    >
                      {serviceBusy ? "Removing…" : "Remove"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}
        </Card>
      </div>

      <div className="mt-3">
        <Card title="Monthly spend cap">
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Stops a runaway consumer — an agent loop in a connected IDE — from spending past a budget.
            Month-to-date is measured from the ledger at the UTC month boundary and counts <b>all</b>{" "}
            router usage (Assistant and generator included), not just gateway traffic, so it is a real
            ceiling on what you pay. Reached, the gateway answers 402 instead of forwarding. Leave it
            blank to disable.
          </p>
          <div className="mt-2 flex items-end gap-4">
            <div>
              <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>This month</span>
              <span className="mono text-[15px] font-semibold" style={{ color: d.spend?.capped ? "var(--danger)" : "var(--text)" }}>
                {d.spend ? usd(d.spend.monthMicros) : "—"}
              </span>
            </div>
            <div>
              <span className="mb-1 block text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>Cap (USD)</span>
              <div className="flex items-center gap-2">
                <input
                  className="mono w-28 rounded border px-2 py-1 text-[13px] outline-none focus:brightness-125"
                  style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
                  value={capInput}
                  placeholder="none"
                  inputMode="decimal"
                  aria-label="Monthly spend cap in USD"
                  onChange={(e) => setCapInput(e.target.value.replace(/[^\d.]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveCap();
                  }}
                />
                <Button onClick={() => void saveCap()}>{d.spend?.capMicros ? "Update" : "Set cap"}</Button>
                {d.spend?.capMicros ? (
                  <Button variant="ghost" onClick={() => void saveCap(0)}>Disable</Button>
                ) : null}
              </div>
            </div>
          </div>
          {capError && <div className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>{capError}</div>}
          {d.spend?.capped && (
            <div className="mt-2 rounded border px-3 py-2 text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              Cap reached — the gateway is refusing requests with 402 until the month rolls over or you
              raise the cap.
            </div>
          )}
        </Card>
      </div>

      <div className="mt-3">
        <Card title="Gateway state">
          <div className="text-[12px]">
            <KeyValue k="Master key" v={g?.hasKey ? "present" : "missing"} />
          </div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
            The master key, the per-app keys, the endpoint URL and the copy-paste presets stay on{" "}
            <strong style={{ color: "var(--text-dim)" }}>Local Gateway</strong> — that is the screen
            you open when you are connecting something. The switches are here because this is the
            screen you open when something is wrong.
          </p>
          <div className="mt-2">
            <Button onClick={() => go("gateway")}>Open Local Gateway</Button>
          </div>
        </Card>
      </div>

      <Detail open={detail} onToggle={onToggle}>
        <Card>
          <div className="mono break-all text-[11px]" style={{ color: "var(--text-dim)" }}>
            {g?.endpointUrl ?? "—"}
          </div>
        </Card>
      </Detail>
    </div>
  );
}

function MemoryTab({ d, loading, detail, onToggle }: TabProps & { d: ControlData; loading: boolean }) {
  const go = useUi((s) => s.go);
  const inj = d.injection;
  const facts = d.facts;
  const usable = facts?.injectable ?? 0;
  const totalFacts = facts?.total ?? 0;
  const requests = inj?.total ?? 0;
  const injected = inj?.counts.injected ?? 0;

  const counts = useMemo(() => {
    const c = inj?.counts ?? {};
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [inj]);

  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Metric
          label="Facts usable"
          loading={loading}
          value={`${usable} / ${totalFacts}`}
          hint={usable === 0 && totalFacts > 0 ? "none scoped — see below" : "scoped and injectable"}
        />
        <Metric
          label="Requests recorded"
          loading={loading}
          value={requests}
          hint={inj && inj.recent.length === 0 && requests > 0 ? "detail cleared on restart" : "since launch"}
        />
        <Metric
          label="Injected"
          loading={loading}
          value={requests === 0 ? "—" : `${Math.round((injected / requests) * 100)}%`}
          hint={`${injected} of ${requests}`}
        />
      </div>

      <Card title="Memory & context">
        <div className="text-[12px]">
          <KeyValue k="Memory layer" v={d.memory === null ? "unknown" : d.memory ? "on" : "off"} />
          <KeyValue k="Across a restart" v="off again — this switch is not remembered" />
          <KeyValue k="Per-app policy" v="in Memory, beside the per-principal rows" />
        </div>
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          The switch lives on <strong style={{ color: "var(--text-dim)" }}>Memory</strong>, beside the
          notice that says what turning it on sends off this machine — the moment you flip it is the
          moment that notice matters, and a notice read somewhere else is not a notice. It is
          deliberately not duplicated here: one control, one source of truth. The 15 ms deadline and
          the recall budget are compiled-in constants, so they are reported rather than offered.
        </p>
        <div className="mt-2">
          <Button onClick={() => go("memory")}>Open Memory</Button>
        </div>
      </Card>

      <Detail open={detail} onToggle={onToggle}>
        <div className="space-y-3">
          <Card title="Why requests were skipped">
            {counts.length === 0 ? (
              <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>No requests recorded yet.</p>
            ) : (
              <div className="space-y-1">
                {counts.map(([raw, n]) => (
                  <div key={raw} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span>{reasonLabel(raw)}</span>
                    <span className="mono" style={{ color: "var(--text-faint)" }}>{n} · {raw}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Recent requests">
            {inj === null || inj.recent.length === 0 ? (
              <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                {requests > 0
                  ? "Counters survived, but the recent list is empty — it is held in memory and clears on restart."
                  : "No requests yet. Point a client at the gateway endpoint."}
              </p>
            ) : (
              <div className="space-y-1">
                {inj.recent.slice(0, 25).map((e: InjectionEvent) => (
                  <div key={`${e.id}-${e.tsMs}`} className="flex items-baseline gap-2 text-[11px]">
                    <span className="mono" style={{ color: "var(--text-faint)" }}>{clock(e.tsMs)}</span>
                    <span className="mono">{e.id}</span>
                    <span className="truncate" style={{ color: "var(--text-dim)" }}>{e.model}</span>
                    <span
                      className="mono ml-auto shrink-0"
                      style={{ color: e.injected ? "var(--text)" : "var(--text-faint)" }}
                    >
                      {e.injected
                        ? `${e.items} facts · ${e.tokens} tok${e.context ? ` · ctx ${e.context}` : ""}`
                        : reasonLabel(e.reason)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </Detail>

      {usable === 0 && totalFacts > 0 && (
        <div className="mt-3">
          <Button onClick={() => go("memory")}>Open Memory to scope a fact</Button>
        </div>
      )}
    </div>
  );
}

function ToolsTab({ d, loading, detail, onToggle }: TabProps & { d: ControlData; loading: boolean }) {
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);

  /**
   * The audit trail is read on demand, not with the rest of the tab.
   *
   * Every other value on this screen is a scalar the poll can refresh cheaply; this is a file read
   * behind a disclosure, and a screen that reads a log the operator never opened is paying for
   * something nobody asked to see. `null` means "not fetched yet", `[]` means "fetched, and the log
   * is empty" — the two render differently, because one is a failure to load and the other is a
   * gateway that has not run a tool yet.
   */
  const [log, setLog] = useState<GatewayLogLine[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  /**
   * Whether a read has been attempted — separate from `log !== null` because a **failed** read leaves
   * `log` null too, so keying the trigger on it would retry in a loop for as long as the read keeps
   * failing.
   */
  const [logTried, setLogTried] = useState(false);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      setLog(await gatewayLogTail(50));
    } catch (e) {
      // Clear rather than keep the previous lines. §4.3's rule for a metric that has not loaded
      // applies to a list too: a stale tail rendered under a failure notice is a claim about now,
      // and the one thing this card cannot do is claim a line is current when the read that would
      // have shown it is the read that failed.
      setLog(null);
      setLogError(String(e));
    } finally {
      setLogLoading(false);
    }
  }, []);

  // Opening the disclosure is the operator asking for the log, so that is when it is read — and it
  // is read once. A refresh after that is an explicit click.
  useEffect(() => {
    if (detail && !logTried) {
      setLogTried(true);
      void loadLog();
    }
  }, [detail, logTried, loadLog]);

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Metric
          label="Tools"
          loading={loading}
          value={d.tools === null ? "—" : d.tools ? "On" : "Off"}
          hint="Read-only tools, plus a client's own tools"
        />
        <Metric
          label="Writes & commands"
          loading={loading}
          value={d.mutation === null ? "—" : d.mutation ? "Allowed" : "Blocked"}
          hint="write_file · run_command"
        />
      </div>

      <Card title="Tool switches">
        <SwitchRow
          label="Gateway tools"
          hint="Lets the gateway supply its own sandboxed registry when a client brings none. Off strips tool parameters before the request leaves, which breaks coding agents."
          checked={d.tools === true}
          disabled={d.hostError !== null || d.tools === null}
          error={toolsError}
          onChange={async (v) => {
            setToolsError(null);
            try {
              await setGatewayToolsEnabled(v);
              await patchGatewaySettings({ toolsEnabled: v });
            } catch (e) {
              setToolsError(String(e));
            }
          }}
        />
        <SwitchRow
          label="Allow writes and commands"
          hint="The Assistant asks for confirmation per call; the gateway path has no human in the loop, so this is off by default and enforced host-side."
          checked={d.mutation === true}
          disabled={d.hostError !== null || d.mutation === null}
          error={mutError}
          onChange={async (v) => {
            setMutError(null);
            try {
              await setGatewayMutationEnabled(v);
              await patchGatewaySettings({ mutationEnabled: v });
            } catch (e) {
              setMutError(String(e));
            }
          }}
        />
        <p className="pt-2.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Both persist. The memory switch does not, and it is deliberately not here — it lives on
          Memory beside the notice that says what turning it on sends off this machine, and it says
          there that it resets after a restart. One control, one source of truth.
        </p>
      </Card>

      <Detail open={detail} onToggle={onToggle}>
        <Card title="Audit trail">
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            Every gateway tool call is appended to the audit log with a digest of its arguments — paths
            and programs verbatim, file bodies reduced to a byte count so the log is not the leak it
            exists to catch. The file grows for the life of the install and is never rotated, so this
            shows the newest 50 lines of its last 128 KB.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void loadLog()} disabled={logLoading}>
              {logLoading ? "Reading…" : log === null ? "Read the log" : "Refresh"}
            </Button>
            {log !== null && log.length > 0 && !logLoading && (
              <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                {log.length} line{log.length === 1 ? "" : "s"} · newest last
              </span>
            )}
          </div>

          {logError !== null && (
            <div
              className="mt-2 rounded border px-3 py-2 text-[12px]"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              Could not read the log: {logError}
            </div>
          )}

          {/* A loaded-but-empty log is a fact about the gateway, not a failure of this card, so it
              gets its own sentence. The two branches cannot both render: a failed read clears `log`
              to null, so "we read it and there is nothing" and "we could not read it" are mutually
              exclusive by construction rather than by a second condition here. */}
          {log !== null && log.length === 0 && (
            <p className="mt-2 text-[12px]" style={{ color: "var(--text-faint)" }}>
              No tool calls recorded yet. The log is written when the gateway runs a tool, so an empty
              log means none has run — not that this failed to load.
            </p>
          )}

          {log !== null && log.length > 0 && (
            <ul
              aria-label="Gateway tool audit log"
              className="mt-2 max-h-80 overflow-auto rounded border"
              style={{ borderColor: "var(--border)" }}
            >
              {log.map((line, i) => (
                <li
                  key={`${line.tsMs ?? "untimed"}-${i}`}
                  className="flex gap-3 border-b px-2 py-1 text-[11px] last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--text-faint)" }}>
                    {line.tsMs === null ? "—" : logStamp(line.tsMs)}
                  </span>
                  <span className="mono min-w-0 break-words" style={{ color: "var(--text)" }}>
                    {line.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Detail>
    </div>
  );
}

function RoutingTab({ detail, onToggle }: TabProps) {
  const bump = useUi((s) => s.bump);
  const settings = router.settings;
  const [draft, setDraft] = useState(String(settings.perProviderConcurrency));

  const commitConcurrency = (raw: string) => {
    // Hand the raw string to `clampConcurrency` — do not pre-parse it. `Number("")` is 0, and 0 here
    // means *unlimited*, so an emptied field would silently remove the cap; the guard for that lives
    // in `clampConcurrency` (`value.trim() !== ""`), which a `Number()` call skips straight past.
    // It floors and rejects negatives itself too, so pre-parsing only loses guards.
    const next = clampConcurrency(raw);
    settings.perProviderConcurrency = next;
    router.syncConcurrency(); // take effect now, not on the next request
    persistRouterSettings();
    setDraft(String(next));
    bump();
  };

  return (
    <div>
      <Card title="Routing switches">
        <SwitchRow
          label="Provider failover"
          hint="When every key of a provider fails, continue with the next provider that carries the model."
          checked={settings.failoverEnabled}
          onChange={(v) => {
            settings.failoverEnabled = v;
            persistRouterSettings();
            bump();
          }}
        />
        <div className="py-2.5">
          <div className="text-[13px]">In-flight requests per provider</div>
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
            How many requests one provider may serve at once (0–{MAX_PER_PROVIDER}, 0 = unlimited). A
            saturated provider is skipped in favour of one that can serve, so a single degraded provider
            cannot occupy the whole budget.
          </div>
          <input
            className="mono mt-1.5 w-24 rounded border px-2 py-1 text-[13px] outline-none focus:brightness-125"
            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
            value={draft}
            inputMode="numeric"
            aria-label="In-flight requests per provider"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commitConcurrency(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitConcurrency((e.target as HTMLInputElement).value);
            }}
          />
          <span className="ml-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
            {settings.perProviderConcurrency === 0 ? "unlimited" : `of ${MAX_PER_PROVIDER}`}
          </span>
        </div>
      </Card>

      <Detail open={detail} onToggle={onToggle}>
        <Card title="Where the rest went">
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            Control owns the <em>operational</em> switches — the ones you flip in response to
            something. Router Settings keeps the <em>preferences</em>: default text and image models,
            the system AI model, and per-provider rotation. Control is about state; Settings is about
            preference.
          </p>
        </Card>
      </Detail>
    </div>
  );
}

// ---------- screen ----------

export function ControlScreen() {
  const tick = useUi((s) => s.tick);
  const { data, loading, refreshGateway } = useControlData(tick);
  const [tab, setTab] = useState<TabId>("gateway");
  const [detail, setDetail] = useState(false);

  const all = useMemo(() => findings(data), [data]);
  const mine = all.filter((f) => f.tab === tab);
  const toggleDetail = useCallback(() => setDetail((v) => !v), []);

  const selectTab = (t: TabId) => {
    setTab(t);
    setDetail(false); // see `Detail`: layer 2 does not carry across tabs
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[16px] font-semibold">Control</h1>
        <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          Cross-cutting switches, and the evidence for their state.
        </p>
        {all.length > 0 && (
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[11px]"
            style={{ background: "var(--surface-2)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
          >
            {all.length} to look at
          </span>
        )}
      </div>

      {data.hostError && (
        <div
          className="mb-3 rounded-md border p-2.5 text-[12px]"
          style={{ background: "var(--surface)", borderColor: "var(--danger)", color: "var(--text-dim)" }}
        >
          {data.hostError}
        </div>
      )}

      {/*
        Real tab semantics rather than a row of buttons. The Findings list below renders a jump
        button labelled with the target tab's own name, so "the button called Routing" was ambiguous
        — to a driver, and to a screen reader, which had no way to tell which of the two selects a
        panel. `aria-controls` is deliberately omitted: only the selected panel is mounted, so the
        other three ids would be dangling references.
      */}
      <div
        role="tablist"
        aria-label="Control sections"
        className="mb-3 flex gap-1 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        {TABS.map((t) => {
          const n = all.filter((f) => f.tab === t.id).length;
          return (
            <button
              key={t.id}
              role="tab"
              id={`control-tab-${t.id}`}
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className="-mb-px border-b-2 px-3 py-2 text-[13px]"
              style={{
                borderColor: tab === t.id ? "var(--accent)" : "transparent",
                color: tab === t.id ? "var(--text)" : "var(--text-dim)",
              }}
            >
              {t.label}
              {n > 0 && <span className="mono ml-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>{n}</span>}
            </button>
          );
        })}
      </div>

      <Findings list={mine} onGo={selectTab} />

      <div role="tabpanel" id={`control-panel-${tab}`} aria-labelledby={`control-tab-${tab}`}>
        {tab === "gateway" && (
          <GatewayTab
            d={data}
            loading={loading}
            detail={detail}
            onToggle={toggleDetail}
            refreshGateway={refreshGateway}
          />
        )}
        {tab === "memory" && <MemoryTab d={data} loading={loading} detail={detail} onToggle={toggleDetail} />}
        {tab === "tools" && <ToolsTab d={data} loading={loading} detail={detail} onToggle={toggleDetail} />}
        {tab === "routing" && <RoutingTab detail={detail} onToggle={toggleDetail} />}
      </div>

      {!loading && !data.hostError && all.length === 0 && (
        <div className="mt-4">
          <EmptyState title="Nothing needs attention. Switches are where you think they are." />
        </div>
      )}
    </div>
  );
}

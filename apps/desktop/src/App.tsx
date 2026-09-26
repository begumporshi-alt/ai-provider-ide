/**
 * AI-Provider Router — app root. Bootstraps the core from the host, then routes screens.
 */
import { useEffect, useState } from "react";
import { applyPersistedGatewaySwitches, bootstrap, systemAiModel } from "./store";
import { startCaptureDrain, stopCaptureDrain } from "./lib/memory/drain";
import { startRetention, stopRetention } from "./lib/memory/retention";
import { useUi } from "./ui-state";
import { Shell } from "./components/Shell";
import { ProvidersScreen } from "./screens/Providers";
import { ModelsScreen } from "./screens/Models";
import { AssistantScreen } from "./screens/Assistant";
import { ActivityScreen } from "./screens/Activity";
import { ContextScreen } from "./screens/Context";
import { HistoryScreen } from "./screens/History";
import { SkillsScreen } from "./screens/Skills";
import { AgentsScreen } from "./screens/Agents";
import { MemoryScreen } from "./screens/Memory";
import { SettingsScreen } from "./screens/Settings";
import { GatewayScreen } from "./screens/Gateway";
import { ControlScreen } from "./screens/Control";
import { OnboardingScreen } from "./screens/Onboarding";
import { bootFailureHint } from "./lib/boot-failure";

export default function App() {
  const screen = useUi((s) => s.screen);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  // R1: the gateway bridge no longer runs here, and since 25f it is not a webview at all — it is
  // Rust (`core/router_bridge.rs`), so UI render work and UI HMR reloads cannot touch in-flight
  // gateway requests. There is no worker window and no `GATEWAY_WINDOW` to target.
  useEffect(() => {
    bootstrap().then(
      () => setReady(true),
      (e: unknown) => setBootError(String(e)),
    );
  }, []);

  // Capture-queue drain (§3.3). Started here rather than in the Assistant because the queue is
  // filled by gateway traffic — agent IDEs the user points at the router — which never touches this
  // app's own chat at all. A screen-scoped drain would stop learning the moment Memory was not the
  // open screen. Runs on a slow interval and is stopped with the app, so there is no orphan timer.
  useEffect(() => {
    if (!ready) return;
    startCaptureDrain(systemAiModel);
    return stopCaptureDrain;
  }, [ready]);

  // Retention (§6.2). Same reasoning as the drain, and the same scope: both tables are filled by
  // gateway traffic, so a screen-scoped scheduler would stop pruning whenever Memory was not open.
  useEffect(() => {
    if (!ready) return;
    startRetention();
    return stopRetention;
  }, [ready]);

  // Persisted gateway tool switches (§6 must-have 5). The core holds them as in-memory atomics, so
  // they have to be pushed back in at startup or they silently reset to their compiled-in defaults
  // every launch — and Control would then report a state the core is not in, which is what §4.5
  // forbids. Best-effort: a failure here must not stop the UI from opening.
  useEffect(() => {
    if (!ready) return;
    void applyPersistedGatewaySwitches().catch(() => undefined);
  }, [ready]);

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-md border p-6" style={{ background: "var(--surface)", borderColor: "var(--danger)" }}>
          <h1 className="mb-2 text-[16px] font-semibold" style={{ color: "var(--danger)" }}>App data could not be opened</h1>
          <p className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>{bootError}</p>
          {/* The advice is *chosen from the error*, not asserted over it — see lib/boot-failure.ts.
              This used to prescribe the most destructive remedy the app has (restore a backup) for
              every cause, including a 429 that clears by itself. */}
          <p className="mt-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
            {bootFailureHint(bootError)}
          </p>
        </div>
      </div>
    );
  }
  if (!ready) {
    return <div className="flex h-full items-center justify-center text-[13px]" style={{ color: "var(--text-dim)" }}>Opening vault + store…</div>;
  }

  return (
    <Shell>
      {screen === "providers" && <ProvidersScreen />}
      {screen === "models" && <ModelsScreen />}
      {screen === "assistant" && <AssistantScreen />}
      {screen === "activity" && <ActivityScreen />}
      {screen === "context" && <ContextScreen />}
      {screen === "history" && <HistoryScreen />}
      {screen === "skills" && <SkillsScreen />}
      {screen === "agents" && <AgentsScreen />}
      {screen === "memory" && <MemoryScreen />}
      {screen === "settings" && <SettingsScreen />}
      {screen === "gateway" && <GatewayScreen />}
      {screen === "control" && <ControlScreen />}
      {screen === "onboarding" && <OnboardingScreen />}
    </Shell>
  );
}

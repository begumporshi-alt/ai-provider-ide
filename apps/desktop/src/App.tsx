/**
 * AI-Provider IDE — app root. Bootstraps the core from the host, then routes screens.
 */
import { useEffect, useState } from "react";
import { bootstrap } from "./store";
import { startGatewayBridge } from "./gateway-bridge";
import { useUi } from "./ui-state";
import { Shell } from "./components/Shell";
import { ProvidersScreen } from "./screens/Providers";
import { ModelsScreen } from "./screens/Models";
import { PlaygroundScreen } from "./screens/Playground";
import { ActivityScreen } from "./screens/Activity";
import { SettingsScreen } from "./screens/Settings";
import { GatewayScreen } from "./screens/Gateway";
import { OnboardingScreen } from "./screens/Onboarding";

export default function App() {
  const screen = useUi((s) => s.screen);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    bootstrap().then(
      async () => {
        await startGatewayBridge();
        setReady(true);
      },
      (e: unknown) => setBootError(String(e)),
    );
  }, []);

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-md border p-6" style={{ background: "var(--surface)", borderColor: "var(--danger)" }}>
          <h1 className="mb-2 text-[16px] font-semibold" style={{ color: "var(--danger)" }}>App data could not be opened</h1>
          <p className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>{bootError}</p>
          <p className="mt-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
            If the database is corrupt, restore from the newest dated backup (§4) — backups live next to the database file.
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
      {screen === "playground" && <PlaygroundScreen />}
      {screen === "activity" && <ActivityScreen />}
      {screen === "settings" && <SettingsScreen />}
      {screen === "gateway" && <GatewayScreen />}
      {screen === "onboarding" && <OnboardingScreen />}
    </Shell>
  );
}

/**
 * adapter-runtime (L2): resolve provider -> a ManifestInterpreter for its active manifest.
 * Holds the manifest instances and the HttpPort that executes them. Supports hot-swap (§2.10)
 * so a repaired manifest replaces the live one without a restart.
 */
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import { ManifestInterpreter } from "./manifest-interpreter.js";
import type { HttpPort } from "./ports.js";

interface RuntimeVars {
  appUrl?: string;
}

export class AdapterRuntime {
  private byProvider = new Map<string, ManifestInterpreter>();
  constructor(
    private readonly http: HttpPort,
    private readonly vars: RuntimeVars = {},
  ) {}

  /** Register (or hot-swap) a provider's active manifest. */
  register(providerId: string, manifest: AdapterManifest): void {
    this.byProvider.set(
      providerId,
      new ManifestInterpreter(manifest, { http: this.http, vars: { appUrl: this.vars.appUrl ?? "https://aiprovider.ide" } }),
    );
  }

  unregister(providerId: string): void {
    this.byProvider.delete(providerId);
  }

  async forProvider(providerId: string): Promise<{ interpreter: ManifestInterpreter; baseUrl: string }> {
    const interp = this.byProvider.get(providerId);
    if (!interp) throw new Error(`no active manifest for provider ${providerId}`);
    return { interpreter: interp, baseUrl: interp.manifest.provider.baseUrl };
  }
}

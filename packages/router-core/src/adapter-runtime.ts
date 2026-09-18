/**
 * adapter-runtime (L2): resolve provider -> the AdapterInstance for its active manifest.
 * Declarative manifests run through the ManifestInterpreter; kind:"code" manifests run in
 * the QuickJS sandbox (§2.7). Both implement the same key-blind seam, so everything above
 * (execution-engine, model-catalog, contract-suite) never branches on manifest kind.
 * Supports hot-swap (§2.10): a repaired manifest replaces the live one without a restart,
 * and the superseded adapter is disposed so its sandbox — if any — releases the WASM
 * context instead of leaking it across swaps.
 */
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import { ManifestInterpreter } from "./manifest-interpreter.js";
import { CodeAdapterInstance } from "./code-adapter.js";
import type { AdapterInstance } from "./adapter-instance.js";
import type { HttpPort } from "./ports.js";

interface RuntimeVars {
  appUrl?: string;
}

export class AdapterRuntime {
  private byProvider = new Map<string, AdapterInstance>();
  constructor(
    private readonly http: HttpPort,
    private readonly vars: RuntimeVars = {},
  ) {}

  /** Register (or hot-swap) a provider's active manifest. */
  register(providerId: string, manifest: AdapterManifest): void {
    const superseded = this.byProvider.get(providerId);
    if (superseded) void superseded.dispose?.();
    this.byProvider.set(providerId, this.build(manifest));
  }

  unregister(providerId: string): void {
    const existing = this.byProvider.get(providerId);
    if (existing) void existing.dispose?.();
    this.byProvider.delete(providerId);
  }

  async forProvider(providerId: string): Promise<{ adapter: AdapterInstance; baseUrl: string }> {
    const adapter = this.byProvider.get(providerId);
    if (!adapter) throw new Error(`no active manifest for provider ${providerId}`);
    return { adapter, baseUrl: adapter.manifest.provider.baseUrl };
  }

  /** Release every held adapter (sandbox contexts included) — shutdown only. */
  dispose(): void {
    for (const adapter of this.byProvider.values()) void adapter.dispose?.();
    this.byProvider.clear();
  }

  private build(manifest: AdapterManifest): AdapterInstance {
    return manifest.kind === "code"
      ? new CodeAdapterInstance(manifest, { http: this.http })
      : new ManifestInterpreter(manifest, {
          http: this.http,
          vars: { appUrl: this.vars.appUrl ?? "https://aiprovider.router" },
        });
  }
}

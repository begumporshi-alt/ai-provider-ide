/**
 * config export/import (spec req. 14): the full portable configuration — providers,
 * manifests, aliases, settings, and key REFERENCES — never keychain secrets. The import
 * validator rejects any raw `secret` field (fail loud, don't silently drop), forces
 * providers to `draft` and keys to `invalid` so the re-enter-key flow runs on the new
 * machine (audit H7).
 */

export const CONFIG_FORMAT_VERSION = 1;

export interface ExportKeyRow {
  id: string;
  providerId: string;
  label: string;
  secretRef: string;
  secretHint: string | null;
}
export interface ExportProviderRow {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  baseUrl: string;
  status: string;
  rotationStrategy: string;
}
export interface ExportManifestRow {
  id: string;
  providerId: string;
  version: number;
  origin: string;
  bodyJson: string;
}
export interface ExportAliasRow {
  alias: string;
  providerId: string;
  nativeModelId: string;
  priority: number;
}
export interface ExportSettingRow {
  key: string;
  valueJson: string;
}

export interface ConfigExport {
  formatVersion: number;
  exportedAt: number;
  providers: ExportProviderRow[];
  keys: ExportKeyRow[];
  manifests: ExportManifestRow[];
  aliases: ExportAliasRow[];
  settings: ExportSettingRow[];
}

export interface ImportReport {
  ok: boolean;
  errors: string[];
  summary?: { providers: number; keys: number; manifests: number };
}

/** Recursively reject any "secret"-named key — an export file must never carry credentials. */
function findSecretFields(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findSecretFields(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "secret") out.push(`${path}.${k}`);
      findSecretFields(v, `${path}.${k}`, out);
    }
  }
}

export function validateImport(text: string): ImportReport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  const errors: string[] = [];
  findSecretFields(doc, "$", errors);
  if (errors.length) return { ok: false, errors: [`raw secret fields present (rejected): ${errors.join(", ")}`] };
  const d = doc as Partial<ConfigExport>;
  if (typeof d !== "object" || d === null) return { ok: false, errors: ["not an object"] };
  if (d.formatVersion !== CONFIG_FORMAT_VERSION) {
    errors.push(`formatVersion must be ${CONFIG_FORMAT_VERSION}, got ${JSON.stringify(d.formatVersion)}`);
  }
  for (const arr of ["providers", "keys", "manifests"] as const) {
    if (!Array.isArray(d[arr])) errors.push(`${arr} must be an array`);
  }
  if (!errors.length) {
    // required fields sanity on providers/keys
    for (const p of (d.providers ?? []) as ExportProviderRow[]) {
      if (!p?.id || !p?.slug || !/^https?:\/\//.test(p?.baseUrl ?? "")) {
        errors.push(`provider row invalid: ${JSON.stringify(p).slice(0, 120)}`);
      }
    }
    for (const k of (d.keys ?? []) as ExportKeyRow[]) {
      if (!k?.id || !k?.providerId || !k?.secretRef) errors.push(`key row invalid: ${JSON.stringify(k).slice(0, 120)}`);
    }
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 8) };
  return {
    ok: true,
    errors: [],
    summary: {
      providers: (d.providers ?? []).length,
      keys: (d.keys ?? []).length,
      manifests: (d.manifests ?? []).length,
    },
  };
}

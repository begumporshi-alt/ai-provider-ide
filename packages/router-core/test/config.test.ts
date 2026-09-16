import { describe, expect, it } from "vitest";
import { CONFIG_FORMAT_VERSION, validateImport } from "../src/config.js";

const validExport = {
  formatVersion: CONFIG_FORMAT_VERSION,
  exportedAt: 1726400000000,
  providers: [
    { id: "p1", slug: "acme", name: "Acme AI", type: "manifest", baseUrl: "https://api.acme.dev/v1", status: "enabled", rotationStrategy: "round_robin" },
  ],
  keys: [{ id: "k1", providerId: "p1", label: "key-01", secretRef: "key:p1-k1", secretHint: "••••7A2F" }],
  manifests: [{ id: "m1", providerId: "p1", version: 1, origin: "builtin-template", bodyJson: "{}" }],
  aliases: [{ alias: "fast-chat", providerId: "p1", nativeModelId: "acme-fast", priority: 1 }],
  settings: [{ key: "router", valueJson: "{}" }],
};

describe("config export/import validation", () => {
  it("accepts a well-formed export", () => {
    const r = validateImport(JSON.stringify(validExport));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ providers: 1, keys: 1, manifests: 1 });
  });

  it("rejects invalid JSON", () => {
    const r = validateImport("{not json");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  it("rejects any raw secret field, at any depth (fail loud, not silent drop)", () => {
    const cases = [
      { ...structuredClone(validExport), keys: [{ id: "k1", providerId: "p1", label: "k", secretRef: "key:k", secret: "sk-live-123" }] },
      { ...structuredClone(validExport), providers: [{ ...validExport.providers[0], nested: { deep: [{ secret: "x" }] } }] },
    ];
    for (const doc of cases) {
      const r = validateImport(JSON.stringify(doc));
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatch(/raw secret fields present/);
    }
  });

  it("rejects a wrong formatVersion", () => {
    const r = validateImport(JSON.stringify({ ...validExport, formatVersion: 99 }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/formatVersion must be/);
  });

  it("rejects provider rows without an http(s) baseUrl and keys without a secretRef", () => {
    const doc = structuredClone(validExport);
    (doc.providers[0] as Record<string, unknown>).baseUrl = "ftp://nope";
    (doc.keys[0] as Record<string, unknown>).secretRef = "";
    const r = validateImport(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects when providers/keys/manifests are missing or not arrays", () => {
    const r = validateImport(JSON.stringify({ formatVersion: CONFIG_FORMAT_VERSION }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/must be an array/)]));
  });
});

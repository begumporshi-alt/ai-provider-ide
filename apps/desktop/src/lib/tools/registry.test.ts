/**
 * registry.test.ts — the tool registry's shape, asserted as invariants.
 *
 * A malformed entry here does not fail loudly. It goes to the model as JSON schema, where the
 * failure modes are all silent: a `required` field absent from `properties` is unsatisfiable
 * under `additionalProperties:false` (the model is told to send something the schema rejects),
 * and a tool the host does not implement is a call that can only ever return an error. Neither
 * surfaces until a model tries to use it — so the checks live here instead.
 *
 * The mutating set is asserted against the Rust list in `gateway.rs` (`MUTATING_TOOLS`). That
 * constant is what keeps gateway mutation opt-in; a rename here without a rename there would
 * silently un-gate a writing tool, so the names are pinned in both places.
 */
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, registryToOpenAI } from "./registry";

/** Mirrors `MUTATING_TOOLS` in src-tauri/src/gateway.rs. Keep the two in step. */
const MUTATING = ["write_file", "edit_file", "mkdir", "run_command"];

describe("AGENT_TOOLS", () => {
  it("names are unique", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool is described, since the description is all the model is told", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.description.trim().length, t.name).toBeGreaterThan(20);
    }
  });

  it("every required field is declared in properties", () => {
    for (const t of AGENT_TOOLS) {
      for (const field of t.parameters.required ?? []) {
        expect(Object.keys(t.parameters.properties), `${t.name}.${field}`).toContain(field);
      }
    }
  });

  it("every property has a type and a description", () => {
    for (const t of AGENT_TOOLS) {
      for (const [key, raw] of Object.entries(t.parameters.properties)) {
        const spec = raw as { type?: string; description?: string };
        expect(spec.type, `${t.name}.${key}`).toBeTruthy();
        expect(spec.description?.trim().length ?? 0, `${t.name}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("the mutating set is exactly the four the gateway gates", () => {
    expect(MUTATING.filter((m) => AGENT_TOOLS.some((t) => t.name === m))).toEqual(MUTATING);
    // The complement must be read-only: a tool that is neither listed nor read-only is a
    // tool that writes without being gated.
    const readOnly = AGENT_TOOLS.filter((t) => !MUTATING.includes(t.name)).map((t) => t.name);
    expect(readOnly.sort()).toEqual(["file_info", "list_dir", "read_file", "search_files"]);
  });

  it("editing is possible without rewriting a whole file", () => {
    // The reason edit_file exists: write_file is a whole-file overwrite, so every small change
    // was expensive and destructive. If edit_file is ever dropped, this is the regression.
    expect(AGENT_TOOLS.some((t) => t.name === "edit_file")).toBe(true);
  });
});

describe("registryToOpenAI", () => {
  it("renders one function per tool and forces additionalProperties off", () => {
    const wire = registryToOpenAI(AGENT_TOOLS) as {
      type: string;
      function: { name: string; parameters: { additionalProperties: boolean; required: string[] } };
    }[];
    expect(wire).toHaveLength(AGENT_TOOLS.length);
    for (const w of wire) {
      expect(w.type).toBe("function");
      expect(w.function.parameters.additionalProperties).toBe(false);
    }
  });

  it("an empty registry yields undefined so callers can omit tools entirely", () => {
    // Some providers reject an empty `tools` array with a 400, so omitting is the only
    // correct rendering of "no tools" — not `[]`.
    expect(registryToOpenAI([])).toBeUndefined();
  });

  it("required is always an array, never undefined", () => {
    const wire = registryToOpenAI(AGENT_TOOLS) as {
      function: { parameters: { required: string[] } };
    }[];
    for (const w of wire) {
      expect(Array.isArray(w.function.parameters.required)).toBe(true);
    }
  });
});

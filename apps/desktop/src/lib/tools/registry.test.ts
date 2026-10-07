/**
 * registry.test.ts — the tool registry's shape, asserted as invariants.
 *
 * A malformed entry here does not fail loudly. It goes to the model as JSON schema, where the
 * failure modes are all silent: a `required` field absent from `properties` is unsatisfiable
 * under `additionalProperties:false` (the model is told to send something the schema rejects),
 * and a tool the host does not implement is a call that can only ever return an error. Neither
 * surfaces until a model tries to use it — so the checks live here instead.
 *
 * The mutating set is asserted against the Rust list in `gateway.rs` (`MUTATING_TOOLS`) plus the
 * frontend composites the gateway never sees. That constant is what keeps gateway mutation
 * opt-in; a rename here without a rename there would silently un-gate a writing tool, so the
 * names are pinned in both places.
 */
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, SUBAGENT_TOOLS, registryToOpenAI, toolEffect } from "./registry";

/** Mirrors `MUTATING_TOOLS` in src-tauri/src/gateway.rs. Keep the two in step. */
const GATEWAY_MUTATING = ["write_file", "edit_file", "mkdir", "run_command", "http_request", "apply_patch"];
/** Assistant-only composites the gateway never sees: `edit_notebook` is read_file + write_file
 *  assembled in the agent loop, `generate_image` writes through the base64 encoding the loop
 *  adds to write_file, `process_kill` stops a job only this sandbox's background table knows
 *  about, and the browser tools drive the debugger endpoint of the app's own process. Each is
 *  approved once as `mutate`. The gateway never sees any of them. */
const ASSISTANT_MUTATING = [
  "browser_click",
  "browser_fill",
  "browser_navigate",
  "browser_screenshot",
  "edit_notebook",
  "generate_image",
  "process_kill",
];
const MUTATING = [...GATEWAY_MUTATING, ...ASSISTANT_MUTATING];

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
    // tool that writes without being gated. `todo_write` only feeds the progress capsule —
    // it never touches the workspace — so it belongs on the read-only side.
    const readOnly = AGENT_TOOLS.filter((t) => !MUTATING.includes(t.name)).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      "browser_snapshot",
      "dispatch_agent",
      "file_info",
      "glob",
      "list_dir",
      "load_skill",
      "process_output",
      "read_document",
      "read_file",
      "read_image",
      "read_notebook",
      "search_files",
      "todo_write",
      "web_ask",
      "web_fetch",
      "web_search",
    ]);
    expect(ASSISTANT_MUTATING.every((m) => AGENT_TOOLS.some((t) => t.name === m))).toBe(true);
  });

  it("editing is possible without rewriting a whole file", () => {
    // The reason edit_file exists: write_file is a whole-file overwrite, so every small change
    // was expensive and destructive. If edit_file is ever dropped, this is the regression.
    expect(AGENT_TOOLS.some((t) => t.name === "edit_file")).toBe(true);
  });

  it("the declared effect agrees with the gateway's mutating list", () => {
    // Two descriptions of the same fact used to live in a comment and in this list. Phase 5's
    // approval modes read `effect`, so a tool that writes but declares "read" would run with no
    // prompt under "auto-approve reads" — silently, and in the direction that loses work.
    for (const t of AGENT_TOOLS) {
      const expected = MUTATING.includes(t.name) ? "mutate" : "read";
      expect(t.effect, t.name).toBe(expected);
    }
  });

  it("Assistant-only tools stay out of the gateway's registry", () => {
    // `web_ask` (answered by the loop itself — it needs a model, which the Rust tool host does
    // not have), `dispatch_agent` (a nested run of the loop itself), `load_skill` (it needs the
    // skill store) and the notebook composites (read_file + write_file assembled by the loop)
    // are frontend-registry entries with NO backend registry entry and NO sandbox handler beyond
    // a refusal. This test pins the asymmetry: if any ever appears in a backend-shaped list
    // here, the mirror invariant needs rethinking.
    expect(AGENT_TOOLS.some((t) => t.name === "web_ask")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "dispatch_agent")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "load_skill")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "read_notebook")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "edit_notebook")).toBe(true);
    // process_output/process_kill DO have sandbox handlers (background jobs live in the Rust
    // process), but only the Assistant's own loop can know what a "bg-N" id means — the gateway
    // registry keeps them out so external clients never build on the job table. Same for the
    // browser tools: the debugger endpoint they drive belongs to this app session.
    expect(AGENT_TOOLS.some((t) => t.name === "process_output")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "process_kill")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "browser_navigate")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "browser_snapshot")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "browser_click")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "browser_fill")).toBe(true);
    expect(AGENT_TOOLS.some((t) => t.name === "browser_screenshot")).toBe(true);
  });

  it("the sub-agent registry is the read-only tools minus delegation and todos", () => {
    const names = SUBAGENT_TOOLS.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("dispatch_agent");
    expect(names).not.toContain("todo_write");
    for (const t of SUBAGENT_TOOLS) {
      expect(t.effect, t.name).toBe("read");
    }
  });

  it("knows the effect of a name, and fails closed for one it does not", () => {
    expect(toolEffect("read_file")).toBe("read");
    expect(toolEffect("run_command")).toBe("mutate");
    expect(toolEffect("not_a_tool")).toBe("mutate");
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

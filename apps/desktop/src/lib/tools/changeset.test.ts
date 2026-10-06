/**
 * changeset.test.ts — checkpointing and revert, tested through a fake sandbox.
 *
 * The fake host is a tiny in-memory workspace, because the properties under test are about
 * *ordering* and *first-touch semantics* — when the old bytes are read relative to the write —
 * and those are invisible if the test only asserts on the resulting object.
 */
import { describe, expect, it } from "vitest";
import { RunCheckpoint, createCheckpointingHost, revertPlan } from "./changeset";
import type { ToolHost } from "./types";

/** An in-memory workspace with the same subset of the sandbox the checkpoint uses. */
function fakeWorkspace(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const host: ToolHost = {
    async run(name, args) {
      const path = String(args.path ?? "");
      calls.push(name);
      if (name === "read_file") {
        if (!files.has(path)) return { ok: false, output: `no such file: ${path}` };
        return { ok: true, output: files.get(path)! };
      }
      if (name === "write_file") {
        files.set(path, String(args.content ?? ""));
        return { ok: true, output: `wrote ${path}` };
      }
      if (name === "edit_file") {
        const before = files.get(path);
        if (before === undefined) return { ok: false, output: `no such file: ${path}` };
        const old = String(args.old ?? "");
        const next = String(args.new ?? "");
        files.set(path, args.replace_all === true ? before.split(old).join(next) : before.replace(old, next));
        return { ok: true, output: `edited ${path}` };
      }
      if (name === "apply_patch") {
        // Whole-patch-or-nothing, like the host: every target must exist unless its `---` side is
        // `/dev/null`, which makes it a creation.
        const lines = String(args.patch ?? "").split("\n");
        const targets: { path: string; create: boolean }[] = [];
        let old = "";
        for (const l of lines) {
          if (l.startsWith("--- ")) {
            old = l.slice(4).trim();
            continue;
          }
          if (!l.startsWith("+++ ")) continue;
          const path = l.slice(4).trim().replace(/^[ab]\//, "");
          if (path && path !== "/dev/null") targets.push({ path, create: old === "/dev/null" });
        }
        if (targets.some((t) => !t.create && !files.has(t.path))) {
          return { ok: false, output: "hunk context did not match" };
        }
        for (const t of targets) {
          files.set(t.path, t.create ? "hello\n" : `${files.get(t.path)!}+patched`);
        }
        return { ok: true, output: `patched ${targets.length} file(s)` };
      }
      if (name === "run_command") return { ok: true, output: "ok" };
      if (name === "mkdir") return { ok: true, output: "created" };
      return { ok: false, output: "unknown tool" };
    },
  };
  return { host, files, calls };
}

describe("createCheckpointingHost", () => {
  it("captures the pre-run contents of a file the run edits", async () => {
    const ws = fakeWorkspace({ "a.txt": "one\ntwo\n" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("edit_file", { path: "a.txt", old: "two", new: "TWO" });

    expect(cp.snapshot().files).toEqual([
      { path: "a.txt", before: "one\ntwo\n", after: "one\nTWO\n" },
    ]);
  });

  it("checkpoints every file a patch names, so revert covers apply_patch", async () => {
    // The revert gap this closes: `apply_patch` was neither a tracked writer nor a noted untracked
    // tool, so its changes were invisible and "revert this run" reported "reverted N of N files"
    // while the patch stayed on disk. A silent lie about restored state is the one failure this
    // module exists to prevent.
    const ws = fakeWorkspace({ "a.txt": "one\n", "b.txt": "two\n" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("apply_patch", {
      patch: [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-one",
        "+ONE",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-two",
        "+TWO",
      ].join("\n"),
    });

    const snap = cp.snapshot();
    expect(snap.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(snap.files.find((f) => f.path === "a.txt")).toMatchObject({ before: "one\n" });
    expect(snap.files.find((f) => f.path === "b.txt")).toMatchObject({ before: "two\n" });
    expect(snap.untracked, "and it is not reported as untracked").toEqual([]);
  });

  it("captures a file the patch creates, so revert can empty it", async () => {
    const ws = fakeWorkspace({ "a.txt": "one\n" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("apply_patch", {
      patch: ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hello"].join("\n"),
    });

    expect(cp.snapshot().files).toEqual([{ path: "new.txt", before: null, after: "hello\n" }]);
  });

  it("names a patch it cannot trace rather than claiming a revert it cannot deliver", async () => {
    const ws = fakeWorkspace({ "a.txt": "one\n" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    // No `+++ ` header at all: nothing to capture, and the review must say so.
    await host.run("apply_patch", { patch: "not really a diff" });

    const snap = cp.snapshot();
    expect(snap.files).toEqual([]);
    expect(snap.untracked).toHaveLength(1);
    expect(snap.untracked[0]).toContain("could not be read");
  });

  it("keeps the FIRST contents when a file is written twice in one run", async () => {
    // The regression this pins: capturing on every write would make the revert restore the state
    // after the first write — a run that appears to undo itself while leaving half its damage.
    const ws = fakeWorkspace({ "a.txt": "original" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("write_file", { path: "a.txt", content: "first" });
    await host.run("write_file", { path: "a.txt", content: "second" });

    const snap = cp.snapshot();
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.before).toBe("original");
    expect(snap.files[0]!.after).toBe("second");
  });

  it("records `before: null` for a file the run creates", async () => {
    const ws = fakeWorkspace({});
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("write_file", { path: "new.txt", content: "hello" });

    expect(cp.snapshot().files).toEqual([{ path: "new.txt", before: null, after: "hello" }]);
  });

  it("does not wrap read-only calls at all", async () => {
    // A read must cost exactly what it did before this feature: no snapshot, and no extra calls
    // the model would be billed for.
    const ws = fakeWorkspace({ "a.txt": "x" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("read_file", { path: "a.txt" });
    await host.run("search_files", { pattern: "x" });

    expect(ws.calls).toEqual(["read_file", "search_files"]);
    expect(cp.snapshot().files).toEqual([]);
    expect(cp.empty).toBe(true);
  });

  it("names a command as untracked instead of counting it as reverted", async () => {
    const ws = fakeWorkspace({});
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("run_command", { program: "pnpm", args: ["format"] });

    const snap = cp.snapshot();
    expect(snap.files).toEqual([]);
    expect(snap.untracked.join(" ")).toContain("pnpm");
    expect(snap.untracked.join(" ")).toContain("not reverted");
    expect(cp.empty).toBe(false);
  });

  it("notes a created directory rather than pretending it has a file body", async () => {
    const ws = fakeWorkspace({});
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("mkdir", { path: "src/gen" });

    expect(cp.snapshot().untracked).toEqual(["created directory src/gen"]);
  });

  it("does not fail the write when the snapshot read fails", async () => {
    // A checkpoint that cannot be taken must never break the tool call it was taken for.
    const host: ToolHost = {
      async run(name) {
        if (name === "read_file") throw new Error("host exploded");
        return { ok: true, output: "wrote" };
      },
    };
    const cp = new RunCheckpoint();
    const wrapped = createCheckpointingHost(host, cp);

    await expect(wrapped.run("write_file", { path: "a.txt", content: "x" })).resolves.toEqual({
      ok: true,
      output: "wrote",
    });
    expect(cp.snapshot().files).toEqual([{ path: "a.txt", before: null, after: null }]);
  });

  it("returns the inner host's failure unchanged and records no fabricated content", async () => {
    const ws = fakeWorkspace({});
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    const res = await host.run("edit_file", { path: "missing.txt", old: "a", new: "b" });

    expect(res.ok).toBe(false);
    expect(cp.snapshot().files[0]).toMatchObject({ path: "missing.txt", before: null, after: null });
  });
});

describe("revertPlan", () => {
  it("restores the pre-run bytes of an existing file", () => {
    const plan = revertPlan({
      files: [{ path: "a.txt", before: "original", after: "changed" }],
      untracked: [],
    });
    expect(plan.ops).toEqual([{ path: "a.txt", content: "original" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("empties a file the run created, and says why it is not deleted", () => {
    const plan = revertPlan({ files: [{ path: "new.txt", before: null, after: "hello" }], untracked: [] });
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.path).toBe("new.txt");
    expect(plan.ops[0]!.content).toBe("");
    expect(plan.ops[0]!.note).toContain("cannot delete");
  });

  it("skips, with a reason, a file whose previous contents were never readable", () => {
    // An unreadable file is not an empty one. Writing "" to it would be a destructive act
    // presented as an undo.
    const plan = revertPlan({
      files: [{ path: "bin.dat", before: null, after: null, beforeUnknown: true }],
      untracked: [],
    });
    expect(plan.ops).toEqual([]);
    expect(plan.skipped).toEqual([{ path: "bin.dat", reason: "its previous contents could not be read" }]);
  });

  it("plans nothing for a run that only ran commands", () => {
    const plan = revertPlan({ files: [], untracked: ["ran `pnpm` — not reverted"] });
    expect(plan).toEqual({ ops: [], skipped: [] });
  });
});

describe("RunCheckpoint", () => {
  it("does not re-capture a path it already holds", () => {
    const cp = new RunCheckpoint();
    cp.captureBefore("a", "one");
    cp.captureBefore("a", "two");
    expect(cp.snapshot().files[0]!.before).toBe("one");
  });

  it("ignores setAfter for a path that was never captured", () => {
    const cp = new RunCheckpoint();
    cp.setAfter("ghost", "x");
    expect(cp.snapshot().files).toEqual([]);
  });

  it("deduplicates identical untracked notes", () => {
    const cp = new RunCheckpoint();
    cp.noteUntracked("same");
    cp.noteUntracked("same");
    expect(cp.snapshot().untracked).toEqual(["same"]);
  });

  it("hands out a snapshot that does not alias its internal map", () => {
    const cp = new RunCheckpoint();
    cp.captureBefore("a", "one");
    const snap = cp.snapshot();
    cp.setAfter("a", "two");
    expect(snap.files[0]!.after).toBeNull();
  });
});

describe("host call budget", () => {
  it("costs two extra calls per mutation and nothing per read", async () => {
    const ws = fakeWorkspace({ "a.txt": "x" });
    const cp = new RunCheckpoint();
    const host = createCheckpointingHost(ws.host, cp);

    await host.run("read_file", { path: "a.txt" });
    expect(ws.calls).toEqual(["read_file"]);

    ws.calls.length = 0;
    await host.run("write_file", { path: "a.txt", content: "y" });
    expect(ws.calls).toEqual(["read_file", "write_file", "read_file"]);
  });
});

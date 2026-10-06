import { describe, it, expect } from "vitest";
import { clip, tryParseArgs, recordAgentTurn } from "./graph-record";
import type { Recorder } from "../../context/recorder";
import type { ChatMessage } from "@aiprovider/router-core";

/** A recording fake of the Recorder interface — nodes/edges captured for assertions. */
function fakeRecorder(): Recorder & { nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[]; edges: { from: string; to: string; kind: string }[] } {
  const nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[] = [];
  const edges: { from: string; to: string; kind: string }[] = [];
  let seq = 0;
  return {
    sessionId: "s",
    nodes,
    edges,
    node(kind, label, meta, id) {
      const nid = id ?? `n${seq++}`;
      nodes.push({ id: nid, kind, label, meta });
      return nid;
    },
    edge(from, to, kind) {
      edges.push({ from, to, kind });
    },
    flush: async () => undefined,
  };
}

const assistantMsg = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ role: "assistant", content, ...extra }) as ChatMessage;
const toolMsg = (content: string, callId: string): ChatMessage =>
  ({ role: "tool", content, tool_call_id: callId }) as ChatMessage;

describe("clip", () => {
  it("clips long strings with an ellipsis and leaves short ones alone", () => {
    expect(clip("short", 80)).toBe("short");
    expect(clip("x".repeat(81), 80)).toHaveLength(80);
    expect(clip("x".repeat(81), 80)).toMatch(/…$/);
  });
});

describe("tryParseArgs", () => {
  it("parses an object, and returns {} for non-objects, arrays, and junk", () => {
    expect(tryParseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseArgs("[1,2]")).toEqual({});
    expect(tryParseArgs("not json")).toEqual({});
    expect(tryParseArgs(undefined)).toEqual({});
  });
});

describe("recordAgentTurn", () => {
  it("anchors the follows-chain at the caller's userNode and records one message node per turn message", () => {
    const rec = fakeRecorder();
    const produced = [assistantMsg("looking"), assistantMsg("done")];
    const last = recordAgentTurn(rec, "user-node", produced, "m1");
    expect(rec.edges[0]).toEqual({ from: "user-node", to: "n0", kind: "follows" });
    expect(rec.edges[1]).toEqual({ from: "n0", to: "n1", kind: "follows" });
    expect(last).toBe("n1");
    expect(rec.nodes[0]!.meta).toMatchObject({ role: "assistant", model: "m1", text: "looking" });
  });

  it("records a skill node per tool call and hangs the artifact on its skill, keyed by tool_call_id", () => {
    const rec = fakeRecorder();
    const produced = [
      assistantMsg("", {
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "list_dir", arguments: "{}" } },
        ],
      }),
      toolMsg("file body", "call_1"),
      toolMsg("dir listing", "call_2"),
      assistantMsg("done"),
    ];
    const last = recordAgentTurn(rec, "user-node", produced, "m1");
    const skills = rec.nodes.filter((n) => n.kind === "skill");
    expect(skills.map((n) => n.label)).toEqual(["read_file", "list_dir"]);
    const artifacts = rec.nodes.filter((n) => n.kind === "artifact");
    expect(artifacts).toHaveLength(2);
    // Each artifact is produced by the skill whose call made it, not by the previous message.
    const skillEdge1 = rec.edges.find((e) => e.kind === "used");
    const producedEdges = rec.edges.filter((e) => e.kind === "produced");
    expect(producedEdges[0]!.from).toBe(skillEdge1!.to);
    expect(producedEdges[0]!.to).toBe(artifacts[0]!.id);
    // The chain resumes from the assistant node after the tool runs.
    expect(rec.edges.find((e) => e.kind === "follows" && e.from === "n0")).toBeTruthy();
    // The final assistant message is the chain head: message(n0) → artifacts hang off skills
    // (n1/n2), and "done" is n5, following n0.
    expect(last).toBe("n5");
  });

  it("carries the full tool-result text beside the clipped label (resume rebuilds from `text`)", () => {
    const rec = fakeRecorder();
    const long = "r".repeat(300);
    recordAgentTurn(rec, "u", [toolMsg(long, "c1")], "m1");
    const artifact = rec.nodes.find((n) => n.kind === "artifact")!;
    expect(artifact.meta!.text).toBe(long);
    expect((artifact.label as string).length).toBe(80);
  });

  it("does not re-record earlier turns: only `produced` becomes nodes", () => {
    const rec = fakeRecorder();
    recordAgentTurn(rec, "u", [assistantMsg("only this")], "m1");
    expect(rec.nodes).toHaveLength(1);
  });
});

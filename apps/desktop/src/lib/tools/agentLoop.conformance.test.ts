/**
 * Agent-loop conformance suite (2026-10-06).
 *
 * The product has two implementations of the same agent protocol: this TypeScript loop and the
 * Rust gateway loop (`core/router_bridge.rs`). Both execute the scenarios in
 * `conformance/loop-scenarios.json`, so the two are pinned to each other by construction — the
 * wire shape (`tool_calls` + `tool_call_id` pairing, synthesized ids, `{}` for absent arguments),
 * the conversation accumulation across rounds, the refusal-as-result rule, and the iteration
 * ceiling are shared facts, not conventions kept in step by comments.
 *
 * Expectations are deliberately abstract where the loops intentionally differ: denial wording
 * (a user `confirm` here vs the gateway's mutation-off refusal), empty-output handling, and
 * usage accounting. Anything the scenarios assert, both loops must satisfy identically.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "./agentLoop";
import type { AgentEvent, GenerateFn, ToolHost } from "./types";
import type { ChatMessage, TextStream, ToolCall } from "@aiprovider/router-core";

interface StepCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  /** The client driver's `confirm` gate denies this call; the gateway driver relies on mutation
   *  being off so the same call is refused there. */
  denyInClientLoop?: boolean;
}

interface Step {
  text?: string;
  calls?: StepCall[];
}

interface RoundExpectation {
  assistantToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  toolResults?: Array<{ idPrefix?: string; nonEmpty?: boolean }>;
}

interface Scenario {
  name: string;
  /** The opening user message. Defaults to "hi", which is what the Rust driver sends. */
  input?: string;
  steps: Step[];
  expect: {
    modelCalls: number;
    finalText: string;
    ceiling?: boolean;
    /** Entry i describes the conversation the model saw on call i+1; `null` skips a call. */
    turns?: Array<null | { rounds: RoundExpectation[] }>;
  };
}

const FILE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../conformance/loop-scenarios.json", import.meta.url)), "utf8"),
) as { scenarios: Scenario[] };

/** The scripted model: one `generate` call consumes one step, repeating the last one when the
 *  loop asks for more (the ceiling scenario is scripted with a single step). Every request's
 *  message list is captured, because the conversation the model sees on later calls is exactly
 *  what the scenarios assert on. */
function scriptedModel(steps: Step[], seen: ChatMessage[][]): GenerateFn {
  let i = 0;
  return async (req) => {
    seen.push(JSON.parse(JSON.stringify(req.messages)) as ChatMessage[]);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    step.calls?.forEach((c) =>
      req.onToolCall?.({
        id: c.id,
        name: c.name,
        arguments: c.args === undefined ? undefined : JSON.stringify(c.args),
      }),
    );
    req.onFinish?.("stop");
    const text = step.text ?? "";
    const chunks = (async function* () {
      yield text;
    })();
    return { chunks } as TextStream;
  };
}

/** `sandbox_echo` succeeds; anything else throws, the way a strict host rejects an unknown name. */
const host: ToolHost = {
  async run(name, args) {
    if (name === "sandbox_echo") return { ok: true, output: `echo: ${JSON.stringify(args)}` };
    throw new Error(`unknown tool "${name}"`);
  },
};

/** Split a conversation into rounds: each assistant turn carrying `tool_calls` opens a round and
 *  collects the `role:"tool"` messages that follow it, in order. */
function roundsOf(conversation: ChatMessage[]): Array<{ calls: any[]; results: any[] }> {
  const rounds: Array<{ calls: any[]; results: any[] }> = [];
  for (const m of conversation) {
    const toolCalls = (m as { tool_calls?: unknown }).tool_calls;
    if (m.role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
      rounds.push({ calls: toolCalls, results: [] });
    } else if (m.role === "tool" && rounds.length > 0) {
      rounds[rounds.length - 1].results.push(m);
    }
  }
  return rounds;
}

function assertConversation(
  scenario: string,
  where: string,
  conversation: ChatMessage[],
  expected: { rounds: RoundExpectation[] },
): void {
  const ctx = `${scenario} / ${where}`;
  const rounds = roundsOf(conversation);
  expect(rounds, `${ctx}: tool rounds`).toHaveLength(expected.rounds.length);

  expected.rounds.forEach((wantRound, i) => {
    const round = rounds[i]!;
    expect(
      round.calls.map((c) => c.function?.name),
      `${ctx}: round ${i + 1} call names`,
    ).toEqual(wantRound.assistantToolCalls.map((c) => c.name));

    wantRound.assistantToolCalls.forEach((wantCall, j) => {
      const raw = round.calls[j]?.function?.arguments;
      const args = typeof raw === "string" ? JSON.parse(raw) : raw ?? null;
      expect(args, `${ctx}: round ${i + 1} call ${j + 1} arguments`).toEqual(
        wantCall.arguments ?? {},
      );
    });

    const wantResults = wantRound.toolResults ?? [];
    expect(round.results, `${ctx}: round ${i + 1} result count`).toHaveLength(wantResults.length);

    round.results.forEach((result: any, j) => {
      expect(result.tool_call_id, `${ctx}: round ${i + 1} result ${j + 1} pairs with call ${j + 1}`)
        .toBe(round.calls[j].id);
      const wantResult = wantResults[j];
      if (wantResult?.idPrefix) {
        expect(
          String(result.tool_call_id).startsWith(wantResult.idPrefix),
          `${ctx}: round ${i + 1} result ${j + 1} id prefix`,
        ).toBe(true);
      }
      if (wantResult?.nonEmpty) {
        expect(
          String(result.content ?? "").trim().length,
          `${ctx}: round ${i + 1} result ${j + 1} is not empty`,
        ).toBeGreaterThan(0);
      }
    });
  });
}

async function runScenario(sc: Scenario): Promise<void> {
  const seen: ChatMessage[][] = [];
  const denied = new Set<string>();
  for (const step of sc.steps) {
    for (const call of step.calls ?? []) {
      if (call.denyInClientLoop) denied.add(call.name);
    }
  }

  const events: AgentEvent[] = [];
  const out = await runAgentLoop({
    model: "m",
    messages: [{ role: "user", content: sc.input ?? "hi" }],
    registry: [],
    generate: scriptedModel(sc.steps, seen),
    host,
    confirm: async (call: ToolCall) => !denied.has(call.name ?? ""),
    onEvent: (e) => events.push(e),
  });

  expect(seen.length, `${sc.name}: model calls`).toBe(sc.expect.modelCalls);
  expect(out.text, `${sc.name}: final text`).toBe(sc.expect.finalText);
  if (sc.expect.ceiling) {
    expect(out.truncated, `${sc.name}: the ceiling exit is not a truncation`).toBe(false);
    const done = [...events].reverse().find((e) => e.type === "done");
    expect(done && "iterations" in done ? done.iterations : undefined, `${sc.name}: iterations at the ceiling`)
      .toBe(sc.expect.modelCalls);
  }
  (sc.expect.turns ?? []).forEach((t, i) => {
    if (t) assertConversation(sc.name, `model call ${i + 1}`, seen[i]!, t);
  });
}

describe("agent-loop conformance (shared with the Rust gateway loop)", () => {
  for (const sc of FILE.scenarios) {
    it(sc.name, async () => {
      await runScenario(sc);
    });
  }
});

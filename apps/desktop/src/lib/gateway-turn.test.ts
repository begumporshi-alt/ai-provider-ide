/**
 * gateway-turn — the Assistant's port onto the gateway engine (A1 Phase 1).
 *
 * These pins are about the wire, because the wire is the contract: the shapes consumed here are
 * the ones the gateway's Rust tests pin on the emitting side (audit 2026-10-03 M2 — usage rides
 * the terminal chunk beside finish_reason; tool calls arrive as complete OpenAI objects; an
 * error frame is a failed turn). If the Rust egress changes shape, these go red with it.
 * The 401 pin mirrors `gateway-client.test.ts`'s, asserted on the *retry's* Authorization
 * header: a retry that re-sent the stale key would satisfy "two calls" while fixing nothing.
 */
import { afterEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => {
  const keys: string[] = [];
  let minted = 0;
  return {
    keys,
    nextKey: () => {
      minted += 1;
      const k = `ui-session-secret-${minted}`;
      keys.push(k);
      return k;
    },
    reset: () => {
      keys.length = 0;
      minted = 0;
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "ui_session_key") return h.nextKey();
    if (cmd === "gateway_status") return { port: 8800 };
    return null;
  },
}));

import { gatewayGenerate } from "./gateway-turn";
import { clearUiSession } from "./gateway-client";

const sse = (frames: string[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const okTurn = (): Response =>
  sse([
    frame({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    frame({ choices: [{ delta: { content: "Hel" } }] }),
    frame({ choices: [{ delta: { content: "lo" } }] }),
    // The M2 terminal chunk: finish_reason and usage ride the same choices[0].
    frame({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
      ],
    }),
    "data: [DONE]\n\n",
  ]);

let last: { url: string; init: RequestInit } | undefined;
let responses: Array<(url: string, init: RequestInit) => Response> = [];

afterEach(() => {
  h.reset();
  clearUiSession();
  responses = [];
  last = undefined;
});

const stubFetch = (): void => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = responses.shift();
    if (!r) throw new Error("no scripted response");
    last = { url: String(url), init: init ?? {} };
    return r(String(url), init ?? {});
  }) as typeof fetch;
};

const drain = async (exec: { chunks: AsyncIterable<string> }): Promise<string> => {
  let text = "";
  for await (const chunk of exec.chunks) text += chunk;
  return text;
};

test("served_by rides the terminal chunk wholesale — including the failover chain", async () => {
  stubFetch();
  const sseBody = [
    frame({ choices: [{ delta: { content: "Hello" } }] }),
    frame({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          served_by: {
            provider: "winner",
            model: "model-x",
            key: "key-01",
            fallbacks: [
              { provider: "first-try", key: "key-00", cls: "SERVER" },
              { cls: "RATE_LIMITED", reason: "slow down" },
            ],
          },
        },
      ],
    }),
    "data: [DONE]\n\n",
  ];
  responses.push(() => sse(sseBody));
  const exec = await gatewayGenerate({ model: "m", messages: [{ role: "user", content: "hi" }] }, {});
  await drain(exec);
  const served = exec.served();
  expect(served?.provider).toBe("winner");
  expect(served?.fallbacks).toHaveLength(2);
  expect(served?.fallbacks?.[0]).toEqual({ provider: "first-try", key: "key-00", cls: "SERVER" });
  // The unlabelled attempt stays unlabelled — no invented names.
  expect(served?.fallbacks?.[1]).toEqual({ cls: "RATE_LIMITED", reason: "slow down" });
});

test("yields answer chunks and fires the callbacks the port promises", async () => {
  stubFetch();
  responses.push(() => okTurn());
  const onUsage = vi.fn();
  const onReasoning = vi.fn();
  const onFinish = vi.fn();
  const exec = await gatewayGenerate(
    { model: "m", messages: [{ role: "user", content: "hi" }], onUsage, onReasoning, onFinish },
    {},
  );
  const text = await drain(exec);
  expect(text).toBe("Hello");
  expect(exec.reasoning()).toBe("thinking");
  expect(onReasoning).toHaveBeenCalledWith("thinking");
  expect(onFinish).toHaveBeenCalledWith("stop");
  expect(onUsage).toHaveBeenCalledWith({ prompt_tokens: 12, completion_tokens: 3 });
});

test("sends the request the gateway expects — stream flag, memory opt-out, effort knob", async () => {
  stubFetch();
  responses.push(() => okTurn());
  await drain(await gatewayGenerate({ model: "m", messages: [], maxTokens: 64, reasoning: "off" }, {}));
  expect(last!.url).toBe("http://127.0.0.1:8800/v1/chat/completions");
  const body = JSON.parse(String(last!.init.body));
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(64);
  expect(body.reasoning_effort).toBe("off");
  const headers = last!.init.headers as Record<string, string>;
  expect(headers["AIP-Memory"]).toBe("off");
  expect(headers.Authorization).toBe("Bearer ui-session-secret-1");
});

test("hands tool calls to the sink exactly as the wire carried them", async () => {
  stubFetch();
  responses.push(() =>
    sse([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "call_1", function: { name: "write_file", arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      }),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]),
  );
  const onToolCall = vi.fn();
  await drain(await gatewayGenerate({ model: "m", messages: [], onToolCall }, {}));
  expect(onToolCall).toHaveBeenCalledWith({
    id: "call_1",
    name: "write_file",
    arguments: '{"path":"a"}',
  });
});

test("throws with the gateway's message on an error frame", async () => {
  stubFetch();
  responses.push(() => sse([frame({ error: { message: "upstream refused the request" } })]));
  const exec = await gatewayGenerate({ model: "m", messages: [] }, {});
  await expect(drain(exec)).rejects.toThrow("upstream refused the request");
});

test("re-mints once on 401 and the retry carries the NEW credential (the S2 self-heal)", async () => {
  stubFetch();
  responses.push(() => new Response('{"error":{"message":"invalid gateway key"}}', { status: 401 }));
  responses.push(() => okTurn());
  const exec = await gatewayGenerate({ model: "m", messages: [] }, {});
  const text = await drain(exec);
  expect(text).toBe("Hello");
  const firstAuth = "ui-session-secret-1";
  const headers = last!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ui-session-secret-2`);
  expect(headers.Authorization).not.toBe(`Bearer ${firstAuth}`);
});

test("does not send tools when the request declares none", async () => {
  stubFetch();
  responses.push(() => okTurn());
  await drain(await gatewayGenerate({ model: "m", messages: [] }, {}));
  const body = JSON.parse(String(last!.init.body));
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
});

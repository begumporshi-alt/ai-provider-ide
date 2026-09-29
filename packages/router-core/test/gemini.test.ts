/**
 * gemini-compat tests: the third builtin dialect, and the reason the grammar grew three
 * features — `{{model}}` in the endpoint path, `streamPath` (Gemini streams at a different
 * endpoint than it dials unarily), and `usageKeys` (its usage block does not speak OpenAI's
 * field names). Each test names the feature it exercises.
 */
import { describe, expect, it } from "vitest";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { fingerprint } from "../src/fingerprinter.js";
import { runProbes } from "../src/probe-runner.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { FakeHttp } from "./fakes.js";

/** A Gemini-native host: catalogue at /v1beta/models, content at :generateContent. */
const GEMINI_SERVER = (url: string): { status: number; body?: unknown } => {
  if (url.endsWith("/v1beta/models"))
    return { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key." } } };
  if (url.includes(":generateContent") || url.includes(":streamGenerateContent"))
    return { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key." } } };
  return { status: 404 };
};

describe("gemini template (grammar features)", () => {
  function interpreter(res: { status: number; body?: unknown }) {
    return new ManifestInterpreter(BUILTIN_TEMPLATES["gemini-compat"]!("https://generativelanguage.googleapis.com"), {
      http: new FakeHttp(() => res),
      vars: {},
    });
  }

  it("substitutes the model into the path, keeping its slash", async () => {
    const http = new FakeHttp((url) => {
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      );
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: "hello" }] } }] } };
    });
    const interp = new ManifestInterpreter(
      BUILTIN_TEMPLATES["gemini-compat"]!("https://generativelanguage.googleapis.com"),
      { http, vars: {} },
    );
    const out: string[] = [];
    for await (const c of interp.generateText("key:t", { model: "models/gemini-2.0-flash", messages: [], stream: false })) {
      out.push(c);
    }
    expect(out.join("")).toBe("hello");
  });

  it("reads usage under the dialect's own field names (usageKeys)", async () => {
    let usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number } | undefined;
    const interp = interpreter({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, cachedContentTokenCount: 4 },
      },
    });
    for await (const _ of interp.generateText("key:t", {
      model: "models/gemini-2.0-flash", messages: [], stream: false,
      onUsage: (u) => { usage = u; },
    })) {
      // drain
    }
    // The OpenAI-hardcoded names reported 0/0 forever for this shape.
    expect(usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, cached_tokens: 4 });
  });

  it("dials streamGenerateContent when streaming (streamPath)", async () => {
    const urls: string[] = [];
    const http = new FakeHttp((url) => {
      urls.push(url);
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        lines: [
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] })}`,
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 },
          })}`,
        ],
      };
    });
    const interp = new ManifestInterpreter(
      BUILTIN_TEMPLATES["gemini-compat"]!("https://generativelanguage.googleapis.com"),
      { http, vars: {} },
    );
    const out: string[] = [];
    for await (const c of interp.generateText("key:t", { model: "models/gemini-2.0-flash", messages: [], stream: true })) {
      out.push(c);
    }
    expect(out.join("")).toBe("Hi there");
    expect(urls[0]).toContain(":streamGenerateContent?alt=sse");
    expect(urls[0]).toContain("/models/gemini-2.0-flash:");
  });
});

describe("gemini fingerprint", () => {
  it("classifies a Gemini-native probe set by its generateContent route", async () => {
    const report = await runProbes(new FakeHttp((url) => GEMINI_SERVER(url)), "https://generativelanguage.googleapis.com/v1beta");
    const fp = fingerprint(report);
    expect(fp.dialect).toBe("gemini-compat");
    expect(fp.template?.dialect).toBe("gemini-generate-v1");
    expect(fp.evidence.join(" ")).toContain("generateContent");
  });

  it("does not classify an OpenAI host as gemini", async () => {
    const report = await runProbes(
      new FakeHttp((url) => {
        if (url.endsWith("/models") || url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }] } };
        if (url.includes("/chat/completions")) return { status: 400, body: { error: { message: "x" } } };
        return { status: 404 };
      }),
      "https://api.example.com/v1",
    );
    expect(fingerprint(report).dialect).toBe("openai-compat");
  });
});

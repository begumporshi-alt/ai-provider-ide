/**
 * A `200` whose body is not JSON is a **wrong path**, and saying so is the difference between a
 * one-minute fix and an afternoon (2026-09-28).
 *
 * Live report, measured against the real host before this was written. A provider configured at
 * `https://api.hcnsec.cn` — no `/v1` — answered **every** unknown path with its marketing SPA at
 * status **200** and `content-type: text/html`, while `https://api.hcnsec.cn/v1/models` answered
 * `401` JSON. One cause produced three messages, and none of them named it:
 *
 * | Path | What the operator saw |
 * |---|---|
 * | "Fetch from provider" | `JSON Parse error: Unrecognized token '<'` |
 * | Test | `answered with an empty response — the request succeeded but no content came back` |
 * | Key test | `could not verify — JSON Parse error: Unrecognized token '<'` |
 *
 * **The `status >= 400` guard at every call site cannot catch any of it**, because the wrong answer
 * arrives as a *success*. The streaming case is the worst of the three: an HTML body carries no
 * `data:` lines, so the generator ends having yielded nothing and the caller asserts a success that
 * did not happen.
 */
import { describe, expect, it } from "vitest";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import { FakeHttp, FakeVault, type Responder } from "./fakes.js";

const HTML = `<!doctype html>\n<html lang="en">\n  <head><title>Free GLM API</title></head>\n</html>`;

/**
 * The openai profile pointed at a host the assertion can name, with `listModels` pinned to
 * `/models` — the path the real manifest carried, so the URL under test is the URL that failed.
 */
function interpreter(respond: Responder) {
  const manifest = JSON.parse(JSON.stringify(PROVIDER_PROFILES["openrouter"]!()));
  manifest.provider.baseUrl = "https://api.example.test";
  manifest.endpoints.listModels = { method: "GET", path: "/models", map: { models: "$.data[*].id" } };
  const http = new FakeHttp(respond);
  return { interp: new ManifestInterpreter(manifest, { http, vault: new FakeVault(), vars: {} } as never) };
}

async function drain(gen: AsyncGenerator<string>): Promise<{ text: string; err: Error | null }> {
  let text = "";
  try {
    for await (const c of gen) text += c;
    return { text, err: null };
  } catch (e) {
    return { text, err: e as Error };
  }
}

describe("a 200 that is not JSON", () => {
  it("names the HTML page, the URL and the likely remedy when listing models", async () => {
    const { interp } = interpreter(() => ({ status: 200, raw: HTML }));

    const err = (await interp.listModels("key:x").catch((e: unknown) => e)) as Error;

    expect(err.message).toContain("https://api.example.test/models");
    expect(err.message).toContain("HTML");
    expect(err.message).toContain("/v1");
    // The old message was the engine's, and told the operator nothing they could act on.
    expect(err.message).not.toMatch(/Unrecognized token/);
  });

  it("refuses to report a silent empty success when the stream is really a page", async () => {
    const { interp } = interpreter(() => ({
      status: 200,
      lines: ["<!doctype html>", `<html lang="en">`],
    }));

    const { text, err } = await drain(
      interp.generateText("key:x", { model: "m", messages: [], stream: true } as never),
    );

    expect(err, "an HTML body must not end the stream cleanly with no output").not.toBeNull();
    expect(err!.message).toContain("HTML");
    expect(err!.message).toContain("/v1");
    expect(text).toBe("");
  });

  it("still lists models when the body is JSON, so the guard is not a blanket refusal", async () => {
    const { interp } = interpreter(() => ({ status: 200, body: { data: [{ id: "glm-5.3-flash" }] } }));

    const models = await interp.listModels("key:x");

    expect(models.map((m) => m.nativeId)).toEqual(["glm-5.3-flash"]);
  });

  it("still streams a real SSE response, so the HTML check does not eat a live stream", async () => {
    const { interp } = interpreter(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
        "data: [DONE]",
      ],
    }));

    const { text, err } = await drain(
      interp.generateText("key:x", { model: "m", messages: [], stream: true } as never),
    );

    expect(err).toBeNull();
    expect(text).toBe("hi");
  });
});

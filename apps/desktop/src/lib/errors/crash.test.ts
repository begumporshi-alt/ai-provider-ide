/**
 * `crashReport` — the sentence a render crash is allowed to say.
 *
 * The defect this exists for is an absence: a throw during render unmounted the tree and left a
 * blank window, so the app's only failure mode was one a user cannot read. That makes the tests
 * here about *coverage of `throw`'s actual domain* rather than about formatting — `throw` accepts
 * any value, including `undefined`, a bare string, and an object whose `JSON.stringify` itself
 * throws, and every one of those has to come out as a sentence rather than as a second exception
 * thrown from inside the error handler.
 */
import { expect, test } from "vitest";
import {
  MAX_HEADLINE_CHARS,
  MAX_MESSAGE_CHARS,
  clipText,
  crashReport,
  messageOf,
  oneLine,
  whereOf,
} from "./crash";

test("an Error's own message is the message", () => {
  expect(messageOf(new TypeError("providers is not an array"))).toBe("providers is not an array");
});

test("a multi-line message collapses to one line, so it can be a heading", () => {
  expect(messageOf(new Error("first\n  second\tthird"))).toBe("first second third");
});

test("an Error carrying no message is named by its class", () => {
  // `new Error().name` is "Error", which says nothing at all; a subclass's name is the diagnosis.
  expect(messageOf(new TypeError(""))).toBe("TypeError");
  expect(messageOf(new Error(""))).toBe("Error with no message");
});

test("a thrown string is its own message", () => {
  expect(messageOf("the host went away")).toBe("the host went away");
  expect(messageOf("")).toBe("An empty string was thrown");
});

test("null and undefined are named rather than stringified", () => {
  // `String(undefined)` is "undefined", which reads as a UI string rather than a missing value.
  expect(messageOf(null)).toBe("A null value was thrown");
  expect(messageOf(undefined)).toBe("An undefined value was thrown");
});

test("a thrown plain object is described by its JSON", () => {
  expect(messageOf({ code: 500, reason: "no route" })).toBe('{"code":500,"reason":"no route"}');
});

test("a circular object does not throw from inside the handler", () => {
  // `JSON.stringify` throws on a cycle. If that escaped, the boundary would fail while reporting a
  // failure, and the window would go blank in exactly the situation this module exists for.
  const loop: Record<string, unknown> = { name: "loop" };
  loop.self = loop;
  expect(messageOf(loop)).toBe("[object Object]");
});

test("a class instance with no own fields falls back rather than reporting {}", () => {
  class Marker {
    describe(): string {
      return "marker";
    }
  }
  expect(messageOf(new Marker())).toBe("[object Object]");
});

/**
 * A lone surrogate — half of a pair with its partner cut off. Code-point iteration is what makes
 * this decidable: a valid pair comes back as ONE code point above `0xFFFF`, so anything landing in
 * the surrogate range here is genuinely unpaired. Testing for the range with a regex would not
 * work, because both halves of a healthy emoji are individually in that range.
 */
function hasLoneSurrogate(s: string): boolean {
  return Array.from(s).some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff;
  });
}

test("clipText counts code points, so it cannot cut a surrogate pair in half", () => {
  expect(clipText("🙂🙂🙂", 3)).toBe("🙂🙂🙂");
  expect(clipText("🙂🙂🙂🙂", 3)).toBe("🙂🙂🙂…");
  // The assertion that gives the one above its meaning: the naive UTF-16 cut really does produce a
  // lone surrogate, so "no lone surrogate" is a property `clipText` earns rather than one any
  // implementation would have.
  expect(hasLoneSurrogate("🙂🙂🙂🙂".slice(0, 3))).toBe(true);
  expect(hasLoneSurrogate(clipText("🙂🙂🙂🙂", 3))).toBe(false);
});

test("clipText leaves a short string alone and marks a cut one", () => {
  expect(clipText("short", 10)).toBe("short");
  expect(clipText("exactly-10", 10)).toBe("exactly-10");
  expect(clipText("0123456789abc", 10)).toBe("0123456789…");
});

test("oneLine collapses every kind of whitespace run", () => {
  expect(oneLine("  a \n\n b \t c  ")).toBe("a b c");
});

test("whereOf takes the first real frame, never the message line", () => {
  const stack = [
    "TypeError: boom",
    "    at renderProvider (http://localhost:1420/src/screens/Providers.tsx:84:20)",
    "    at renderWithHooks (http://localhost:1420/node_modules/react-dom/client.js:1:1)",
  ].join("\n");
  expect(whereOf(stack)).toBe("at renderProvider (http://localhost:1420/src/screens/Providers.tsx:84:20)");
});

test("whereOf answers nothing when the stack has no frames", () => {
  expect(whereOf(undefined)).toBeUndefined();
  expect(whereOf("TypeError: boom")).toBeUndefined();
});

test("crashReport carries the message, the origin and the component stack", () => {
  const err = new TypeError("providers.map is not a function");
  const report = crashReport(err, "\n    in ProvidersScreen\n    in Shell\n");
  expect(report.message).toBe("providers.map is not a function");
  expect(report.headline).toBe("providers.map is not a function");
  // `where` comes from the real stack of a real Error, so it is asserted as present rather than
  // spelled out — the frame count differs per runtime.
  expect(report.where).toContain("at ");
  expect(report.componentStack).toBe("in ProvidersScreen\n    in Shell");
});

test("crashReport holds back the stack for a value that is not an Error", () => {
  // A thrown string has no stack, and inventing one would point the reader at this file instead of
  // at whatever threw.
  const report = crashReport("the host went away");
  expect(report.stack).toBeUndefined();
  expect(report.where).toBeUndefined();
  expect(report.message).toBe("the host went away");
});

test("crashReport clips an enormous message and says that it did", () => {
  const report = crashReport(new Error("x".repeat(MAX_MESSAGE_CHARS + 500)));
  expect(report.message.length).toBe(MAX_MESSAGE_CHARS + 1); // the ellipsis is the extra character
  expect(report.message.endsWith("…")).toBe(true);
  expect(report.headline.length).toBe(MAX_HEADLINE_CHARS + 1);
});

test("crashReport's headline is always one line, whatever was thrown", () => {
  expect(crashReport(new Error("a\nb\nc")).headline).toBe("a b c");
  expect(crashReport({ detail: "line\nbreak" }).headline).toBe('{"detail":"line\\nbreak"}');
});

test("crashReport omits componentStack rather than emitting an empty string", () => {
  // The boundary renders the component stack only when there is one, so `""` would draw an empty
  // label. Absent is the honest value.
  expect(crashReport(new Error("boom"))).not.toHaveProperty("componentStack");
  expect(crashReport(new Error("boom"), "")).not.toHaveProperty("componentStack");
});

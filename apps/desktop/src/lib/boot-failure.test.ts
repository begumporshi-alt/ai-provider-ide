/**
 * `bootFailureHint` — the boot screen must name the cause, not prescribe one remedy over it.
 *
 * The pre-fix defect was structural: a single sentence ("restore from the newest dated backup")
 * was appended to *every* boot failure, so a transient 429 was answered with the app's most
 * destructive operation. These tests pin the choice per cause, and — as importantly — pin that the
 * backup advice is **conditional**, not the default.
 */
import { expect, test } from "vitest";
import { bootFailureHint } from "./boot-failure";

/** The exact shape `fetchAdmin` throws — see `gateway-client.ts:122`. */
const adminError = (status: number, body = "{}") =>
  `GET /admin/api-keys → ${status}: ${body}`;

test("a 429 is a transient backoff — reload, do not restore", () => {
  const hint = bootFailureHint(adminError(429, `{"error":{"code":null,"message":"too many failed auth attempts — backing off","type":"rate_limit"}}`));
  expect(hint).toMatch(/rate-limiting/i);
  expect(hint).not.toContain("restore from the newest dated backup");
});

test("a 401 is the app's own credential being refused — reload mints a fresh one", () => {
  const hint = bootFailureHint(adminError(401));
  expect(hint).toMatch(/credential/i);
  expect(hint).not.toContain("restore from the newest dated backup");
});

test("a 5xx is a server fault — point at the log, not the backup", () => {
  const hint = bootFailureHint(adminError(500));
  expect(hint).toMatch(/log/i);
  expect(hint).not.toContain("restore from the newest dated backup");
});

test("no listener at all — the TypeError path, not a corrupt store", () => {
  const hint = bootFailureHint("TypeError: Failed to fetch");
  expect(hint).toMatch(/did not answer/i);
  expect(hint).not.toContain("restore from the newest dated backup");
});

test("an unrecognised failure keeps the backup advice but hedges it — it is now conditional, not asserted", () => {
  const hint = bootFailureHint("some unknown host fault");
  expect(hint).toContain("restore from the newest dated backup");
  // The hedge is the point: the backup is offered *because the cause is unrecognised*, which is
  // one of the cases a corrupt store is plausible — never as the answer to every cause.
  expect(hint).toMatch(/only thing the host reported/i);
});

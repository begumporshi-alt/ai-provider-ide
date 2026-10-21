/**
 * Cross-agent session sources — the TS surface that backs the manifest's `related` section.
 *
 * The shim seeds a synthetic Claude session rooted at /tmp/proj-beta and empty stubs for
 * workbuddy/gemini. These checks call the real `/admin/sources*` routes through the harness's
 * `fetch` override (the same path `fetchAdmin` takes), so they exercise the route contracts,
 * the auth gate, and the seeded data shape — not the React rendering path.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

type AgentSource = {
  name: string;
  available: boolean;
  sessionCount: number;
  note: string | null;
};
type RelatedSession = {
  source: string;
  nativeId: string;
  title: string | null;
  root: string | null;
  turns: number;
  preview: string;
  importId: string | null;
};

async function admin(
  page: import("@playwright/test").Page,
  method: string,
  path: string,
  body?: unknown,
) {
  return page.evaluate(
    async ({ method, path, body }) => {
      // The harness mints the UI session key on first `ui_session_key`; after the page boots with
      // ?seed=systemai it is cached, so a Bearer of the matching secret authenticates the call.
      const key = await (
        window as unknown as {
          __webTest: { invoke: (c: string, a?: unknown) => Promise<string> };
        }
      ).__webTest.invoke("ui_session_key");
      const res = await fetch(`/admin${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${JSON.stringify(err)}`);
      }
      return (await res.json()) as unknown;
    },
    { method, path, body },
  );
}

test("listAgentSources reports every adapter including empty stubs", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  const sources = (await admin(page, "GET", "/sources")) as {
    sources: AgentSource[];
  };
  const names = sources.sources.map((s) => s.name);
  expect(names).toEqual([
    "zcode",
    "claude",
    "codex",
    "qoder",
    "router",
    "workbuddy",
    "gemini",
  ]);

  const claude = sources.sources.find((s) => s.name === "claude");
  expect(claude).toMatchObject({ available: true, sessionCount: 1 });
  const buddy = sources.sources.find((s) => s.name === "workbuddy");
  expect(buddy).toMatchObject({
    available: false,
    sessionCount: 0,
    note: "no sessions found",
  });
});

test("listSourceSessions scopes by root and filters by query", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  // Root-scoped: the seeded claude session is on /tmp/proj-beta.
  const beta = (await admin(
    page,
    "GET",
    "/sources/sessions?root=/tmp/proj-beta&limit=8",
  )) as {
    sessions: RelatedSession[];
  };
  expect(beta.sessions).toHaveLength(1);
  expect(beta.sessions[0].source).toBe("claude");
  expect(beta.sessions[0].root).toBe("/tmp/proj-beta");

  // A different workspace sees nothing.
  const other = await admin(
    page,
    "GET",
    "/sources/sessions?root=/tmp/does-not-exist",
  );
  expect((other as { sessions: RelatedSession[] }).sessions).toHaveLength(0);

  // Query filters across all sources, case-insensitively.
  const match = await admin(page, "GET", "/sources/sessions?q=refresh");
  expect(
    (match as { sessions: RelatedSession[] }).sessions.map((s) => s.source),
  ).toEqual(["claude"]);
  expect(
    (match as { sessions: RelatedSession[] }).sessions[0].preview,
  ).toContain("refresh");

  const miss = await admin(page, "GET", "/sources/sessions?q=zzznopezz");
  expect((miss as { sessions: RelatedSession[] }).sessions).toHaveLength(0);

  // The named listing is a separate four-segment route, not a filter on the all list. A shim
  // that only implemented `/sources/sessions` made the Sources screen's adapter filter 404.
  const perSource = (await admin(page, "GET", "/sources/claude/sessions")) as {
    sessions: RelatedSession[];
  };
  expect(perSource.sessions).toHaveLength(1);
  expect(perSource.sessions[0].source).toBe("claude");
  const emptySource = (await admin(page, "GET", "/sources/zcode/sessions")) as {
    sessions: RelatedSession[];
  };
  expect(emptySource.sessions).toHaveLength(0);
});

test("importSourceSession is idempotent and returns the derived session id", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  const first = (await admin(page, "POST", "/sources/import", {
    source: "claude",
    native_id: "sess_1",
  })) as { sessionId: string; turns: number };
  expect(first.sessionId).toMatch(/^imp-claude-/);
  expect(first.turns).toBe(4);

  // Re-import: same id, same turn count — the import is a snapshot, not a duplicate.
  const second = (await admin(page, "POST", "/sources/import", {
    source: "claude",
    native_id: "sess_1",
  })) as { sessionId: string; turns: number };
  expect(second.sessionId).toBe(first.sessionId);
  expect(second.turns).toBe(4);

  // Unknown native id: 404 surfaces as a thrown error, not a silent empty import.
  await expect(
    admin(page, "POST", "/sources/import", {
      source: "claude",
      native_id: "nope",
    }),
  ).rejects.toThrow(/404/);
});

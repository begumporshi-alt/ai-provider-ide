/**
 * web-test/session-tools.spec.ts — the Assistant can see its own past.
 *
 * Until 0030 the Assistant had no path to session history at all: its registry had ~30 tools and
 * none of them touched the transcript store. These specs drive the whole arc end to end against
 * the emulated host: a past session seeded the way the app writes one (graph rows for the index,
 * transcript rows for the words, a custom title), then a question only session knowledge can
 * answer — the model searches the transcripts, reads the session it matched, and answers with
 * words that exist nowhere in the mock: they crossed the store → port → loop → model chain.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

async function setupAgentMode(page: Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

/**
 * One past session, written the way the app writes one — but yesterday. The graph rows are what
 * `list_sessions` indexes; the transcript rows are what `search_sessions` and `read_session`
 * serve; the title is what a hit carries so the answer can name the conversation the way the
 * History screen does.
 */
async function seedPastSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const t = (window as unknown as { __webTest: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } }).__webTest;
    const ts = Date.now() - 86_400_000;
    await t.invoke("context_record", {
      nodes: [
        { id: "message:past-1:1", kind: "message", label: "the quixotic bug keeps flapping when the upstream times out", source: "ui", session_id: "past-1", ts, meta_json: '{"role":"user","model":"mock/oracle-1"}' },
        { id: "message:past-1:2", kind: "message", label: "", source: "ui", session_id: "past-1", ts, meta_json: '{"role":"assistant","model":"mock/oracle-1"}' },
      ],
      edges: [
        { id: "e-past-1", from_id: "message:past-1:1", to_id: "message:past-1:2", kind: "follows", weight: 1, ts, meta_json: null },
      ],
    });
    await t.invoke("transcript_append", {
      rows: [
        { sessionId: "past-1", seq: 0, role: "user", content: "the quixotic bug keeps flapping when the upstream times out", ts },
        { sessionId: "past-1", seq: 1, role: "assistant", content: "root cause: no retry between probes. The quixotic bug was fixed by caching the probe result for three rounds.", ts: ts + 1000 },
      ],
    });
    await t.invoke("history_rename_session", { session_id: "past-1", title: "Quixotic flap hunt" });
  });
}

test("a question about the past is answered from the transcripts, not invented", async ({ page }) => {
  await setupAgentMode(page);
  await seedPastSession(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("what did we say about the quixotic bug?");
  await page.getByRole("button", { name: "Send" }).click();

  // Both session tools ran: the search found the session, the read pulled its transcript.
  await expect(
    page.getByTestId("tool-call-row").filter({ hasText: "search_sessions" }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByTestId("tool-call-row").filter({ hasText: "read_session" }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // The answer quotes the snippet — words that exist only in the seeded transcript, which reached
  // the answer through search_sessions. Hits sort newest-first, so the top hit is the assistant's
  // closing turn; a mock that skipped the store could not produce this text.
  await expect(page.getByText(/Found it in session past-1/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\[quixotic\] bug was fixed by caching/)).toBeVisible();
});

test("the assistant can browse the session index and name a titled session", async ({ page }) => {
  await setupAgentMode(page);
  await seedPastSession(page);
  await page.getByPlaceholder(/Describe a task for the agent/).fill("list my past sessions");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByTestId("tool-call-row").filter({ hasText: "list_sessions" }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // Count and title both come from the index row — the title only exists because the port
  // carried the History screen's own metadata across. Scoped to the answer paragraph: the tool
  // row's collapsed result preview names the title too, and a bare getByText would match both.
  await expect(page.getByText(/You have 1 past session/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/including “Quixotic flap hunt”/)).toBeVisible();
});

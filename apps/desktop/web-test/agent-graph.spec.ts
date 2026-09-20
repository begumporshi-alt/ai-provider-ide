/**
 * web-test/agent-graph.spec.ts — the conversation graph must record what happened, once.
 *
 * `recordAgentTurn` is handed the loop's whole transcript (`agentLoop` seeds its working copy
 * from the input history and returns all of it), and it mints a fresh node id for every message
 * it sees. Two things follow if it is called naively:
 *
 *   1. the current user turn is recorded twice — once as the `user` anchor it creates up front,
 *      once as the first entry of the transcript it then iterates;
 *   2. every subsequent turn re-records the entire prior conversation as brand-new nodes.
 *
 * Neither is visible in `agent-turn.spec.ts`, which sends one turn and asserts with `find`.
 * The graph is a record of what happened — a turn counted twice is a graph that lies.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

interface NodeRow { id: string; kind: string; label: string; session_id: string | null }

async function nodes(page: Page): Promise<NodeRow[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __webTest: { store: { contextNodes: () => NodeRow[] } };
        }
      ).__webTest.store.contextNodes(),
  );
}

/** Open the Assistant in agent mode with a model and a workspace root. */
async function openAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const combo = page.getByRole("combobox");
  const value = await combo
    .locator("option")
    .filter({ hasText: /oracle-mini/ })
    .first()
    .evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByLabel("agent mode").check();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
}

/** Send a task and clear the approval modal the oracle's one tool call raises. */
async function sendAndApprove(page: Page, task: string): Promise<void> {
  await page.getByPlaceholder(/Describe a task for the agent/).fill(task);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: 30_000 });
}

test("agent graph: one turn records the user prompt once, not twice", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await openAgent(page);
  await sendAndApprove(page, "list files");

  // Poll: the recorder's flush is fire-and-forget, so nodes land a tick after the answer.
  await expect.poll(async () => (await nodes(page)).filter((n) => n.kind === "message").length).toBeGreaterThan(0);

  const labels = (await nodes(page)).filter((n) => n.kind === "message").map((n) => n.label);
  // The user's prompt is one turn. It must not be recorded as two nodes.
  expect(labels.filter((l) => l === "list files")).toHaveLength(1);
});

test("agent graph: a second turn does not re-record the first conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await openAgent(page);
  await sendAndApprove(page, "list files");

  // Turn two: the replayed history already contains a tool result, so the oracle answers
  // directly — no second approval modal.
  await page.getByPlaceholder(/Describe a task for the agent/).fill("thanks");
  await page.getByRole("button", { name: "Send" }).click();

  // Waiting on the answer bubble would return immediately — turn one's bubble is already there.
  // Wait for turn two to reach the graph instead; that is also what the assertions below need.
  await expect
    .poll(
      async () => (await nodes(page)).filter((n) => n.kind === "message" && n.label === "thanks").length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const labels = (await nodes(page)).filter((n) => n.kind === "message").map((n) => n.label);
  // Turn one's prompt is still one node — a later turn must not replay it into the graph.
  expect(labels.filter((l) => l === "list files")).toHaveLength(1);
});

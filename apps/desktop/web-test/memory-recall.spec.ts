/**
 * web-test/memory-recall.spec.ts — proves the memory feature actually changes what the model
 * sees. Without this, "memory" is just a store the user can browse — recall-before-send could
 * silently be a no-op and the harness would not notice.
 *
 * Strategy: seed an L1 atom, open the Assistant with memory on (the default), send a question
 * whose keywords overlap the atom, then read the last outbound egress body. The Assistant
 * injects the recalled block as a system message; that is what we assert on.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Store = Record<string, (...a: unknown[]) => unknown>;

interface EgressLogEntry { url: string; body: string | null }
interface ContextNodeRow { id: string; kind: string; label: string; session_id: string | null; meta_json: string | null }
interface ContextEdgeRow { from_id: string; to_id: string; kind: string; weight: number }

async function store<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) => (window as unknown as { __webTest: { store: Store } }).__webTest.store[k]!(),
    key,
  ) as Promise<T>;
}

/** Seed an L1 atom and return its stored id, so a spec can predict its graph node id. */
async function seedL1(page: Page, text: string): Promise<string> {
  return page.evaluate(async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    const m = await host.invoke("memory_capture", {
      layer: "L1", text: t, session_id: "s-recall", subject: null, pinned: false,
    });
    return (m as { id: string }).id;
  }, text);
}

/** Pick the seed-provided text model. The systemai seed publishes `sysai/oracle-mini`. */
async function selectModel(page: Page): Promise<void> {
  const combo = page.getByRole("combobox");
  const value = await combo
    .locator("option")
    .filter({ hasText: /oracle-mini/ })
    .first()
    .evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
}

/** Last body sent to /chat/completions — the model request. */
async function lastChatBody(page: Page): Promise<string> {
  const reqs = await store<EgressLogEntry[]>(page, "requests");
  const last = [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body);
  return last?.body ?? "";
}

test("memory recall: the recalled block lands in the chat-completions request as a system message", async ({ page }) => {
  // Seed an atom the user's question will overlap on. Words "Dhaka" and "timezone" tie the
  // recall to a question like "what is the timezone where you live?".
  await page.goto(`${APP}?seed=systemai`);
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await selectModel(page);
  await page.getByPlaceholder(/Send a message through the router/)
    .fill("what is the timezone where you live?");
  await page.getByRole("button", { name: "Send" }).click();

  // Wait for the streamed answer to land. The mock returns the model id in the body, so
  // matching on that avoids hardcoding the seeded answer text.
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: 30_000 });

  const body = await lastChatBody(page);
  // The recalled block is labeled and bounded so the model can tell it apart from current input.
  expect(body).toContain("Context recalled from memory");
  expect(body).toContain("Tushu lives in Dhaka, which is GMT+6");
  // The user's question is still there too — recall adds context, does not replace.
  expect(body).toContain("what is the timezone where you live?");
});

test("memory recall: a recalled memory lands in the context graph as a memory node + recalled edge", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const memoryId = await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await selectModel(page);
  await page.getByPlaceholder(/Send a message through the router/)
    .fill("what is the timezone where you live?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: 30_000 });

  // recordRecall writes through the buffered recorder, whose flush is fire-and-forget — the
  // node can land a tick after the answer renders, so poll rather than read once.
  await expect
    .poll(async () => (await store<ContextNodeRow[]>(page, "contextNodes")).filter((n) => n.kind === "memory").length)
    .toBeGreaterThan(0);

  const nodes = await store<ContextNodeRow[]>(page, "contextNodes");
  const edges = await store<ContextEdgeRow[]>(page, "contextEdges");
  const memoryNode = nodes.find((n) => n.kind === "memory");
  // The node id is derived from the memory's own id, not generated — that is what lets the host
  // collapse repeat recalls into one node instead of one per occurrence.
  expect(memoryNode?.id).toBe(`memory:${memoryId}`);
  expect(memoryNode?.meta_json).toContain('"layer":"L1"');
  expect(edges.some((e) => e.kind === "recalled")).toBe(true);
});

test("memory recall: recalling the same memory twice leaves one node with two edges", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const memoryId = await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await selectModel(page);
  const box = page.getByPlaceholder(/Send a message through the router/);
  const send = page.getByRole("button", { name: "Send" });

  // Both questions must share a token with the stored atom: recall is BM25 over tokens, with no
  // embeddings behind it, so a paraphrase that overlaps in meaning but not in words returns
  // nothing. "Tushu" and "Dhaka" are the distinctive ones here.
  const questions = ["where does Tushu live?", "what is the timezone in Dhaka?"];
  for (const [i, question] of questions.entries()) {
    await box.fill(question);
    await send.click();
    // Each assistant message node is created after its answer streams and flushed in `finally`,
    // so waiting for one more of them means this turn has finished AND its batch has landed.
    // Waiting on the answer bubble instead would race: the recalled edge is written before the
    // model is even called, so the graph would look done while the turn was still running.
    await expect
      .poll(
        async () =>
          (await store<ContextNodeRow[]>(page, "contextNodes")).filter(
            (n) => n.kind === "message" && n.label.startsWith("Hello from "),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(i + 1);
  }

  const nodes = await store<ContextNodeRow[]>(page, "contextNodes");
  const edges = await store<ContextEdgeRow[]>(page, "contextEdges");

  // No id is ever duplicated. The host upserts on id, so a repeat write updates one row — this
  // is the invariant that a generated node id silently broke.
  const ids = nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);

  // The seeded memory has exactly one node, however many turns recalled it. Other memory nodes
  // may legitimately exist: turn one's own L0 rows become recallable on turn two, which is the
  // layering doing its job, not duplication.
  expect(nodes.filter((n) => n.id === `memory:${memoryId}`)).toHaveLength(1);

  // Two different messages recalled it, so two edges point at that one node.
  const recalled = edges.filter((e) => e.kind === "recalled" && e.to_id === `memory:${memoryId}`);
  expect(recalled).toHaveLength(2);
  expect(new Set(recalled.map((e) => e.from_id)).size).toBe(2);
});

test("memory recall: toggling memory off skips the recall path entirely", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await selectModel(page);
  // Uncheck the memory toggle — it is on by default. The label wraps the input, so
  // getByLabel is the reliable handle here (the same form as the "agent mode" toggle).
  await page.getByLabel("memory").uncheck();
  await page.getByPlaceholder(/Send a message through the router/)
    .fill("what is the timezone where you live?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: 30_000 });

  const body = await lastChatBody(page);
  expect(body).not.toContain("Context recalled from memory");
  expect(body).not.toContain("Tushu lives in Dhaka");
});
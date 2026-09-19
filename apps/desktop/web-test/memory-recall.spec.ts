/**
 * web-test/memory-recall.spec.ts — proves the memory feature actually changes what the model
 * sees. Without this, "memory" is just a store the user can browse — recall-before-send could
 * silently be a no-op and the harness would not notice.
 *
 * Strategy: seed an L1 atom, open the Playground with memory on (the default), send a question
 * whose keywords overlap the atom, then read the last outbound egress body. The Playground
 * injects the recalled block as a system message; that is what we assert on.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Store = Record<string, (...a: unknown[]) => unknown>;

interface EgressLogEntry { url: string; body: string | null }
interface ContextNodeRow { id: string; kind: string; session_id: string | null; meta_json: string | null }
interface ContextEdgeRow { from_id: string; to_id: string; kind: string }

async function store<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) => (window as unknown as { __webTest: { store: Store } }).__webTest.store[k]!(),
    key,
  ) as Promise<T>;
}

async function seedL1(page: Page, text: string): Promise<void> {
  await page.evaluate(async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    await host.invoke("memory_capture", { layer: "L1", text: t, session_id: "s-recall", subject: null, pinned: false });
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

  await page.getByRole("button", { name: "Playground", exact: true }).click();
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
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Playground", exact: true }).click();
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
  expect(memoryNode?.meta_json).toContain('"layer":"L1"');
  expect(edges.some((e) => e.kind === "recalled")).toBe(true);
});

test("memory recall: toggling memory off skips the recall path entirely", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");

  await page.getByRole("button", { name: "Playground", exact: true }).click();
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
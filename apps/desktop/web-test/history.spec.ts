/**
 * web-test/history.spec.ts — the History screen: sessions indexed, one session read as a timeline.
 *
 * The two things worth testing here are the two things a naive implementation gets wrong, and
 * neither is visible from a single-turn fixture:
 *
 *   1. Order. An agent run is recorded in one batch, so every node in it shares one timestamp.
 *      A timeline sorted by `ts` puts the turns in whatever order SQLite happened to return
 *      them. Order has to come from the sequence number in the node id.
 *   2. Attribution. Calls are batched ahead of results, so the node after a `skill` node is
 *      usually the *next call*, not its result. The result is only reachable through the
 *      `produced` edge — the seeded graph below crosses the pairs so adjacency gives the
 *      wrong answer and the test can tell the difference.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

interface SeedNode {
  id: string; kind: string; label: string; source: string;
  session_id: string; ts: number; meta_json: string | null;
}
interface SeedEdge {
  id: string; from_id: string; to_id: string; kind: string; weight: number; ts: number; meta_json: null;
}

/**
 * One session, written the way the Assistant writes one: a user turn, an assistant turn whose
 * text is empty because it only called tools, then the calls, then the results.
 */
async function seedSession(
  page: Page,
  session: string,
  ts: number,
  opts: { crossPairResults?: boolean; memories?: number; scramble?: boolean } = {},
): Promise<void> {
  const id = (k: string, n: number) => `${k}:${session}:${n}`;
  const nodes: SeedNode[] = [
    { id: id("message", 1), kind: "message", label: "what is in this folder", source: "ui",
      session_id: session, ts, meta_json: '{"role":"user","model":"mock/oracle-1"}' },
    { id: id("message", 2), kind: "message", label: "", source: "ui",
      session_id: session, ts, meta_json: '{"role":"assistant","model":"mock/oracle-1"}' },
    { id: id("skill", 3), kind: "skill", label: "list_dir", source: "ui",
      session_id: session, ts, meta_json: null },
    { id: id("skill", 4), kind: "skill", label: "read_file", source: "ui",
      session_id: session, ts, meta_json: null },
    { id: id("artifact", 5), kind: "artifact", label: "main.rs", source: "ui",
      session_id: session, ts, meta_json: '{"tool_call_id":"c1"}' },
    { id: id("artifact", 6), kind: "artifact", label: "fn main() {}", source: "ui",
      session_id: session, ts, meta_json: '{"tool_call_id":"c2"}' },
  ];
  for (let i = 0; i < (opts.memories ?? 0); i++) {
    nodes.push({
      id: `memory:m-${i}`, kind: "memory", label: `remembered thing ${i}`, source: "engine",
      session_id: session, ts, meta_json: '{"layer":"L3"}',
    });
  }
  const edges: SeedEdge[] = [
    { id: "e1", from_id: id("message", 1), to_id: id("message", 2), kind: "follows", weight: 1, ts, meta_json: null },
    { id: "e2", from_id: id("message", 2), to_id: id("skill", 3), kind: "used", weight: 1, ts, meta_json: null },
    { id: "e3", from_id: id("message", 2), to_id: id("skill", 4), kind: "used", weight: 1, ts, meta_json: null },
    // Crossed on purpose: list_dir -> "fn main() {}", read_file -> "main.rs".
    { id: "e4", from_id: id("skill", 3), to_id: id("artifact", opts.crossPairResults ? 6 : 5), kind: "produced", weight: 1, ts, meta_json: null },
    { id: "e5", from_id: id("skill", 4), to_id: id("artifact", opts.crossPairResults ? 5 : 6), kind: "produced", weight: 1, ts, meta_json: null },
  ];
  for (let i = 0; i < (opts.memories ?? 0); i++) {
    edges.push({
      id: `em${i}`, from_id: id("message", 1), to_id: `memory:m-${i}`,
      kind: "recalled", weight: 1, ts, meta_json: null,
    });
  }
  // Scrambled insertion with one shared timestamp: nothing about the row order or the clock
  // survives, so only the node-id sequence can put the turns back in order. Without this the
  // test would also pass on a stable sort by `ts`, and prove nothing.
  const ordered = opts.scramble
    ? [nodes[5], nodes[3], nodes[1], nodes[4], nodes[2], nodes[0], ...nodes.slice(6)]
    : nodes;
  await page.evaluate(
    async ({ nodes, edges }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__webTest.invoke("context_record", { nodes, edges });
    },
    { nodes: ordered, edges },
  );
}

async function openHistory(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=or-router`);
  await page.getByRole("button", { name: "History", exact: true }).click();
}

test("history: a recorded session is indexed by what the user first said", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await seedSession(page, "s-a", Date.now());
  await page.getByRole("button", { name: "History", exact: true }).click();

  const row = page.getByTestId("history-session");
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("what is in this folder");
  // The index counts messages, not nodes: six nodes, two of them messages.
  await expect(row).toContainText("2 turns");
  await expect(row).toContainText("2 tools");
});

test("history: the timeline shows the turn, the calls and each call's own result", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await seedSession(page, "s-b", Date.now(), { crossPairResults: true });
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect(page.getByText("what is in this folder").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("list_dir", { exact: true })).toBeVisible();
  await expect(page.getByText("read_file", { exact: true })).toBeVisible();

  // Crossed pairs: adjacency would hand list_dir the *next* artifact ("main.rs"). Only the
  // `produced` edge can produce this pairing.
  const listDir = page.locator("div.rounded.border").filter({ hasText: "list_dir" }).last();
  await expect(listDir).toContainText("fn main() {}");
  const readFile = page.locator("div.rounded.border").filter({ hasText: "read_file" }).last();
  await expect(readFile).toContainText("main.rs");
});

test("history: turns keep their order when every node shares one timestamp", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  // One `ts` for the whole run — the batching that makes time useless as a tiebreak.
  await seedSession(page, "s-c", 1_700_000_000_000, { scramble: true });
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect(page.getByText("what is in this folder").first()).toBeVisible({ timeout: 15_000 });
  // `data-kind` is in document order, so this is the rendered order of the run. `.tool` is
  // prefixed with the call name to prove the two calls did not swap places.
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-kind]")).map((el) => {
      const kind = el.getAttribute("data-kind") ?? "";
      if (kind !== "tool") return kind;
      const t = el.textContent ?? "";
      return t.includes("list_dir") ? "tool:list_dir" : "tool:read_file";
    }),
  );
  expect(order).toEqual(["user", "assistant", "tool:list_dir", "tool:read_file"]);
});

test("history: recalled memories collapse to a count on the user turn", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await seedSession(page, "s-d", Date.now(), { memories: 3 });
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect(page.getByText("3 recalled")).toBeVisible({ timeout: 15_000 });
  // Three memory nodes exist, but they are context, not turns — the timeline must not grow.
  await expect(page.getByTestId("history-session")).toContainText("2 turns");
  await expect(page.locator('[data-kind="tool"]')).toHaveCount(2);
  await expect(page.locator('[data-kind="user"]')).toHaveCount(1);
});

test("history: sessions are grouped by day and the newest opens first", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  const now = Date.now();
  await seedSession(page, "s-old", now - 3 * 86_400_000);
  await seedSession(page, "s-new", now);
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect(page.getByTestId("history-session")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByText("Today", { exact: true })).toBeVisible();
  // Two day headings: today and the older one.
  const headings = page.locator("div.sticky");
  await expect(headings).toHaveCount(2);
  // Newest first, and it is the one whose timeline is open.
  const first = page.getByTestId("history-session").first();
  await expect(first).toContainText("what is in this folder");
  await expect(first).toHaveAttribute("data-session", "s-new");
});

test("history: with nothing recorded the screen says so instead of showing an empty rail", async ({ page }) => {
  await openHistory(page);
  await expect(
    page.getByText(/No sessions recorded yet/),
  ).toBeVisible({ timeout: 15_000 });
});

test("history: picking another session swaps the timeline", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  const now = Date.now();
  await seedSession(page, "s-old", now - 3 * 86_400_000);
  await page.evaluate(
    async ({}) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const host = (window as any).__webTest;
      await host.invoke("context_record", {
        nodes: [
          { id: "message:s-two:1", kind: "message", label: "second session question", source: "ui",
            session_id: "s-two", ts: Date.now(), meta_json: '{"role":"user","model":"mock/oracle-1"}' },
        ],
        edges: [],
      });
    },
    {},
  );
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect(page.getByTestId("history-session")).toHaveCount(2, { timeout: 15_000 });
  await page.getByTestId("history-session").filter({ hasText: "second session question" }).click();
  await expect(page.getByText("second session question").last()).toBeVisible();
  await expect(page.getByText("what is in this folder")).toHaveCount(1); // index row only, not the timeline
});

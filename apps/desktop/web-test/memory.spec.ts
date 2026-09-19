/**
 * web-test/memory.spec.ts — the P7 Memory screen, rendered and driven.
 *
 * Ranking itself is pinned by the Rust tests in memory.rs against real FTS5/BM25. What this file
 * is for is the thing a type-check cannot answer: does the screen come up, are the four layers
 * distinguishable in it, and are search / pin / forget actually wired to the host rather than
 * painted on.
 *
 * The app is the genuine one (see shim.ts); only the Rust host is stood in for.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Store = Record<string, (...a: unknown[]) => unknown>;

/** Read-only view of the shim's host store — wire-level truth, straight from the source. */
async function store<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) => (window as unknown as { __webTest: { store: Store } }).__webTest.store[k]!(),
    key,
  ) as Promise<T>;
}

interface MemoryRow { id: string; layer: string; text: string; pinned: number }

/**
 * The row containing `text`. Two filters, because a bare hasText match lands on the innermost
 * div — the text node, which has no buttons in it — and only the row itself owns "forget".
 */
function rowFor(page: Page, text: string) {
  return page
    .locator("div")
    .filter({ hasText: text })
    .filter({ has: page.getByRole("button", { name: "forget" }) })
    .last();
}

/**
 * Seed through the host. There is no way to reach these layers from the UI — distillation needs
 * a real model round-trip — and a table that renders is not worth spending one on.
 */
async function seedMemories(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    await host.invoke("memory_capture", {
      layer: "L0", text: "what timezone are you in?", session_id: "s1", subject: "user", pinned: false,
    });
    await host.invoke("memory_capture", {
      layer: "L1", text: "Tushu lives in Dhaka, which is GMT+6", session_id: "s1", subject: null, pinned: false,
    });
    await host.invoke("memory_capture", {
      layer: "L1", text: "Prefers answers that lead with the conclusion", session_id: "s1", subject: null, pinned: false,
    });
    await host.invoke("memory_capture", {
      layer: "L3", text: "Works on the AI-Provider Router desktop app", session_id: "s1", subject: null, pinned: false,
    });
  });
}

test("memory: the four layers are listed and the header counts them separately", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();

  // Per-layer counts are the only way to tell L0 from L1 at a glance.
  await expect(page.getByText("1 raw · 2 atoms · 0 scenarios · 1 core")).toBeVisible();
  await expect(page.getByText("Tushu lives in Dhaka, which is GMT+6")).toBeVisible();
  await expect(page.getByText("Works on the AI-Provider Router desktop app")).toBeVisible();
});

test("memory: a layer filter narrows the list", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "L1 atoms" }).click();

  await expect(page.getByText("Tushu lives in Dhaka, which is GMT+6")).toBeVisible();
  await expect(page.getByText("Works on the AI-Provider Router desktop app")).toHaveCount(0);
  await expect(page.getByText("what timezone are you in?")).toHaveCount(0);
});

test("memory: search returns the on-topic memory with a score", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByPlaceholder("search memory…").fill("Dhaka timezone");

  await expect(page.getByText("Tushu lives in Dhaka, which is GMT+6")).toBeVisible();
  // A score proves the result came back from recall, not from the unfiltered list.
  await expect(rowFor(page, "Tushu lives in Dhaka")).toContainText(/bm25 -/);
  // "Prefers answers…" shares no words with the query, so it must not be recalled.
  await expect(page.getByText("Prefers answers that lead with the conclusion")).toHaveCount(0);
});

test("memory: forget removes the row from the store, pin only marks it", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await rowFor(page, "Tushu lives in Dhaka").getByRole("button", { name: "forget" }).click();

  await expect(page.getByText("Tushu lives in Dhaka, which is GMT+6")).toHaveCount(0);
  await expect.poll(async () => (await store<MemoryRow[]>(page, "memories")).length).toBe(3);

  // Pinning is a flag, not a delete — the memory stays, it just stops being droppable by rank.
  await rowFor(page, "Prefers answers that lead").getByRole("checkbox").check();
  await expect
    .poll(async () => (await store<MemoryRow[]>(page, "memories")).filter((m) => m.pinned === 1).length)
    .toBe(1);
  await expect.poll(async () => (await store<MemoryRow[]>(page, "memories")).length).toBe(3);
});

test("memory: an empty store explains itself instead of showing a blank panel", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByText(/No memories yet/)).toBeVisible();
});

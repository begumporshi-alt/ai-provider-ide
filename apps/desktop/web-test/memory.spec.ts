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

  const list = page.getByTestId("memory-list");
  await expect(list.getByText("Tushu lives in Dhaka, which is GMT+6")).toBeVisible();
  // L3 lives in Core profile, not in the derived list — its absence here is the contract.
  await expect(list.getByText("Works on the AI-Provider Router desktop app")).toHaveCount(0);
  await expect(list.getByText("what timezone are you in?")).toHaveCount(0);
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

test("memory: browsing groups rows under a day header and dates each row by clock time", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();

  // Browsing is chronological, so the date is the axis and it gets a header with a count.
  await expect(page.getByTestId("memory-day").first()).toContainText(/Today · \d+/);
  // The header supplied the date, so the row carries the exact clock time rather than a relative
  // age that would only restate it. `MemoryWhen`'s `dated` prop is what switches the two.
  await expect(rowFor(page, "Tushu lives in Dhaka")).toContainText(/\d{1,2}:\d{2}/);
});

test("memory: a search result shows a relative age, because it is ranked and not dated", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByPlaceholder("search memory…").fill("Dhaka timezone");

  // Grouping ranked results by day would contradict the ranking they came back in, so the list
  // stays flat and each row is aged relative to now.
  await expect(page.getByTestId("memory-day")).toHaveCount(0);
  await expect(rowFor(page, "Tushu lives in Dhaka")).toContainText(/just now|\d+[mhd] ago/);
});

test("memory: re-recording a fact adds no redundant 'first' line", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedMemories(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(rowFor(page, "Tushu lives in Dhaka")).toBeVisible();

  // Re-record the same atom, which refreshes `updated_at` in place rather than duplicating. Both
  // timestamps still read the same, so the row must not print "… · first …".
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    const all = await host.invoke("memory_list", { layer: "L1", limit: 50 });
    const atom = (all as { id: string; text: string }[]).find((m) => m.text.includes("Dhaka"));
    await host.invoke("memory_update", { id: atom!.id, text: "Tushu lives in Dhaka, which is GMT+6" });
  });

  await expect(rowFor(page, "Tushu lives in Dhaka")).not.toContainText("first");
  // Still four rows — refreshing in place is the whole point of the dedupe on (layer, text).
  await expect.poll(async () => (await store<MemoryRow[]>(page, "memories")).length).toBe(4);
});

test("memory: an empty window reads differently from an empty store", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  // These are two different facts and must not share a message: "you have recorded nothing" and
  // "you have recorded nothing *in this window*" call for different next actions.
  await expect(page.getByText(/No memories yet/)).toBeVisible();
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(page.getByText("Nothing recorded in the last 7 days.")).toBeVisible();
  await expect(page.getByText(/No memories yet/)).toHaveCount(0);

  // And the way back is offered, so the filter cannot strand the user in an empty view.
  await page.getByRole("button", { name: "all", exact: true }).click();
  await expect(page.getByText(/No memories yet/)).toBeVisible();
});

test("memory: the core profile section lets the user add, edit, and forget L3 facts", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  // Add: the textarea accepts a fact, "save as core" wires through captureMemory + the host.
  const textarea = page.locator("textarea").first();
  await textarea.fill("I write Rust by day and TypeScript by night");
  await page.getByRole("button", { name: "save as core" }).click();
  await expect(page.getByText("I write Rust by day and TypeScript by night", { exact: true })).toBeVisible();

  await expect
    .poll(async () => (await store<MemoryRow[]>(page, "memories")).filter((m) => m.layer === "L3").length)
    .toBe(1);

  // Edit: rewriting a fact goes through memory_update, not delete+add. The row's edit textarea
  // appears above the add textarea, so it is nth(0) in document order.
  await page.getByRole("button", { name: "edit", exact: true }).click();
  const editBox = page.locator("textarea").nth(0);
  await editBox.fill("I write Rust by day and TypeScript by night, in that order");
  await page.getByRole("button", { name: "save", exact: true }).click();
  await expect(page.getByText("I write Rust by day and TypeScript by night, in that order", { exact: true })).toBeVisible();
  await expect(page.getByText(/write Rust by day and TypeScript by night$/)).toHaveCount(0);
  // The id is preserved — it's an edit, not a delete+add.
  await expect.poll(async () => (await store<MemoryRow[]>(page, "memories")).length).toBe(1);

  // Forget: the dedicated forget on the row removes it without touching the rest of the store.
  await page.getByRole("button", { name: "forget", exact: true }).click();
  await expect(page.getByText(/write Rust by day/)).toHaveCount(0);
});

test("memory: pinned L3 rows survive a recall that did not rank them", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    // L1 atoms that will dominate the BM25 ranking
    await host.invoke("memory_capture", { layer: "L1", text: "Router gateway listens on 8787", session_id: "s1", subject: null, pinned: false });
    await host.invoke("memory_capture", { layer: "L1", text: "Workspace root must be set before agent mode", session_id: "s1", subject: null, pinned: false });
    // A pinned L3 that shares no words with the query — pinned must still surface it.
    await host.invoke("memory_capture", { layer: "L3", text: "Building a Tauri app", session_id: null, subject: null, pinned: true });
  });
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  // The L3 fact shows in the Core profile section even when the L1 filter is selected.
  await page.getByRole("button", { name: "L1 atoms" }).click();
  await expect(page.getByText("Building a Tauri app")).toBeVisible();
});

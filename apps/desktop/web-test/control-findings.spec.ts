/**
 * web-test/control-findings.spec.ts — what the Control switchboard says when memory cannot be
 * searched, and what it must not say.
 *
 * The distinction is the one D71 restored. `no_candidates` means the search *ran* and matched
 * nothing; `no_store` and `recall_failed` mean it never ran at all. Until 2026-09-26 all three
 * collapsed into one reason string in `context_scope.rs`, so the screen reported a missing database
 * — or a query that threw — as "found no candidate facts": a claim about the operator's corpus
 * rather than about the fault.
 *
 * The negative case is the one that carries the property. A screen that raised the blocker for
 * *every* miss would satisfy the positive assertions alone, and would be precisely the defect the
 * split exists to remove.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Host = {
  injectionStats: (next: Record<string, unknown>) => void;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Open Control on the Memory tab with the injection counts a spec arranges.
 *
 * Findings are filtered by the active tab (`Control.tsx:1248`), so selecting the tab is part of
 * reaching the copy rather than scenery. The master switch is turned on first because the
 * empty-corpus warning is gated on it and the harness ships it off — the negative case below needs
 * the warning it contrasts against to be reachable.
 */
async function openMemoryTab(
  page: Page,
  stats: { counts: Record<string, number>; total: number },
): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async (s) => {
    const t = (window as unknown as { __webTest: Host }).__webTest;
    t.injectionStats(s);
    await t.invoke("gateway_set_memory_enabled", { enabled: true });
  }, stats);
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "Memory & context" }).click();
}

test("a recall that failed is reported as a fault, not as an empty corpus", async ({ page }) => {
  await openMemoryTab(page, { counts: { recall_failed: 4, injected: 0 }, total: 4 });

  await expect(page.getByText("Memory could not be searched")).toBeVisible();
  await expect(page.getByText(/4 of 4 requests never reached a result/)).toBeVisible();
});

test("a missing store is reported as a fault too", async ({ page }) => {
  await openMemoryTab(page, { counts: { no_store: 3, injected: 0 }, total: 3 });

  await expect(page.getByText("Memory could not be searched")).toBeVisible();
  await expect(page.getByText(/3 of 3 requests never reached a result/)).toBeVisible();
});

test("an empty corpus alone does not raise the fault blocker", async ({ page }) => {
  // The whole point of the split: this search ran and matched nothing, so it is a statement about
  // the corpus and must stay a warning rather than a blocker.
  await openMemoryTab(page, { counts: { no_candidates: 4, injected: 0 }, total: 4 });

  await expect(page.getByText("Memory could not be searched")).toHaveCount(0);
  await expect(page.getByText("Memory is on, but nothing has been injected")).toBeVisible();
  await expect(page.getByText("4 of 4 requests found no candidate facts.")).toBeVisible();
});

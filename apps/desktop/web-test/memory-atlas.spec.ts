/**
 * web-test/memory-atlas.spec.ts — the Mind Atlas on the Memory screen.
 *
 * The graph builder's honesty rules are pinned by unit tests (atlas.test.ts); what this spec
 * proves is the wiring against the real shim: rows the store holds become a section with the
 * counts the rows imply, the legend, a canvas, and a collapse toggle. The canvas layout itself
 * is simulated — a node's pixel position is not a contract, so the spec never clicks into it.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

async function seed(page: Page) {
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    await h.invoke("memory_capture", { layer: "L1", text: "Ships from the workspace root", sessionId: "s-atlas", subject: null, pinned: false });
    await h.invoke("memory_capture", { layer: "L1", text: "Wants tests over assertions", sessionId: "s-atlas", subject: null, pinned: true });
    await h.invoke("memory_capture", { layer: "L2", text: "PnP monorepo habits", sessionId: "s-atlas-2", subject: null, pinned: false });
    await h.invoke("memory_capture", { layer: "L3", text: "Prefers honest counts", sessionId: null, subject: null, pinned: true });
  });
}

test("mind atlas: the store renders as a shape with its counts, and can be hidden", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seed(page);

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const atlas = page.getByTestId("mind-atlas");
  await expect(atlas).toBeVisible();

  // Four rows in, the counts line names the truth the graph draws: two conversations, one
  // memory that belongs to no conversation at all.
  const counts = page.getByTestId("atlas-counts");
  await expect(counts).toContainText("4 memories");
  await expect(counts).toContainText("2 sessions");
  await expect(counts).toContainText("1 unfiled");

  await expect(page.getByTestId("atlas-legend")).toContainText("L1 atoms");
  await expect(page.getByTestId("atlas-legend")).toContainText("superseded");
  await expect(atlas.locator("canvas")).toHaveCount(1);

  // The atlas is a view, not furniture: hiding it removes the canvas, showing it returns.
  await page.getByTestId("atlas-toggle").click();
  await expect(atlas.locator("canvas")).toHaveCount(0);
  await expect(counts).toBeVisible();
  await page.getByTestId("atlas-toggle").click();
  await expect(atlas.locator("canvas")).toHaveCount(1);
});

test("mind atlas: an empty store draws no atlas at all", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByTestId("mind-atlas")).toHaveCount(0);
  // The screen still says something — the list's empty state carries the "how it fills" story.
  await expect(page.getByText("No memories yet")).toBeVisible();
});

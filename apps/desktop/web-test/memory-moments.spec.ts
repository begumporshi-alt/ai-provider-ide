/**
 * web-test/memory-moments.spec.ts — proves the memory loop's two visible moments in the chat:
 *
 *   1. The recall card — a turn that answered from remembered knowledge says so under the reply,
 *      and the reader can expand it, pin it, and forget it right there.
 *   2. The learning strip — when distillation stores new atoms, the chat announces what was just
 *      learned, and the reader can act on it the same way.
 *
 * Everything below drives the real pipeline: recall through the Assistant's own send path, and
 * learning through the engine's batched distillation (three turns accumulate a batch; the mock's
 * distil branch returns the atoms). Nothing is mocked at the component level.
 */
import { expect, test, type Page, type Locator } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

interface MemoryRow {
  id: string;
  layer: string;
  text: string;
  pinned: boolean;
}

async function listMemories(page: Page): Promise<MemoryRow[]> {
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    return (await h.invoke("memory_list", { limit: 200 })) as MemoryRow[];
  });
}

async function seedL1(page: Page, text: string): Promise<string> {
  return page.evaluate(async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__webTest;
    const m = await h.invoke("memory_capture", {
      layer: "L1", text: t, sessionId: "s-moments", subject: null, pinned: false,
    });
    return (m as { id: string }).id;
  }, text);
}

async function openAssistant(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
}

const composer = (page: Page): Locator => page.getByPlaceholder(/Message your assistant/);
const send = (page: Page): Locator => page.getByRole("button", { name: "Send" });

test("recall card: a turn that used memory says what it drew on, and the reader can act on it", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");
  await openAssistant(page);

  await composer(page).fill("what is the timezone where you live?");
  await send(page).click();

  // The card is attached to the answer while it is still streaming — recall happens before the
  // request, so the card must not wait for the stream to end.
  const card = page.getByTestId("recall-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Drew on 1 thing I remember");

  // Collapsed by default; expanding shows the remembered fragment itself, labelled by layer.
  await page.getByTestId("recall-toggle").click();
  const row = page.getByTestId("recall-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Tushu lives in Dhaka, which is GMT+6");
  await expect(row).toContainText("fact");

  // Pin from the card, and the store agrees.
  await page.getByTestId("recall-pin").click();
  await expect(page.getByTestId("recall-pin")).toHaveText("pinned");
  const pinned = await listMemories(page);
  expect(pinned.find((m) => m.text.includes("Dhaka"))?.pinned).toBe(true);

  // Forget from the card: the row leaves the card and the store.
  await page.getByTestId("recall-forget").click();
  await expect(page.getByTestId("recall-row")).toHaveCount(0);
  await expect(card).not.toBeVisible();
  const after = await listMemories(page);
  expect(after.find((m) => m.text.includes("Dhaka"))).toBeUndefined();
});

test("learning strip: the third turn's distillation is announced, and the atom can be forgotten", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await openAssistant(page);

  // Distillation batches three turns (DISTIL_EVERY); the third turn's `finally` runs it.
  for (let i = 1; i <= 3; i++) {
    await composer(page).fill(`remember this preference number ${i}`);
    await send(page).click();
    await expect(page.getByText("Hello from oracle-mini").last()).toBeVisible({ timeout: 30_000 });
  }

  // The mock's distil branch returns two atoms; each becomes a chip. They arrive asynchronously
  // (distillation is deliberately not awaited), so poll rather than read once.
  const chips = page.getByTestId("learned-chip");
  await expect(chips).toHaveCount(2, { timeout: 30_000 });
  await expect(chips.first()).toContainText("Noted: Prefers tests over assertions");

  // Expand one: the full row with the same actions the recall card has.
  await chips.first().click();
  const row = page.getByTestId("learned-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Prefers tests over assertions");
  await expect(row).toContainText("fact");

  // Forget it from the chip: gone from the strip and from the store.
  await page.getByTestId("learned-forget").click();
  await expect(chips).toHaveCount(1);
  const left = await listMemories(page);
  expect(left.find((m) => m.text === "Prefers tests over assertions")).toBeUndefined();
  expect(left.find((m) => m.text.includes("PnP"))).toBeDefined();
});

test("memory off: neither moment appears — the toggle still governs the whole loop", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await seedL1(page, "Tushu lives in Dhaka, which is GMT+6");
  await openAssistant(page);

  // Uncheck memory in the run configuration (the label wraps the input).
  const { openRunConfig, closeRunConfig } = await import("./run-config");
  await openRunConfig(page);
  await page.getByLabel("memory").uncheck();
  await closeRunConfig(page);

  for (let i = 1; i <= 3; i++) {
    await composer(page).fill(`what is the timezone where you live? (part ${i})`);
    await send(page).click();
    await expect(page.getByText("Hello from oracle-mini").last()).toBeVisible({ timeout: 30_000 });
  }

  await expect(page.getByTestId("recall-card")).toHaveCount(0);
  await expect(page.getByTestId("learned-strip")).toHaveCount(0);
  // And the store really learned nothing: the only L1 row is the one the spec seeded itself.
  const rows = await listMemories(page);
  expect(rows.filter((m) => m.layer === "L1").map((m) => m.text)).toEqual([
    "Tushu lives in Dhaka, which is GMT+6",
  ]);
});

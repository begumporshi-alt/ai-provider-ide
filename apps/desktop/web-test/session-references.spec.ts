/**
 * web-test/session-references.spec.ts — the session's source list, end to end.
 *
 * Three promises, each proven live: a link the user pastes is collected into the session's
 * references; the block built from that list actually reaches the model (read back out of the
 * harness's outgoing-request log, so the assertion is about what was sent, not what the UI
 * claims); and the drawer's curation (add by hand, remove) behaves, with a removal staying
 * removed across a transcript change.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

async function openChat(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
}

type WebTest = {
  __webTest: { store: { requests: () => Array<{ body?: string }> } };
};

test("a pasted link is collected, reaches the model's system turn, and the drawer curates it", async ({ page }) => {
  await openChat(page);

  const rail = page.getByTestId("session-refs-rail");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(rail).toContainText("0 refs");

  // The draft carries a link; the send collects it into the session's references.
  await page.getByPlaceholder(/Message your assistant/).fill("summarize https://example.com/spec please");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("session-refs-rail")).toContainText("1 ref", { timeout: 30_000 });

  await rail.click();
  const drawer = page.getByTestId("session-refs-drawer");
  await expect(drawer).toBeVisible();
  const row = drawer.getByTestId("session-refs-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("https://example.com/spec");
  await expect(row).toContainText("you");

  // The proof that matters: the outgoing request's system turn lists the reference, so every
  // later reply in this conversation reads it — not just the turn that introduced the link.
  const sent = await page.evaluate(() => {
    const web = (window as unknown as WebTest).__webTest;
    const bodies = web.store.requests().map((r) => r.body ?? "");
    return bodies.some((b) => b.includes("References gathered in this session") && b.includes("https://example.com/spec"));
  });
  expect(sent).toBe(true);

  // Pin a second link by hand; it is badged "added".
  await drawer.getByLabel("Add a reference link").fill("https://example.com/notes");
  await drawer.getByTestId("session-refs-add").click();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(2);
  await expect(drawer.getByTestId("session-refs-row").last()).toContainText("added");

  // Removing one keeps it removed — even after another transcript change would re-scan it in.
  await drawer.getByLabel(/Remove https:\/\/example\.com\/spec/).click();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(1);
  await page.getByPlaceholder(/Message your assistant/).fill("one more message mentions https://example.com/spec");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(1);
  await expect(drawer.getByTestId("session-refs-row")).toContainText("https://example.com/notes");
});

test("an invalid manual entry is refused in words, and a new session starts with no references", async ({ page }) => {
  await openChat(page);

  const rail = page.getByTestId("session-refs-rail");
  await rail.click();
  const drawer = page.getByTestId("session-refs-drawer");
  await expect(drawer).toBeVisible();

  await drawer.getByLabel("Add a reference link").fill("not a link at all");
  await drawer.getByTestId("session-refs-add").click();
  await expect(drawer.getByTestId("session-refs-invalid")).toBeVisible();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(0);

  // Collect one, then start a fresh conversation: the reference list is session-scoped.
  await drawer.getByLabel("Add a reference link").fill("https://example.com/only");
  await drawer.getByTestId("session-refs-add").click();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(1);

  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(drawer.getByTestId("session-refs-empty")).toBeVisible();
  await expect(drawer.getByTestId("session-refs-row")).toHaveCount(0);
  // The rail is the drawer's collapsed state — it reads only once the drawer is closed again.
  await page.getByRole("button", { name: "Close session references drawer" }).click();
  await expect(page.getByTestId("session-refs-rail")).toContainText("0 refs");
});

/**
 * web-test/related-sessions.spec.ts — the cross-agent arc, end to end.
 *
 * The shim seeds one foreign Claude session rooted at /tmp/proj-beta. This spec drives the path
 * the feature ships: the manifest lists that session for the workspace, the model asks the agent
 * tools to find and import it, the import writes into this app's own transcript store, and
 * read_session serves the imported rows. The answer quotes a sentence that exists only in the
 * foreign session, so a mock that skipped search → import → store → read could not produce it.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

interface Host {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  // One scoped row so the manifest card renders (its entries drive the card's own gate); the
  // related list is composed independently of it and scoped by the workspace root.
  await page.evaluate(async () => {
    const h = (window as unknown as { __webTest: Host }).__webTest;
    const m = (await h.invoke("memory_capture", {
      layer: "L3",
      text: "I am Tushu",
      sessionId: null,
      subject: null,
      pinned: true,
    })) as { id: string };
    await h.invoke("memory_assign_scope", {
      id: m.id,
      scope: { kind: "global", project: null, agent: null },
    });
  });

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  // The seeded foreign session's root — the manifest only carries related rows scoped to the
  // active workspace ("absence is not global").
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp/proj-beta");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await openRunConfig(page);
  await page.getByTestId("approval-mode").selectOption("yolo");
  await closeRunConfig(page);
}

test("a foreign session is searched, imported, read, and listed in the manifest", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByPlaceholder(/Describe a task for the agent/)
    .fill("find the claude session about the auth flow and load it");
  await page.getByRole("button", { name: "Send" }).click();

  // The three tools ran, in the order the arc needs: discovery, the consenting import, the read.
  for (const name of ["search_agents", "load_session", "read_session"]) {
    await expect(
      page.getByTestId("tool-call-row").filter({ hasText: name }).first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  // The quoted sentence exists only in the foreign session's transcript. It can reach this answer
  // only through the import's transcript write and the read_session that followed it — the mock's
  // fallback (asserted absent below) is what a failed read would have produced.
  await expect(
    page.getByText(
      /The imported session says: keep the previous token valid for one overlap window/,
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText(/\(no imported transcript came back\)/),
  ).toHaveCount(0);

  // The manifest's related section reflects the seeded session for this workspace — the card the
  // user sees before deciding to import. The per-turn composition is a snapshot, so the row may
  // still offer its import affordance after the tool imported it; what this pins is that the
  // workspace-scoped foreign list reached the card at all.
  const card = page.getByTestId("manifest-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator("summary").click();
  await expect(card.getByText("Related sessions (1)")).toBeVisible();
  await expect(
    card.getByText("How do we rotate the refresh token?"),
  ).toBeVisible();
  // The shim also seeds a codex session in another workspace. Scoped means scoped: it must not
  // ride along, or "related" would quietly become "every foreign session on the machine".
  await expect(card.getByText("why is the build slow?")).toHaveCount(0);
});

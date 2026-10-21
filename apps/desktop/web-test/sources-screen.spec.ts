/**
 * web-test/sources-screen.spec.ts — the Sources management screen.
 *
 * The shim seeds one Claude session at /tmp/proj-beta and one Codex session at /tmp/proj-alpha,
 * with empty stubs for every other adapter. These checks navigate the real screen (not the admin
 * routes directly): adapter counts, combined browse/search/filter behavior, and an explicit,
 * idempotent import whose result the row reflects after the listing is re-read.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

async function open(page: Page) {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
}

const sessions = (page: Page) => page.getByTestId("source-session");
const adapter = (page: Page, name: string) =>
  page.locator(`[data-testid="source-adapter"][data-source="${name}"]`);
const row = (page: Page, source: string) =>
  page.locator(`[data-testid="source-session"][data-source="${source}"]`);

test("sources: every adapter is listed with its real count and stub note", async ({
  page,
}) => {
  await open(page);

  // "all" plus the seven adapters, in the host's order.
  await expect(page.getByTestId("source-adapter")).toHaveCount(8);
  await expect(adapter(page, "claude")).toContainText("1");
  await expect(adapter(page, "codex")).toContainText("1");
  // The empty stubs say so instead of looking broken.
  await expect(adapter(page, "workbuddy")).toContainText("no sessions found");
  await expect(adapter(page, "gemini")).toContainText("no sessions found");

  // Both seeded sessions are listed, with the foreign metadata carrying through.
  await expect(sessions(page)).toHaveCount(2);
  await expect(row(page, "claude")).toContainText("auth flow sketch");
  await expect(row(page, "claude")).toContainText("/tmp/proj-beta");
  await expect(row(page, "codex")).toContainText("/tmp/proj-alpha");
});

test("sources: search and the source/root filters compose", async ({ page }) => {
  await open(page);
  const search = page.getByPlaceholder(/Search sessions, workspaces/);

  await search.fill("refresh");
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page).first()).toHaveAttribute("data-source", "claude");

  await search.fill("zzznopezz");
  await expect(page.getByText("No sessions match these filters.")).toBeVisible();

  // A source filter with nothing behind it yields the same honest empty state.
  await search.fill("");
  await adapter(page, "zcode").click();
  await expect(sessions(page)).toHaveCount(0);
  await expect(page.getByText("No sessions match these filters.")).toBeVisible();

  await adapter(page, "claude").click();
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page).first()).toHaveAttribute("data-source", "claude");
  await adapter(page, "claude").click(); // toggle back to "all"

  await page.getByLabel("Workspace root filter").fill("/tmp/proj-alpha");
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page).first()).toHaveAttribute("data-source", "codex");

  // Query plus root: the host fans the query out across every source, and the screen applies
  // the root filter, so the controls still compose.
  await search.fill("build");
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page).first()).toHaveAttribute("data-source", "codex");
});

test("sources: importing is explicit, idempotent and visible", async ({ page }) => {
  await open(page);
  const claude = row(page, "claude");
  await expect(claude).toHaveCount(1);
  await expect(claude.getByText("imported")).toHaveCount(0);

  await page.getByRole("button", { name: "Import sess_1 from claude" }).click();

  // The status line names exactly what was written, and the row flips after the listing re-read.
  await expect(page.getByTestId("source-status")).toContainText("imp-claude-sess_1");
  await expect(page.getByTestId("source-status")).toContainText("4 turn(s)");
  await expect(page.getByTestId("source-status")).toContainText("untouched");
  await expect(claude.getByText("imported")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import sess_1 from claude" }),
  ).toHaveCount(0);

  // Leaving and coming back re-reads the host: the deterministic import id is the idempotency
  // key, so the row is still "imported" rather than offering a duplicate write.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(row(page, "claude").getByText("imported")).toBeVisible();
  await expect(sessions(page)).toHaveCount(2);
});

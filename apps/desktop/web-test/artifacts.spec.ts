/**
 * web-test/artifacts.spec.ts — the artifact cards, driven through the real run path.
 *
 * Four things the transcript can now show that it could not before, each asserted where it can
 * actually be falsified:
 *
 *  1. an HTML file the agent WROTE is previewed live (the frame's content is read, not just the
 *     frame's existence — a card that renders an empty frame would pass a weaker check);
 *  2. a PDF renders its pages, which means the real pdf.js parsed real bytes the host handed over
 *     base64 — the fixture is verified parseable by scripts/make-fixture-pdf.mjs;
 *  3. an image file decodes to an <img> with a blob: source (the CSP-allowed image path);
 *  4. a loopback URL the model names is fetched through the host's egress path and shown, while a
 *     host outside the allowlist gets the browser offer instead of a failed fetch.
 *
 * The oracle variants live in mock.mjs (`write page` / `write pdf` / `write logo` / `localhost
 * link` / `remote link`); the reads are answered by the shim's `artifact_read`.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

async function openAgentChat(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByPlaceholder(/Describe a task for the agent/).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("an HTML file the agent wrote is previewed from disk, live", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "write page for me");

  // The write goes through the ordinary approval gate; the card appears beside its diff.
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  const card = page.getByTestId("tool-artifact");
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The header names the file, and the frame is the real page — its text is read out of the
  // sandboxed frame, so an empty or wrong document cannot pass.
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
  const frame = page.frameLocator('[data-testid="html-preview-frame"]');
  await expect(frame.getByText("Written by the agent")).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByText("This file is on disk and previewed from there.")).toBeVisible();

  // Still sandboxed: scripts may run, the opaque origin may not reach this app's storage.
  const sandbox = await page.getByTestId("html-preview-frame").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
});

test("a PDF the agent wrote renders its pages", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "write pdf for me");

  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  const card = page.getByTestId("tool-artifact");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("artifact-name")).toHaveText("report.pdf");

  // The real renderer, on real bytes: a canvas with a non-zero box. A stub would show the
  // page count and no canvas, which is why the canvas is what gets asserted.
  await expect(page.getByTestId("pdf-pagecount")).toHaveText("1 page", { timeout: 45_000 });
  const canvas = page.getByTestId("pdf-page-1");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(80);
  expect(box?.height ?? 0).toBeGreaterThan(40);
  // Nothing failed on the way: no error card, and no per-page failure either.
  await expect(page.getByTestId("pdf-error")).toHaveCount(0);
  await expect(page.getByTestId("pdf-page-error-1")).toHaveCount(0);
});

test("an image the agent wrote is decoded and shown", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "write logo for me");

  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  await expect(page.getByTestId("tool-artifact")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("artifact-name")).toHaveText("logo.png");
  const img = page.getByTestId("artifact-image");
  await expect(img).toBeVisible();
  // Parsed by the engine, so a broken byte stream cannot pass as a rendered image.
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(await img.getAttribute("src")).toMatch(/^blob:/);
});

test("a loopback URL is fetched and shown; a remote link goes to the browser", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);

  // --- loopback: through the host's egress path, rendered in the frame ------------------
  await page.getByPlaceholder(/Message your assistant/).fill("localhost link please");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("url-preview")).toBeVisible({ timeout: 30_000 });
  // The host is the card's title and the full URL sits under it, so a reader can tell which
  // path of a dev server they are looking at.
  // `exact: true` because the host also appears inside the URL in the subtitle — a substring
  // match resolves to both and Playwright's strict mode rejects it.
  await expect(page.getByTestId("url-preview").getByText("127.0.0.1:18901", { exact: true })).toBeVisible();
  await expect(page.getByTestId("html-preview-subtitle")).toHaveText("http://127.0.0.1:18901/demo");
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
  const frame = page.frameLocator('[data-testid="html-preview-frame"]');
  await expect(frame.getByText("Demo server")).toBeVisible({ timeout: 30_000 });

  // --- remote: no card (the policy cannot fetch it, so a card would be an apology box),
  //     and clicking the link hands the URL to the browser instead of navigating the app ----
  await page.getByPlaceholder(/Message your assistant/).fill("remote link please");
  await page.getByRole("button", { name: "Send" }).click();
  const link = page.getByRole("link", { name: "https://example.com/guide" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  // Exactly one frame on screen: the loopback card's. The remote link must not have started one.
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
  await expect(page.getByTestId("url-preview")).toHaveCount(1);

  await link.click();
  // The click reached the OS opener — asserted through the harness's log, not by "nothing threw".
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __webTest: { openerCalls: () => string[] } }).__webTest.openerCalls()))
    .toContain("https://example.com/guide");
  // And the app is still the app: a link click must never navigate the webview away.
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("url-preview")).toHaveCount(1);
});

/**
 * The complaint this test exists for (2026-10-10): "preview of html/docs showing after every edit".
 *
 * One run writes the SAME file twice. Before the fix the transcript rendered one card per write —
 * two sandboxed iframes, two host reads, the first showing content the second had already replaced.
 * ZCode's own model is the reference: its bundle carries `artifactId` / `artifactVersionId` /
 * `artifactDisplayName` and an `openArtifact` affordance, i.e. one artifact with versions rather
 * than a card per write.
 *
 * Two diffs and ONE card is the assertion: the diffs are the run's process and stay per-write; the
 * preview is its output, so it appears once, at the newest write, and shows the FINAL content.
 */
test("a file written twice in one run gets one preview, showing the final content", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "write page twice please");

  // Both writes go through the gate, so both are real tool calls in the transcript.
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allow this change?" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();

  // The run ends, and only then does the preview appear.
  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });

  // Both writes are on record...
  await expect(page.getByRole("group", { name: /Diff of site\/index.html/ })).toHaveCount(2);
  // ...and exactly one card renders the file.
  await expect(page.getByTestId("tool-artifact")).toHaveCount(1);
  const frame = page.frameLocator('[data-testid="html-preview-frame"]');
  await expect(frame.getByText("FINAL MARK")).toBeVisible({ timeout: 30_000 });
  // --- version history: the superseded write is still reachable -------------------------
  // Two writes = two versions. The card walks them, and a recorded version renders from the
  // transcript rather than from disk, which is what makes history work after the file moved on.
  await expect(page.getByTestId("artifact-versions")).toBeVisible();
  await expect(page.getByTestId("artifact-version-label")).toHaveText("v2 of 2");
  // The newest version is what is on screen, and it is the live read — "Current" is mounted but
  // hidden, because it RESERVES its width: mounting it conditionally shifted the header 30px and
  // moved the toggle and copy button out from under the cursor (visual gate, 2026-10-10).
  await expect(page.getByTestId("artifact-version-latest")).toBeHidden();

  await page.getByTestId("artifact-version-prev").click();
  await expect(page.getByTestId("artifact-version-label")).toHaveText("v1 of 2");
  await expect(frame.getByText("FIRST MARK")).toBeVisible();
  await expect(frame.getByText("FINAL MARK")).toHaveCount(0);
  // Walking back does not destroy the live view: there is a way home.
  await expect(page.getByTestId("artifact-version-latest")).toBeVisible();

  await page.getByTestId("artifact-version-latest").click();
  await expect(page.getByTestId("artifact-version-label")).toHaveText("v2 of 2");
  await expect(frame.getByText("FINAL MARK")).toBeVisible();
  await expect(frame.getByText("FIRST MARK")).toHaveCount(0);
  // A whole-file write is exact by construction, so the caveat must not appear.
  await expect(page.getByTestId("artifact-version-inexact")).toHaveCount(0);

  // Exactly ONE page is rendered, and it is the final one. `FIRST MARK` does still appear twice on
  // screen — in the first write's diff and in that row's argument summary — and that is correct:
  // those record what the run DID, which is the diffs' job. What must not exist is a second
  // preview rendering the superseded content.
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(1);
  await expect(frame.getByText("FIRST MARK")).toHaveCount(0);
});

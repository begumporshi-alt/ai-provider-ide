/**
 * The error boundary — a render crash must say what happened, not leave an empty window.
 *
 * The defect here was an absence, and it is the reason this file exists: React unmounts the whole
 * tree when a render throws, so before there was a boundary the app's only failure mode for any
 * render error was a blank white window. That is not a cosmetic problem. The Assistant screen's
 * crash and a dev server that was simply not running looked *identical* on screen, and telling them
 * apart took a crash report, a panic log and the live database.
 *
 * The crash arranged below is the realistic shape: the host answers, but answers something the
 * screen cannot use. `History.tsx:111` resolves the session list straight into state with only a
 * `.catch` for a *rejection*, so a `null` resolution puts `null` in `sessions` — and the grouping
 * memo then runs `for (const s of filtered)` over it during render (History.tsx:226), which is the
 * `filtered is not iterable` this reports. That is a bug in the screen, and the point of this spec
 * is that the boundary makes it legible instead of silent.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

/** The dev-only bridge — see `web-test/shim.ts`. `respond` is the sticky sibling of `failNext`. */
type WebTest = { __webTest: { respond: (cmd: string, value: unknown) => void } };

/** A JS-level failure that names the operation, as opposed to a shrug. */
const NAMES_THE_OPERATION = /not iterable|not a function|cannot read/i;

/**
 * Arm a `history_sessions` answer of `null`, then open History. Armed before the screen mounts,
 * because the read happens on mount.
 */
async function crashHistory(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(() => {
    (window as unknown as WebTest).__webTest.respond("history_sessions", null);
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
}

test("a host answer the screen cannot render shows a message instead of a blank window", async ({ page }) => {
  const escaped: string[] = [];
  page.on("pageerror", (e) => escaped.push(`${e.name}: ${e.message}`));

  await crashHistory(page);

  // The whole point: something is on screen, and it is the boundary rather than the crash.
  await expect(page.getByTestId("error-boundary")).toBeVisible();
  const painted = await page.evaluate(() => document.body.innerText.trim().length);
  expect(painted, "a blank window is exactly what this boundary exists to prevent").toBeGreaterThan(80);

  // The error escaped nothing. A boundary that catches and then lets the error reach `window`
  // would still be reporting a failure the user cannot act on.
  expect(escaped).toEqual([]);
});

test("the message names the operation that failed, not a generic apology", async ({ page }) => {
  await crashHistory(page);

  const headline = await page.getByTestId("error-boundary-headline").innerText();

  // Matched as a *shape* rather than as the literal string, because the wording belongs to
  // whichever of the screen's operations touches the poisoned value first — here the grouping memo,
  // but a reorder that hits `filtered.length` first is just as much a real crash. What must hold is
  // that it names a JS operation at all, because that is the fact a white screen withheld.
  expect(headline).toMatch(NAMES_THE_OPERATION);
  expect(headline).not.toMatch(/something went wrong|an error occurred/i);
});

test("the component stack names the screen, which the JS stack alone does not", async ({ page }) => {
  await crashHistory(page);

  // Collapsed by default, so the first thing on screen is the sentence rather than a stack trace.
  await expect(page.getByTestId("error-boundary-details")).not.toHaveAttribute("open", "");
  await page.getByTestId("error-boundary-details").locator("summary").click();

  // React's component stack is the half that answers *where*; the JS stack for a render throw is
  // mostly react-dom frames.
  await expect(page.getByTestId("error-boundary-details")).toContainText("HistoryScreen");
});

test("Reload puts a working app back", async ({ page }) => {
  await crashHistory(page);
  await expect(page.getByTestId("error-boundary")).toBeVisible();

  await page.getByTestId("error-boundary-reload").click();

  // The armed answer is one-shot and was consumed, so the reloaded app reads normally — and the
  // sidebar is the cheapest proof the real shell painted rather than a second failure.
  await expect(page.getByTestId("error-boundary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "History", exact: true })).toBeVisible();
});
